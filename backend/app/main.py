from __future__ import annotations

import asyncio
import base64
import json
import math
import os
import secrets
import sqlite3
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timedelta, timezone
from io import BytesIO
from pathlib import Path
from typing import Any, AsyncIterator, Iterator
from uuid import uuid4

from fastapi.middleware.cors import CORSMiddleware
from fastapi import FastAPI, Header, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from PIL import Image, ImageOps, UnidentifiedImageError
from pydantic import BaseModel, Field

APP_DIR = Path(__file__).resolve().parent
DATABASE_PATH = Path(os.environ.get("PARALLEL_LIVES_DB", APP_DIR / "parallel_lives.db"))
ADMIN_TOKEN = os.environ.get("PARALLEL_LIVES_ADMIN_TOKEN", "dev-admin-token")
DEMO_OTP = os.environ.get("PARALLEL_LIVES_DEMO_OTP", "123456")
PUNE_BOUNDS = (18.4, 18.65, 73.7, 73.98)
DAILY_PROMPTS = (
    "What small thing made today feel a little more like yours?",
    "What song feels like the background music to your week?",
    "What is something ordinary you have been enjoying lately?",
    "If you could keep one moment from today, which would it be?",
    "What is a tiny thing you are looking forward to?",
    "Where do you go when you need a little quiet?",
    "What is something you wish more people noticed?",
    "What would your ideal slow evening look like?",
    "What is a small kindness you still remember?",
    "What would you like to carry with you into tomorrow?",
)
DEMO_PROMPT_ANSWERS = (
    "A quiet cup of chai and a few minutes with no rush.",
    "Probably something soft that makes the walk home feel cinematic.",
    "The light changing in the room around sunset.",
)
SHARE_MORE_DAY = 3
SHARE_MORE_REPLY_HOURS = 24
CONTINUE_WORLD_WINDOW_DAYS = 7
REMATCH_AFTER_HOURS = 24
ROOM_MESSAGE_LIMIT_PER_HOUR = 60
MATCH_QUEUE_TTL_MINUTES = 10
MATCH_USER_ACTIVE_MINUTES = 2


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    initialize_database()
    yield


app = FastAPI(title="Parallel Lives API", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@contextmanager
def database() -> Iterator[sqlite3.Connection]:
    DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DATABASE_PATH, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def initialize_database() -> None:
    with database() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                phone_number TEXT UNIQUE NOT NULL,
                anonymous_handle TEXT NOT NULL DEFAULT '',
                neighborhood_tag TEXT NOT NULL DEFAULT '',
                latitude REAL,
                longitude REAL,
                verification_tier TEXT NOT NULL DEFAULT 'unverified',
                vibe_tags TEXT NOT NULL DEFAULT '[]',
                vibe_score INTEGER NOT NULL DEFAULT 100,
                is_demo INTEGER NOT NULL DEFAULT 0,
                is_banned INTEGER NOT NULL DEFAULT 0,
                is_shadow_banned INTEGER NOT NULL DEFAULT 0,
                is_muted INTEGER NOT NULL DEFAULT 0,
                last_seen_at TEXT,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS match_queue (
                user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                vibe_filters TEXT NOT NULL DEFAULT '[]',
                queued_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS app_settings (
                setting_key TEXT PRIMARY KEY,
                setting_value INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS rooms (
                id TEXT PRIMARY KEY,
                user1_id TEXT NOT NULL REFERENCES users(id),
                user2_id TEXT NOT NULL REFERENCES users(id),
                room_level INTEGER NOT NULL DEFAULT 1,
                shared_state TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'active',
                user1_share_vote INTEGER,
                user2_share_vote INTEGER,
                user1_share_voted_at TEXT,
                user2_share_voted_at TEXT,
                created_at TEXT NOT NULL,
                dissolved_at TEXT
            );
            CREATE UNIQUE INDEX IF NOT EXISTS one_active_room_per_user1
                ON rooms(user1_id) WHERE status = 'active';
            CREATE UNIQUE INDEX IF NOT EXISTS one_active_room_per_user2
                ON rooms(user2_id) WHERE status = 'active';
            CREATE TRIGGER IF NOT EXISTS enforce_one_active_room
            BEFORE INSERT ON rooms
            WHEN NEW.status = 'active' AND EXISTS (
                SELECT 1 FROM rooms existing
                WHERE existing.status = 'active'
                  AND (existing.user1_id IN (NEW.user1_id, NEW.user2_id)
                       OR existing.user2_id IN (NEW.user1_id, NEW.user2_id))
            )
            BEGIN
                SELECT RAISE(ABORT, 'user already has an active room');
            END;
            CREATE TABLE IF NOT EXISTS assets (
                id TEXT PRIMARY KEY,
                room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
                author_id TEXT NOT NULL REFERENCES users(id),
                asset_type TEXT NOT NULL,
                content TEXT,
                media_url TEXT,
                emotion_tag TEXT,
                source_message_id TEXT,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS daily_actions (
                room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
                user_id TEXT NOT NULL REFERENCES users(id),
                action_date TEXT NOT NULL,
                action TEXT NOT NULL,
                PRIMARY KEY (room_id, user_id, action_date, action)
            );
            CREATE TABLE IF NOT EXISTS daily_prompt_answers (
                room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
                user_id TEXT NOT NULL REFERENCES users(id),
                prompt_day INTEGER NOT NULL,
                answer TEXT NOT NULL,
                created_at TEXT NOT NULL,
                PRIMARY KEY (room_id, user_id, prompt_day)
            );
            CREATE TABLE IF NOT EXISTS room_messages (
                id TEXT PRIMARY KEY,
                room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
                author_id TEXT NOT NULL REFERENCES users(id),
                content TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS room_messages_by_room
                ON room_messages(room_id, created_at);
            CREATE TABLE IF NOT EXISTS blocks (
                blocker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                blocked_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                created_at TEXT NOT NULL,
                PRIMARY KEY (blocker_id, blocked_user_id),
                CHECK (blocker_id <> blocked_user_id)
            );
            CREATE TABLE IF NOT EXISTS friendships (
                id TEXT PRIMARY KEY,
                user1_id TEXT NOT NULL REFERENCES users(id),
                user2_id TEXT NOT NULL REFERENCES users(id),
                archived_room_snapshot TEXT NOT NULL,
                created_at TEXT NOT NULL,
                continue_expires_at TEXT,
                user1_continue_vote INTEGER,
                user2_continue_vote INTEGER,
                user1_continue_voted_at TEXT,
                user2_continue_voted_at TEXT,
                UNIQUE(user1_id, user2_id)
            );
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                friendship_id TEXT NOT NULL REFERENCES friendships(id) ON DELETE CASCADE,
                author_id TEXT NOT NULL REFERENCES users(id),
                content TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS reports (
                id TEXT PRIMARY KEY,
                room_id TEXT,
                reporter_id TEXT NOT NULL REFERENCES users(id),
                reported_user_id TEXT NOT NULL REFERENCES users(id),
                reason TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'open',
                created_at TEXT NOT NULL
            );
            """
        )
        columns = {row["name"] for row in db.execute("PRAGMA table_info(users)")}
        if "vibe_tags" not in columns:
            db.execute("ALTER TABLE users ADD COLUMN vibe_tags TEXT NOT NULL DEFAULT '[]'")
        if "is_demo" not in columns:
            db.execute("ALTER TABLE users ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0")
        if "last_seen_at" not in columns:
            db.execute("ALTER TABLE users ADD COLUMN last_seen_at TEXT")
        room_columns = {row["name"] for row in db.execute("PRAGMA table_info(rooms)")}
        if "user1_share_vote" not in room_columns:
            db.execute("ALTER TABLE rooms ADD COLUMN user1_share_vote INTEGER")
        if "user2_share_vote" not in room_columns:
            db.execute("ALTER TABLE rooms ADD COLUMN user2_share_vote INTEGER")
        if "user1_share_voted_at" not in room_columns:
            db.execute("ALTER TABLE rooms ADD COLUMN user1_share_voted_at TEXT")
        if "user2_share_voted_at" not in room_columns:
            db.execute("ALTER TABLE rooms ADD COLUMN user2_share_voted_at TEXT")
        migration_time = now_iso()
        db.execute(
            "UPDATE rooms SET user1_share_voted_at = ? WHERE user1_share_vote = 1 AND user1_share_voted_at IS NULL",
            (migration_time,),
        )
        db.execute(
            "UPDATE rooms SET user2_share_voted_at = ? WHERE user2_share_vote = 1 AND user2_share_voted_at IS NULL",
            (migration_time,),
        )
        friendship_columns = {row["name"] for row in db.execute("PRAGMA table_info(friendships)")}
        for column in (
            "continue_expires_at", "user1_continue_vote", "user2_continue_vote",
            "user1_continue_voted_at", "user2_continue_voted_at",
        ):
            if column not in friendship_columns:
                column_type = "INTEGER" if column.endswith("_vote") else "TEXT"
                db.execute(f"ALTER TABLE friendships ADD COLUMN {column} {column_type}")
        db.execute(
            "UPDATE friendships SET continue_expires_at = ? WHERE continue_expires_at IS NULL",
            ((datetime.fromisoformat(migration_time) + timedelta(days=CONTINUE_WORLD_WINDOW_DAYS)).isoformat(),),
        )
        asset_columns = {row["name"] for row in db.execute("PRAGMA table_info(assets)")}
        if "emotion_tag" not in asset_columns:
            db.execute("ALTER TABLE assets ADD COLUMN emotion_tag TEXT")
        if "source_message_id" not in asset_columns:
            db.execute("ALTER TABLE assets ADD COLUMN source_message_id TEXT")
        db.execute(
            "INSERT OR IGNORE INTO app_settings (setting_key, setting_value) VALUES ('matching_radius_km', 40)"
        )
        db.execute(
            "UPDATE app_settings SET setting_value = 40 WHERE setting_key = 'matching_radius_km' AND setting_value = 5"
        )
        db.execute(
            "INSERT OR IGNORE INTO app_settings (setting_key, setting_value) VALUES ('unmask_day_threshold', 3)"
        )
        db.execute(
            "UPDATE app_settings SET setting_value = 3 WHERE setting_key = 'unmask_day_threshold' AND setting_value = 10"
        )


def get_setting(db: sqlite3.Connection, key: str, default: int) -> int:
    row = db.execute(
        "SELECT setting_value FROM app_settings WHERE setting_key = ?", (key,)
    ).fetchone()
    return int(row["setting_value"]) if row else default


def get_user_id(authorization: str | None) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Sign in to continue")
    token = authorization.removeprefix("Bearer ").strip()
    with database() as db:
        session = db.execute(
            "SELECT user_id FROM sessions WHERE token = ?", (token,)
        ).fetchone()
        if session is None:
            raise HTTPException(status_code=401, detail="Session expired; sign in again")
        user = db.execute(
            "SELECT is_banned FROM users WHERE id = ?", (session["user_id"],)
        ).fetchone()
        if user is None or user["is_banned"]:
            raise HTTPException(status_code=403, detail="This account cannot access the app")
        db.execute("UPDATE users SET last_seen_at = ? WHERE id = ?", (now_iso(), session["user_id"]))
        return str(session["user_id"])


def ensure_user_can_interact(user_id: str) -> None:
    with database() as db:
        user = db.execute("SELECT is_muted FROM users WHERE id = ?", (user_id,)).fetchone()
        if user and user["is_muted"]:
            raise HTTPException(status_code=403, detail="This account is temporarily muted")


def get_room(db: sqlite3.Connection, room_id: str, user_id: str) -> sqlite3.Row:
    room = db.execute(
        "SELECT * FROM rooms WHERE id = ? AND status = 'active' AND (user1_id = ? OR user2_id = ?)",
        (room_id, user_id, user_id),
    ).fetchone()
    if room is None:
        raise HTTPException(status_code=404, detail="Active room not found")
    return room


def active_room_for_user(db: sqlite3.Connection, user_id: str) -> sqlite3.Row | None:
    return db.execute(
        "SELECT * FROM rooms WHERE status = 'active' AND (user1_id = ? OR user2_id = ?) LIMIT 1",
        (user_id, user_id),
    ).fetchone()


def pending_share_expiry(room: sqlite3.Row) -> datetime | None:
    first_vote_at = room["user1_share_voted_at"] if room["user1_share_vote"] == 1 else None
    second_vote_at = room["user2_share_voted_at"] if room["user2_share_vote"] == 1 else None
    pending_since = min((value for value in (first_vote_at, second_vote_at) if value), default=None)
    has_one_yes = (room["user1_share_vote"] == 1) != (room["user2_share_vote"] == 1)
    if has_one_yes and pending_since:
        return datetime.fromisoformat(pending_since) + timedelta(hours=SHARE_MORE_REPLY_HOURS)
    return None


def permanently_delete_room(db: sqlite3.Connection, room_id: str) -> list[Path]:
    media_ids = db.execute(
        "SELECT id FROM assets WHERE room_id = ? AND asset_type = 'polaroid' AND media_url IS NOT NULL",
        (room_id,),
    ).fetchall()
    db.execute("DELETE FROM rooms WHERE id = ?", (room_id,))
    return [DATABASE_PATH.parent / "media" / f"{asset['id']}.jpg" for asset in media_ids]


def remove_room_media_files(paths: list[Path]) -> None:
    for path in paths:
        path.unlink(missing_ok=True)


def distance_between_km(first_lat: float, first_lng: float, second_lat: float, second_lng: float) -> float:
    latitude_delta = math.radians(first_lat - second_lat)
    longitude_delta = math.radians(first_lng - second_lng)
    haversine = math.sin(latitude_delta / 2) ** 2 + math.cos(math.radians(first_lat)) * math.cos(
        math.radians(second_lat)
    ) * math.sin(longitude_delta / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(haversine))


def pair_is_blocked(db: sqlite3.Connection, first_id: str, second_id: str) -> bool:
    return db.execute(
        """SELECT 1 FROM blocks WHERE
           (blocker_id = ? AND blocked_user_id = ?) OR (blocker_id = ? AND blocked_user_id = ?)""",
        (first_id, second_id, second_id, first_id),
    ).fetchone() is not None


def serialize_asset(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "author_id": row["author_id"],
        "asset_type": row["asset_type"],
        "content": row["content"],
        "media_url": row["media_url"],
        "emotion_tag": row["emotion_tag"] if "emotion_tag" in row.keys() else None,
        "source_message_id": row["source_message_id"] if "source_message_id" in row.keys() else None,
        "created_at": row["created_at"],
    }


def connection_capsule_snapshot(db: sqlite3.Connection, room: sqlite3.Row) -> dict[str, Any]:
    assets = db.execute(
        "SELECT * FROM assets WHERE room_id = ? ORDER BY created_at ASC", (room["id"],)
    ).fetchall()
    prompt_days = db.execute(
        """SELECT prompt_day FROM daily_prompt_answers WHERE room_id = ?
           GROUP BY prompt_day HAVING COUNT(DISTINCT user_id) = 2 ORDER BY prompt_day""",
        (room["id"],),
    ).fetchall()
    prompts = []
    for day_row in prompt_days:
        answers = db.execute(
            "SELECT user_id, answer, created_at FROM daily_prompt_answers WHERE room_id = ? AND prompt_day = ? ORDER BY created_at",
            (room["id"], day_row["prompt_day"]),
        ).fetchall()
        prompts.append({"day": day_row["prompt_day"], "answers": [dict(row) for row in answers]})
    return {
        "room_id": room["id"],
        "created_at": room["created_at"],
        "shared_state": json.loads(room["shared_state"]),
        "assets": [serialize_asset(asset) for asset in assets],
        "shared_prompts": prompts,
        "milestones": [
            {"key": "first_conversation", "created_at": room["created_at"]},
            *([{"key": "first_photo", "created_at": next(a["created_at"] for a in assets if a["asset_type"] == "polaroid")}]
              if any(a["asset_type"] == "polaroid" for a in assets) else []),
            *([{"key": "first_note", "created_at": next(a["created_at"] for a in assets if a["asset_type"] == "sticky_note")}]
              if any(a["asset_type"] == "sticky_note" for a in assets) else []),
            *([{"key": "first_shared_ritual", "created_at": prompts[0]["answers"][-1]["created_at"]}]
              if prompts else []),
        ],
    }


def room_day(room: sqlite3.Row) -> int:
    created = datetime.fromisoformat(room["created_at"])
    return max(1, (datetime.now(timezone.utc) - created).days + 1)


def serialize_daily_prompt(db: sqlite3.Connection, room: sqlite3.Row, user_id: str) -> dict[str, Any]:
    day = room_day(room)
    partner_id = room["user2_id"] if room["user1_id"] == user_id else room["user1_id"]
    answers = db.execute(
        """SELECT user_id, answer FROM daily_prompt_answers
           WHERE room_id = ? AND prompt_day = ?""",
        (room["id"], day),
    ).fetchall()
    answer_by_user = {row["user_id"]: row["answer"] for row in answers}
    revealed = user_id in answer_by_user and partner_id in answer_by_user
    return {
        "day": day,
        "question": DAILY_PROMPTS[(day - 1) % len(DAILY_PROMPTS)],
        "my_answer": answer_by_user.get(user_id),
        "partner_answer": answer_by_user.get(partner_id) if revealed else None,
        "revealed": revealed,
    }


def serialize_shared_prompt_history(
    db: sqlite3.Connection, room: sqlite3.Row, user_id: str
) -> list[dict[str, Any]]:
    partner_id = room["user2_id"] if room["user1_id"] == user_id else room["user1_id"]
    days = db.execute(
        """SELECT prompt_day FROM daily_prompt_answers WHERE room_id = ?
           GROUP BY prompt_day HAVING COUNT(DISTINCT user_id) = 2 ORDER BY prompt_day""",
        (room["id"],),
    ).fetchall()
    history = []
    for row in days:
        answers = db.execute(
            "SELECT user_id, answer FROM daily_prompt_answers WHERE room_id = ? AND prompt_day = ?",
            (room["id"], row["prompt_day"]),
        ).fetchall()
        by_user = {answer["user_id"]: answer["answer"] for answer in answers}
        history.append({
            "day": row["prompt_day"],
            "question": DAILY_PROMPTS[(row["prompt_day"] - 1) % len(DAILY_PROMPTS)],
            "my_answer": by_user.get(user_id),
            "partner_answer": by_user.get(partner_id),
        })
    return history


def serialize_room_message(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "author_id": row["author_id"],
        "content": row["content"],
        "created_at": row["created_at"],
    }


def serialize_room(db: sqlite3.Connection, room: sqlite3.Row, user_id: str) -> dict[str, Any]:
    partner_id = room["user2_id"] if room["user1_id"] == user_id else room["user1_id"]
    partner = db.execute(
        """SELECT id, anonymous_handle, neighborhood_tag, verification_tier, is_demo,
              vibe_tags, last_seen_at, created_at
           FROM users WHERE id = ?""",
        (partner_id,),
    ).fetchone()
    days_elapsed = room_day(room)
    unmask_day = get_setting(db, "unmask_day_threshold", 3)
    assets = db.execute(
        "SELECT * FROM assets WHERE room_id = ? ORDER BY created_at ASC", (room["id"],)
    ).fetchall()
    prompt_days = db.execute(
        """SELECT COUNT(*) AS count FROM (
               SELECT prompt_day FROM daily_prompt_answers
               WHERE room_id = ? GROUP BY prompt_day
               HAVING COUNT(DISTINCT user_id) = 2
           )""",
        (room["id"],),
    ).fetchone()["count"]
    growth_stage = min(int(prompt_days), 3)
    share_vote = room["user1_share_vote"] if room["user1_id"] == user_id else room["user2_share_vote"]
    partner_vote = room["user2_share_vote"] if room["user1_id"] == user_id else room["user1_share_vote"]
    my_vote_at = room["user1_share_voted_at"] if room["user1_id"] == user_id else room["user2_share_voted_at"]
    partner_vote_at = room["user2_share_voted_at"] if room["user1_id"] == user_id else room["user1_share_voted_at"]
    shared_more = share_vote == 1 and partner_vote == 1
    partner_last_seen = partner["last_seen_at"] or partner["created_at"] if partner else None
    inactive_hours = 0
    if partner and not partner["is_demo"] and partner_last_seen:
        last_seen = datetime.fromisoformat(partner_last_seen)
        inactive_hours = max(0, int((datetime.now(timezone.utc) - last_seen).total_seconds() // 3600))
    partner_data = dict(partner) if partner else None
    if partner_data:
        partner_data.pop("vibe_tags", None)
        partner_data.pop("last_seen_at", None)
        partner_data.pop("created_at", None)
        if shared_more:
            partner_data["vibe_tags"] = json.loads(partner["vibe_tags"])
    return {
        "room_id": room["id"],
        "created_at": room["created_at"],
        "room_level": room["room_level"],
        "day_streak": min(days_elapsed, unmask_day),
        "days_elapsed": days_elapsed,
        "days_until_unmask": max(0, unmask_day - days_elapsed),
        "unmask_day_threshold": unmask_day,
        "daily_prompt": serialize_daily_prompt(db, room, user_id),
        "shared_prompts": serialize_shared_prompt_history(db, room, user_id),
        "share_more": {
            "available": days_elapsed >= SHARE_MORE_DAY,
            "my_vote": share_vote,
            "mutual": shared_more,
            "response_expires_at": (
                (datetime.fromisoformat(my_vote_at) + timedelta(hours=SHARE_MORE_REPLY_HOURS)).isoformat()
                if share_vote == 1 and partner_vote != 1 and my_vote_at else None
            ),
            "partner_vibe_tags": json.loads(partner["vibe_tags"]) if shared_more and partner else [],
        },
        "plant_growth": {
            "stage": growth_stage,
            "completed_days": min(int(prompt_days), 3),
        },
        "partner_inactive_hours": inactive_hours if partner and not partner["is_demo"] else None,
        "can_rematch": bool(partner and not partner["is_demo"] and inactive_hours >= REMATCH_AFTER_HOURS),
        "shared_state": json.loads(room["shared_state"]),
        "assets": [serialize_asset(asset) for asset in assets],
        "partner": partner_data,
        "demo_companion": bool(partner and partner["is_demo"]),
    }


class PhoneRequest(BaseModel):
    phone: str = Field(min_length=10, max_length=16, pattern=r"^\+[1-9]\d{9,14}$")


class VerifyOtpRequest(PhoneRequest):
    code: str = Field(min_length=4, max_length=8)


class ProfileRequest(BaseModel):
    handle: str = Field(min_length=2, max_length=30, pattern=r"^[a-zA-Z0-9_]+$")
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    neighborhood: str = Field(min_length=2, max_length=80)
    vibes: list[str] = Field(default_factory=list, max_length=8)


class MatchRequest(BaseModel):
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    vibe_filters: list[str] = Field(default_factory=list, max_length=8)


class AssetRequest(BaseModel):
    asset_type: str = Field(pattern=r"^(sticky_note|chat_memory)$")
    content: str | None = Field(default=None, max_length=140)
    emotion_tag: str | None = Field(default=None, pattern=r"^(happy|funny|deep|comforting|random)$")
    message_id: str | None = None


class DailyPromptRequest(BaseModel):
    day: int = Field(ge=1)
    answer: str = Field(min_length=1, max_length=240)


class ShareMoreRequest(BaseModel):
    accept: bool


class ContinueWorldRequest(BaseModel):
    pass


class CircleReportRequest(BaseModel):
    reason: str = Field(min_length=3, max_length=500)


class RoomMessageRequest(BaseModel):
    content: str = Field(min_length=1, max_length=1000)


class PolaroidUploadRequest(BaseModel):
    image_base64: str = Field(min_length=100, max_length=3_000_000)
    content_type: str = Field(pattern=r"^image/(jpeg|png|webp)$")
    emotion_tag: str | None = Field(default=None, pattern=r"^(happy|funny|deep|comforting|random)$")


class MessageRequest(BaseModel):
    content: str = Field(min_length=1, max_length=2000)


class ReportRequest(BaseModel):
    reason: str = Field(min_length=3, max_length=500)


class ModerationAction(BaseModel):
    action: str = Field(pattern=r"^(review|soft_mute|shadow_ban|hard_ban|dismiss)$")


class AdminSettingsRequest(BaseModel):
    matching_radius_km: int = Field(ge=1, le=40)
    unmask_day_threshold: int = Field(ge=1, le=30)


class VibeScoreRequest(BaseModel):
    vibe_score: int = Field(ge=0, le=100)


class AdminUserAction(BaseModel):
    action: str = Field(pattern=r"^(soft_mute|shadow_ban|hard_ban|restore)$")


def room_payload(room_id: str, event: str, payload: dict[str, Any]) -> dict[str, Any]:
    return {"room_id": room_id, "event": event, "payload": payload}


class RoomConnectionManager:
    def __init__(self) -> None:
        self.connections: dict[str, set[WebSocket]] = {}
        self.lock = asyncio.Lock()

    async def connect(self, room_id: str, websocket: WebSocket) -> None:
        await websocket.accept()
        async with self.lock:
            self.connections.setdefault(room_id, set()).add(websocket)

    async def disconnect(self, room_id: str, websocket: WebSocket) -> None:
        async with self.lock:
            self.connections.get(room_id, set()).discard(websocket)

    async def broadcast(self, room_id: str, payload: dict[str, Any]) -> None:
        async with self.lock:
            targets = list(self.connections.get(room_id, set()))
        disconnected: list[WebSocket] = []
        for websocket in targets:
            try:
                await websocket.send_json(payload)
            except WebSocketDisconnect:
                disconnected.append(websocket)
        for websocket in disconnected:
            await self.disconnect(room_id, websocket)


manager = RoomConnectionManager()


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "parallel-lives-api"}


@app.post("/api/v1/auth/request-otp")
def request_otp(payload: PhoneRequest) -> dict[str, str]:
    return {
        "status": "sent",
        "message": "Development OTP issued. Use the demo code shown in the app.",
        "demo_code": DEMO_OTP,
    }


@app.post("/api/v1/auth/verify-otp")
def verify_otp(payload: VerifyOtpRequest) -> dict[str, Any]:
    if not secrets.compare_digest(payload.code, DEMO_OTP):
        raise HTTPException(status_code=400, detail="Incorrect verification code")
    with database() as db:
        db.execute("BEGIN IMMEDIATE")
        user = db.execute("SELECT * FROM users WHERE phone_number = ?", (payload.phone,)).fetchone()
        if user is None:
            user_id = str(uuid4())
            db.execute(
                "INSERT INTO users (id, phone_number, created_at) VALUES (?, ?, ?)",
                (user_id, payload.phone, now_iso()),
            )
            user = db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        if user["is_banned"]:
            raise HTTPException(status_code=403, detail="This account cannot access the app")
        token = secrets.token_urlsafe(32)
        db.execute(
            "INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)",
            (token, user["id"], now_iso()),
        )
        return {"token": token, "user": dict(user)}


@app.post("/api/v1/auth/logout")
def logout(authorization: str | None = Header(default=None)) -> dict[str, str]:
    user_id = get_user_id(authorization)
    token = (authorization or "").removeprefix("Bearer ").strip()
    with database() as db:
        db.execute("DELETE FROM sessions WHERE token = ? AND user_id = ?", (token, user_id))
    return {"status": "signed_out"}


@app.get("/api/v1/me")
def get_me(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    user_id = get_user_id(authorization)
    with database() as db:
        user = db.execute(
            """SELECT id, phone_number, anonymous_handle, neighborhood_tag, latitude, longitude,
                      verification_tier, vibe_score, created_at
               FROM users WHERE id = ?""",
            (user_id,),
        ).fetchone()
        room = active_room_for_user(db, user_id)
        return {"user": dict(user), "profile_complete": bool(user["anonymous_handle"]), "has_active_room": room is not None}


@app.post("/api/v1/profile")
def save_profile(payload: ProfileRequest, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    user_id = get_user_id(authorization)
    min_lat, max_lat, min_lng, max_lng = PUNE_BOUNDS
    if not (min_lat <= payload.latitude <= max_lat and min_lng <= payload.longitude <= max_lng):
        raise HTTPException(status_code=403, detail="Parallel Lives is currently available in Pune and PCMC only")
    with database() as db:
        db.execute(
            """UPDATE users SET anonymous_handle = ?, neighborhood_tag = ?, latitude = ?, longitude = ?,
                                vibe_tags = ?
               WHERE id = ?""",
            (
                payload.handle,
                payload.neighborhood,
                payload.latitude,
                payload.longitude,
                json.dumps(payload.vibes),
                user_id,
            ),
        )
        user = db.execute(
            "SELECT id, anonymous_handle, neighborhood_tag, latitude, longitude, verification_tier "
            "FROM users WHERE id = ?",
            (user_id,),
        ).fetchone()
    return {"user": dict(user), "status": "profile_saved"}


@app.post("/api/v1/auth/liveness-check")
def liveness_check() -> None:
    raise HTTPException(
        status_code=501,
        detail="Liveness verification requires a configured identity verification provider; no selfie is verified in this demo.",
    )


@app.post("/api/v1/match/find-companion")
async def find_companion(
    payload: MatchRequest, authorization: str | None = Header(default=None)
) -> dict[str, Any]:
    user_id = get_user_id(authorization)
    min_lat, max_lat, min_lng, max_lng = PUNE_BOUNDS
    if not (min_lat <= payload.latitude <= max_lat and min_lng <= payload.longitude <= max_lng):
        raise HTTPException(status_code=403, detail="User is outside the Pune geo-fence")
    with database() as db:
        db.execute("BEGIN IMMEDIATE")
        now_value = now_iso()
        db.execute(
            "UPDATE users SET latitude = ?, longitude = ?, last_seen_at = ? WHERE id = ?",
            (payload.latitude, payload.longitude, now_value, user_id),
        )
        user = db.execute(
            "SELECT anonymous_handle, latitude, longitude, vibe_tags, last_seen_at FROM users WHERE id = ?",
            (user_id,),
        ).fetchone()
        if not user or not user["anonymous_handle"] or user["latitude"] is None or user["longitude"] is None:
            raise HTTPException(status_code=409, detail="Complete your anonymous profile before matching")
        room = active_room_for_user(db, user_id)
        if room is not None:
            db.execute("DELETE FROM match_queue WHERE user_id = ?", (user_id,))
            return serialize_room(db, room, user_id)
        matching_radius = get_setting(db, "matching_radius_km", 40)
        current_vibes = set(payload.vibe_filters or json.loads(user["vibe_tags"]))
        now = datetime.now(timezone.utc)
        queue_cutoff = (now - timedelta(minutes=MATCH_QUEUE_TTL_MINUTES)).isoformat()
        active_cutoff = (now - timedelta(minutes=MATCH_USER_ACTIVE_MINUTES)).isoformat()
        db.execute("DELETE FROM match_queue WHERE queued_at < ?", (queue_cutoff,))
        db.execute(
            """DELETE FROM match_queue WHERE user_id IN (
                   SELECT id FROM users WHERE last_seen_at IS NULL OR last_seen_at < ?
               )""",
            (active_cutoff,),
        )
        db.execute(
            """INSERT INTO match_queue (user_id, vibe_filters, queued_at) VALUES (?, ?, ?)
               ON CONFLICT(user_id) DO UPDATE SET vibe_filters = excluded.vibe_filters""",
            (user_id, json.dumps(sorted(current_vibes)), now_value),
        )
        candidates = db.execute(
            """SELECT q.user_id, q.vibe_filters AS queued_vibes, q.queued_at,
                      u.latitude, u.longitude, u.vibe_tags
               FROM match_queue q JOIN users u ON u.id = q.user_id
               WHERE q.user_id != ? AND u.is_demo = 0
                 AND NOT EXISTS (
                     SELECT 1 FROM rooms r WHERE r.status = 'active'
                       AND (r.user1_id = q.user_id OR r.user2_id = q.user_id)
                 )
                 AND NOT EXISTS (
                     SELECT 1 FROM friendships f WHERE
                       (f.user1_id = ? AND f.user2_id = q.user_id)
                       OR (f.user1_id = q.user_id AND f.user2_id = ?)
                 )
                 AND NOT EXISTS (
                     SELECT 1 FROM blocks b WHERE
                       (b.blocker_id = ? AND b.blocked_user_id = q.user_id)
                       OR (b.blocker_id = q.user_id AND b.blocked_user_id = ?)
                 )""",
            (user_id, user_id, user_id, user_id, user_id),
        ).fetchall()
        ranked_candidates: list[tuple[int, float, str, sqlite3.Row, list[str]]] = []
        for candidate in candidates:
            latitude_delta = math.radians(user["latitude"] - candidate["latitude"])
            longitude_delta = math.radians(user["longitude"] - candidate["longitude"])
            haversine = math.sin(latitude_delta / 2) ** 2 + math.cos(math.radians(user["latitude"])) * math.cos(
                math.radians(candidate["latitude"])
            ) * math.sin(longitude_delta / 2) ** 2
            distance_km = 6371 * 2 * math.asin(math.sqrt(haversine))
            if distance_km > matching_radius:
                continue
            candidate_vibes = set(json.loads(candidate["queued_vibes"]) or json.loads(candidate["vibe_tags"]))
            shared_vibes = sorted(current_vibes.intersection(candidate_vibes))
            ranked_candidates.append((-len(shared_vibes), distance_km, candidate["queued_at"], candidate, shared_vibes))
        if not ranked_candidates:
            queue_entry = db.execute(
                "SELECT queued_at FROM match_queue WHERE user_id = ?", (user_id,)
            ).fetchone()
            return {"status": "waiting", "queued_at": queue_entry["queued_at"]}
        _, distance_km, _, candidate, shared_vibes = min(ranked_candidates, key=lambda item: item[:3])
        partner_id = candidate["user_id"]
        room_id = str(uuid4())
        db.execute(
            "INSERT INTO rooms (id, user1_id, user2_id, shared_state, created_at) VALUES (?, ?, ?, ?, ?)",
            (
                room_id,
                partner_id,
                user_id,
                json.dumps({"plant_health": 100, "theme": "sunset"}),
                now_iso(),
            ),
        )
        db.execute("DELETE FROM match_queue WHERE user_id IN (?, ?)", (user_id, partner_id))
        room = db.execute("SELECT * FROM rooms WHERE id = ?", (room_id,)).fetchone()
        result = serialize_room(db, room, user_id)
        result["match"] = {
            "distance_km": round(distance_km, 1),
            "vibe_match": shared_vibes,
            "demo_companion": False,
        }
        result["match_status"] = "matched"
    await manager.broadcast(room_id, room_payload(room_id, "state_sync", {"kind": "room_created"}))
    return result


@app.get("/api/v1/match/status")
def get_match_status(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    user_id = get_user_id(authorization)
    with database() as db:
        db.execute("BEGIN IMMEDIATE")
        room = active_room_for_user(db, user_id)
        if room is not None:
            db.execute("DELETE FROM match_queue WHERE user_id = ?", (user_id,))
            return {"status": "matched", "room": serialize_room(db, room, user_id)}
        queued = db.execute(
            "SELECT queued_at FROM match_queue WHERE user_id = ?", (user_id,)
        ).fetchone()
        if queued is None:
            return {"status": "idle"}
        now = datetime.now(timezone.utc)
        queue_age = now - datetime.fromisoformat(queued["queued_at"])
        user = db.execute("SELECT last_seen_at FROM users WHERE id = ?", (user_id,)).fetchone()
        last_seen = datetime.fromisoformat(user["last_seen_at"]) if user and user["last_seen_at"] else None
        if queue_age > timedelta(minutes=MATCH_QUEUE_TTL_MINUTES) or last_seen is None or now - last_seen > timedelta(minutes=MATCH_USER_ACTIVE_MINUTES):
            db.execute("DELETE FROM match_queue WHERE user_id = ?", (user_id,))
            return {"status": "idle"}
        return {"status": "waiting", "queued_at": queued["queued_at"]}


@app.delete("/api/v1/match/queue")
def cancel_match_search(authorization: str | None = Header(default=None)) -> dict[str, str]:
    user_id = get_user_id(authorization)
    with database() as db:
        db.execute("BEGIN IMMEDIATE")
        room = active_room_for_user(db, user_id)
        if room is not None:
            return {"status": "matched"}
        db.execute("DELETE FROM match_queue WHERE user_id = ?", (user_id,))
    return {"status": "cancelled"}


@app.get("/api/v1/room/active")
def get_active_room(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    user_id = get_user_id(authorization)
    expired_media: list[Path] = []
    expired = False
    with database() as db:
        db.execute("BEGIN IMMEDIATE")
        room = active_room_for_user(db, user_id)
        expires_at = pending_share_expiry(room) if room else None
        if room and expires_at and datetime.now(timezone.utc) >= expires_at:
            expired_media = permanently_delete_room(db, room["id"])
            expired = True
            room = None
        result = serialize_room(db, room, user_id) if room else None
    remove_room_media_files(expired_media)
    if expired or result is None:
        raise HTTPException(status_code=404, detail="You do not have an active room")
    return result


@app.get("/api/v1/room/messages")
def get_room_messages(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    user_id = get_user_id(authorization)
    with database() as db:
        room = active_room_for_user(db, user_id)
        if room is None:
            raise HTTPException(status_code=404, detail="You do not have an active room")
        rows = db.execute(
            "SELECT * FROM room_messages WHERE room_id = ? ORDER BY created_at DESC LIMIT 100",
            (room["id"],),
        ).fetchall()
        return {"messages": [serialize_room_message(row) for row in reversed(rows)]}


@app.post("/api/v1/room/messages")
async def create_room_message(
    payload: RoomMessageRequest,
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    user_id = get_user_id(authorization)
    ensure_user_can_interact(user_id)
    content = payload.content.strip()
    if not content:
        raise HTTPException(status_code=422, detail="Write a message before sending")
    with database() as db:
        db.execute("BEGIN IMMEDIATE")
        room = active_room_for_user(db, user_id)
        if room is None:
            raise HTTPException(status_code=404, detail="You do not have an active room")
        recent_count = db.execute(
            """SELECT COUNT(*) AS count FROM room_messages
               WHERE room_id = ? AND author_id = ? AND created_at >= ?""",
            (room["id"], user_id, (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()),
        ).fetchone()["count"]
        if recent_count >= ROOM_MESSAGE_LIMIT_PER_HOUR:
            raise HTTPException(status_code=429, detail="You have sent a lot of messages. Try again in a little while.")
        message_id = str(uuid4())
        created_at = now_iso()
        db.execute(
            "INSERT INTO room_messages (id, room_id, author_id, content, created_at) VALUES (?, ?, ?, ?, ?)",
            (message_id, room["id"], user_id, content, created_at),
        )
        message_row = db.execute("SELECT * FROM room_messages WHERE id = ?", (message_id,)).fetchone()
        message = serialize_room_message(message_row)
    await manager.broadcast(room["id"], room_payload(room["id"], "room_message", message))
    return {"message": message}


@app.post("/api/v1/room/share-more")
async def share_more(
    payload: ShareMoreRequest,
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    user_id = get_user_id(authorization)
    ensure_user_can_interact(user_id)
    media_paths: list[Path] = []
    with database() as db:
        db.execute("BEGIN IMMEDIATE")
        room = active_room_for_user(db, user_id)
        if room is None:
            raise HTTPException(status_code=404, detail="You do not have an active room")
        if room_day(room) < SHARE_MORE_DAY:
            raise HTTPException(status_code=409, detail="Sharing more opens on day 3")
        if not payload.accept:
            room_id = room["id"]
            media_paths = permanently_delete_room(db, room_id)
            result = {"status": "dissolved", "room_id": room_id}
        else:
            column = "user1_share_vote" if room["user1_id"] == user_id else "user2_share_vote"
            voted_at_column = "user1_share_voted_at" if room["user1_id"] == user_id else "user2_share_voted_at"
            db.execute(f"UPDATE rooms SET {column} = 1, {voted_at_column} = ? WHERE id = ?", (now_iso(), room["id"]))
            partner_id = room["user2_id"] if room["user1_id"] == user_id else room["user1_id"]
            partner = db.execute("SELECT is_demo FROM users WHERE id = ?", (partner_id,)).fetchone()
            if partner and partner["is_demo"]:
                other_column = "user2_share_vote" if room["user1_id"] == user_id else "user1_share_vote"
                other_voted_at_column = "user2_share_voted_at" if room["user1_id"] == user_id else "user1_share_voted_at"
                db.execute(f"UPDATE rooms SET {other_column} = 1, {other_voted_at_column} = ? WHERE id = ?", (now_iso(), room["id"]))
            updated = db.execute("SELECT * FROM rooms WHERE id = ?", (room["id"],)).fetchone()
            result = {"share_more": serialize_room(db, updated, user_id)["share_more"]}
            if updated["user1_share_vote"] == 1 and updated["user2_share_vote"] == 1:
                friendship_id = str(uuid4())
                graduated_at = now_iso()
                continue_expires_at = (datetime.fromisoformat(graduated_at) + timedelta(days=CONTINUE_WORLD_WINDOW_DAYS)).isoformat()
                db.execute(
                    """INSERT OR IGNORE INTO friendships
                       (id, user1_id, user2_id, archived_room_snapshot, created_at, continue_expires_at)
                       VALUES (?, ?, ?, ?, ?, ?)""",
                    (
                        friendship_id,
                        room["user1_id"],
                        room["user2_id"],
                        json.dumps(connection_capsule_snapshot(db, room)),
                        graduated_at,
                        continue_expires_at,
                    ),
                )
                friendship = db.execute(
                    """SELECT id FROM friendships
                       WHERE (user1_id = ? AND user2_id = ?) OR (user1_id = ? AND user2_id = ?)""",
                    (room["user1_id"], room["user2_id"], room["user2_id"], room["user1_id"]),
                ).fetchone()
                if friendship:
                    db.execute(
                        """UPDATE friendships SET archived_room_snapshot = ?, created_at = ?,
                           continue_expires_at = ?, user1_continue_vote = NULL,
                           user2_continue_vote = NULL, user1_continue_voted_at = NULL,
                           user2_continue_voted_at = NULL WHERE id = ?""",
                        (json.dumps(connection_capsule_snapshot(db, room)), graduated_at, continue_expires_at, friendship["id"]),
                    )
                    db.execute(
                        """INSERT OR IGNORE INTO messages (id, friendship_id, author_id, content, created_at)
                           SELECT id, ?, author_id, content, created_at FROM room_messages WHERE room_id = ?""",
                        (friendship["id"], room["id"]),
                    )
                db.execute("UPDATE rooms SET status = 'graduated' WHERE id = ?", (room["id"],))
                result.update({"status": "graduated", "friendship_id": friendship["id"] if friendship else None})
            else:
                result["status"] = "waiting_for_partner"
    if result["status"] == "dissolved":
        remove_room_media_files(media_paths)
        await manager.broadcast(result["room_id"], room_payload(result["room_id"], "room_dissolved", {"declined": True}))
    else:
        event = "unmask_updated" if result["status"] == "graduated" else "share_more_updated"
        await manager.broadcast(room["id"], room_payload(room["id"], event, result))
    return result


@app.post("/api/v1/room/daily-prompt")
async def answer_daily_prompt(
    payload: DailyPromptRequest,
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    user_id = get_user_id(authorization)
    ensure_user_can_interact(user_id)
    if not payload.answer.strip():
        raise HTTPException(status_code=422, detail="Write a short answer before sharing")
    with database() as db:
        db.execute("BEGIN IMMEDIATE")
        room = active_room_for_user(db, user_id)
        if room is None:
            raise HTTPException(status_code=404, detail="You do not have an active room")
        day = room_day(room)
        if payload.day != day:
            raise HTTPException(status_code=409, detail="Today’s prompt changed; refresh your room")
        existing = db.execute(
            """SELECT 1 FROM daily_prompt_answers
               WHERE room_id = ? AND user_id = ? AND prompt_day = ?""",
            (room["id"], user_id, day),
        ).fetchone()
        if existing:
            raise HTTPException(status_code=409, detail="You have already answered today’s prompt")
        db.execute(
            """INSERT INTO daily_prompt_answers
               (room_id, user_id, prompt_day, answer, created_at) VALUES (?, ?, ?, ?, ?)""",
            (room["id"], user_id, day, payload.answer.strip(), now_iso()),
        )
        partner_id = room["user2_id"] if room["user1_id"] == user_id else room["user1_id"]
        partner = db.execute("SELECT is_demo FROM users WHERE id = ?", (partner_id,)).fetchone()
        if partner and partner["is_demo"]:
            db.execute(
                """INSERT OR IGNORE INTO daily_prompt_answers
                   (room_id, user_id, prompt_day, answer, created_at) VALUES (?, ?, ?, ?, ?)""",
                (
                    room["id"],
                    partner_id,
                    day,
                    DEMO_PROMPT_ANSWERS[(day - 1) % len(DEMO_PROMPT_ANSWERS)],
                    now_iso(),
                ),
            )
        result = serialize_daily_prompt(db, room, user_id)
    await manager.broadcast(room["id"], room_payload(room["id"], "daily_prompt_updated", {}))
    return {"daily_prompt": result}


@app.post("/api/v1/room/asset")
async def create_room_asset(
    payload: AssetRequest,
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    user_id = get_user_id(authorization)
    ensure_user_can_interact(user_id)
    with database() as db:
        room = active_room_for_user(db, user_id)
        if room is None:
            raise HTTPException(status_code=404, detail="You do not have an active room")
        content = (payload.content or "").strip()
        if payload.asset_type == "chat_memory":
            if not payload.message_id:
                raise HTTPException(status_code=422, detail="Choose a chat message to save")
            source_message = db.execute(
                "SELECT content FROM room_messages WHERE id = ? AND room_id = ?",
                (payload.message_id, room["id"]),
            ).fetchone()
            if source_message is None:
                raise HTTPException(status_code=404, detail="Chat message not found in this room")
            content = source_message["content"]
        elif not content:
            raise HTTPException(status_code=422, detail="Sticky notes need text")
        asset_id = str(uuid4())
        db.execute(
            """INSERT INTO assets (id, room_id, author_id, asset_type, content, media_url, emotion_tag, source_message_id, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (asset_id, room["id"], user_id, payload.asset_type, content, None, payload.emotion_tag, payload.message_id, now_iso()),
        )
        asset = db.execute("SELECT * FROM assets WHERE id = ?", (asset_id,)).fetchone()
    await manager.broadcast(room["id"], room_payload(room["id"], "state_sync", {"asset": serialize_asset(asset)}))
    return {"asset": serialize_asset(asset)}


@app.post("/api/v1/room/polaroid")
async def upload_polaroid(
    payload: PolaroidUploadRequest,
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    user_id = get_user_id(authorization)
    ensure_user_can_interact(user_id)
    try:
        raw = base64.b64decode(payload.image_base64, validate=True)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="Photo data is not valid base64") from exc
    if len(raw) > 2_000_000:
        raise HTTPException(status_code=413, detail="Photo must be 2 MB or smaller")
    try:
        with Image.open(BytesIO(raw)) as image:
            expected_format = {"image/jpeg": "JPEG", "image/png": "PNG", "image/webp": "WEBP"}[
                payload.content_type
            ]
            if image.format != expected_format:
                raise HTTPException(status_code=422, detail="Photo type does not match its content")
            if image.width * image.height > 20_000_000:
                raise HTTPException(status_code=413, detail="Photo dimensions are too large")
            image.load()
            clean_image = ImageOps.exif_transpose(image).convert("RGB")
            clean_image.thumbnail((1600, 1600))
            output = BytesIO()
            clean_image.save(output, format="JPEG", quality=86, optimize=True)
            image_bytes = output.getvalue()
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise HTTPException(status_code=422, detail="Photo could not be decoded") from exc

    asset_id = str(uuid4())
    media_directory = DATABASE_PATH.parent / "media"
    media_directory.mkdir(parents=True, exist_ok=True)
    media_path = media_directory / f"{asset_id}.jpg"
    with database() as db:
        db.execute("BEGIN IMMEDIATE")
        room = active_room_for_user(db, user_id)
        if room is None:
            raise HTTPException(status_code=404, detail="You do not have an active room")
        uploaded_recently = db.execute(
            """SELECT 1 FROM assets WHERE room_id = ? AND author_id = ? AND asset_type = 'polaroid'
               AND julianday(created_at) >= julianday('now', '-24 hours')""",
            (room["id"], user_id),
        ).fetchone()
        if uploaded_recently:
            raise HTTPException(status_code=429, detail="You can add one polaroid every 24 hours")
        media_path.write_bytes(image_bytes)
        media_url = f"/api/v1/media/{asset_id}"
        try:
            db.execute(
                """INSERT INTO assets (id, room_id, author_id, asset_type, media_url, emotion_tag, created_at)
                   VALUES (?, ?, ?, 'polaroid', ?, ?, ?)""",
                (asset_id, room["id"], user_id, media_url, payload.emotion_tag, now_iso()),
            )
        except sqlite3.Error:
            media_path.unlink(missing_ok=True)
            raise
        asset = db.execute("SELECT * FROM assets WHERE id = ?", (asset_id,)).fetchone()
    result = serialize_asset(asset)
    await manager.broadcast(room["id"], room_payload(room["id"], "state_sync", {"asset": result}))
    return {"asset": result}


@app.get("/api/v1/media/{asset_id}")
def get_polaroid(
    asset_id: str,
    authorization: str | None = Header(default=None),
) -> FileResponse:
    user_id = get_user_id(authorization)
    with database() as db:
        asset = db.execute(
            """SELECT a.media_url FROM assets a JOIN rooms r ON r.id = a.room_id
               WHERE a.id = ? AND a.asset_type = 'polaroid'
                 AND (r.user1_id = ? OR r.user2_id = ?)
                 AND (r.status = 'active' OR EXISTS (
                   SELECT 1 FROM friendships f WHERE
                     ((f.user1_id = r.user1_id AND f.user2_id = r.user2_id)
                       OR (f.user1_id = r.user2_id AND f.user2_id = r.user1_id))
                     AND (f.user1_id = ? OR f.user2_id = ?)
                 ))""",
            (asset_id, user_id, user_id, user_id, user_id),
        ).fetchone()
        if asset is None:
            raise HTTPException(status_code=404, detail="Photo not found")
        image_path = DATABASE_PATH.parent / "media" / f"{asset_id}.jpg"
        if asset["media_url"] != f"/api/v1/media/{asset_id}" or not image_path.is_file():
            raise HTTPException(status_code=404, detail="Photo file not found")
    return FileResponse(image_path, media_type="image/jpeg")


@app.post("/api/v1/room/water-plant")
async def water_plant(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    user_id = get_user_id(authorization)
    with database() as db:
        db.execute("BEGIN IMMEDIATE")
        room = active_room_for_user(db, user_id)
        if room is None:
            raise HTTPException(status_code=404, detail="You do not have an active room")
        try:
            db.execute(
                "INSERT INTO daily_actions (room_id, user_id, action_date, action) VALUES (?, ?, date('now'), 'water_plant')",
                (room["id"], user_id),
            )
        except sqlite3.IntegrityError as exc:
            raise HTTPException(status_code=409, detail="You already watered the plant today") from exc
        state = json.loads(room["shared_state"])
        state["plant_health"] = min(100, int(state.get("plant_health", 0)) + 5)
        db.execute("UPDATE rooms SET shared_state = ? WHERE id = ?", (json.dumps(state), room["id"]))
    await manager.broadcast(room["id"], room_payload(room["id"], "state_sync", state))
    return {"shared_state": state}


@app.post("/api/v1/room/dissolve")
async def dissolve_room(authorization: str | None = Header(default=None)) -> dict[str, str]:
    user_id = get_user_id(authorization)
    media_paths: list[Path] = []
    with database() as db:
        db.execute("BEGIN IMMEDIATE")
        room = active_room_for_user(db, user_id)
        if room is None:
            raise HTTPException(status_code=404, detail="You do not have an active room")
        media_paths = permanently_delete_room(db, room["id"])
    remove_room_media_files(media_paths)
    await manager.broadcast(room["id"], room_payload(room["id"], "room_dissolved", {}))
    return {"status": "dissolved", "room_id": room["id"]}


@app.post("/api/v1/room/block")
async def block_room_partner(authorization: str | None = Header(default=None)) -> dict[str, str]:
    user_id = get_user_id(authorization)
    media_paths: list[Path] = []
    with database() as db:
        db.execute("BEGIN IMMEDIATE")
        room = active_room_for_user(db, user_id)
        if room is None:
            raise HTTPException(status_code=404, detail="You do not have an active room")
        partner_id = room["user2_id"] if room["user1_id"] == user_id else room["user1_id"]
        db.execute(
            "INSERT OR IGNORE INTO blocks (blocker_id, blocked_user_id, created_at) VALUES (?, ?, ?)",
            (user_id, partner_id, now_iso()),
        )
        media_paths = permanently_delete_room(db, room["id"])
    remove_room_media_files(media_paths)
    await manager.broadcast(room["id"], room_payload(room["id"], "room_dissolved", {"blocked": True}))
    return {"status": "blocked", "room_id": room["id"]}


@app.get("/api/v1/circles")
def get_circles(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    user_id = get_user_id(authorization)
    with database() as db:
        db.execute("BEGIN IMMEDIATE")
        friendships = db.execute(
            """SELECT f.id AS friendship_id, f.user1_id, f.user2_id, f.created_at,
                      f.continue_expires_at, f.user1_continue_vote, f.user2_continue_vote,
                      f.user1_continue_voted_at, f.user2_continue_voted_at,
                      u.id AS partner_id, u.anonymous_handle, u.neighborhood_tag, u.verification_tier
               FROM friendships f JOIN users u ON u.id =
                 CASE WHEN f.user1_id = ? THEN f.user2_id ELSE f.user1_id END
               WHERE f.user1_id = ? OR f.user2_id = ? ORDER BY f.created_at DESC""",
            (user_id, user_id, user_id),
        ).fetchall()
        results = []
        now = datetime.now(timezone.utc)
        for row in friendships:
            first_user = row["user1_id"] == user_id
            my_vote = row["user1_continue_vote"] if first_user else row["user2_continue_vote"]
            partner_vote = row["user2_continue_vote"] if first_user else row["user1_continue_vote"]
            my_voted_at = row["user1_continue_voted_at"] if first_user else row["user2_continue_voted_at"]
            partner_voted_at = row["user2_continue_voted_at"] if first_user else row["user1_continue_voted_at"]
            response_expires_at = None
            if (my_vote == 1) != (partner_vote == 1):
                pending_since = my_voted_at if my_vote == 1 else partner_voted_at
                if pending_since:
                    response_expires_at = (datetime.fromisoformat(pending_since) + timedelta(hours=SHARE_MORE_REPLY_HOURS)).isoformat()
                    if now >= datetime.fromisoformat(response_expires_at):
                        db.execute(
                            """UPDATE friendships SET user1_continue_vote = NULL, user2_continue_vote = NULL,
                               user1_continue_voted_at = NULL, user2_continue_voted_at = NULL WHERE id = ?""",
                            (row["friendship_id"],),
                        )
                        my_vote = partner_vote = None
                        response_expires_at = None
            active = db.execute(
                """SELECT 1 FROM rooms WHERE status = 'active' AND
                   ((user1_id = ? AND user2_id = ?) OR (user1_id = ? AND user2_id = ?))""",
                (row["user1_id"], row["user2_id"], row["user2_id"], row["user1_id"]),
            ).fetchone() is not None
            active_conflict = db.execute(
                """SELECT 1 FROM rooms WHERE status = 'active' AND
                   (user1_id IN (?, ?) OR user2_id IN (?, ?)) LIMIT 1""",
                (row["user1_id"], row["user2_id"], row["user1_id"], row["user2_id"]),
            ).fetchone() is not None
            window_open = bool(row["continue_expires_at"] and now < datetime.fromisoformat(row["continue_expires_at"]))
            results.append({
                "friendship_id": row["friendship_id"],
                "partner_id": row["partner_id"],
                "anonymous_handle": row["anonymous_handle"],
                "neighborhood_tag": row["neighborhood_tag"],
                "verification_tier": row["verification_tier"],
                "created_at": row["created_at"],
                "continue_expires_at": row["continue_expires_at"],
                "continue_available": window_open and not active and not active_conflict,
                "continue_blocked": active_conflict and not active,
                "my_continue_vote": my_vote,
                "partner_continue_vote": partner_vote,
                "continue_response_expires_at": response_expires_at,
                "world_active": active,
            })
        return {"friendships": results}


def delete_circle_connection(
    db: sqlite3.Connection,
    friendship: sqlite3.Row,
    user_id: str,
    action: str,
    reason: str | None = None,
) -> tuple[list[str], list[Path]]:
    partner_id = friendship["user2_id"] if friendship["user1_id"] == user_id else friendship["user1_id"]
    rooms = db.execute(
        """SELECT id FROM rooms WHERE (user1_id = ? AND user2_id = ?)
           OR (user1_id = ? AND user2_id = ?)""",
        (user_id, partner_id, partner_id, user_id),
    ).fetchall()
    room_ids = [row["id"] for row in rooms]
    media_paths: list[Path] = []
    for room_id in room_ids:
        media = db.execute(
            "SELECT id FROM assets WHERE room_id = ? AND asset_type = 'polaroid' AND media_url IS NOT NULL",
            (room_id,),
        ).fetchall()
        media_paths.extend(DATABASE_PATH.parent / "media" / f"{asset['id']}.jpg" for asset in media)
    if action == "report":
        db.execute(
            """INSERT INTO reports (id, room_id, reporter_id, reported_user_id, reason, created_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (str(uuid4()), room_ids[-1] if room_ids else None, user_id, partner_id, (reason or "").strip(), now_iso()),
        )
    if action in {"block", "report"}:
        db.execute(
            "INSERT OR IGNORE INTO blocks (blocker_id, blocked_user_id, created_at) VALUES (?, ?, ?)",
            (user_id, partner_id, now_iso()),
        )
    for room_id in room_ids:
        db.execute("DELETE FROM rooms WHERE id = ?", (room_id,))
    db.execute("DELETE FROM friendships WHERE id = ?", (friendship["id"],))
    return room_ids, media_paths


async def circle_connection_action(
    friendship_id: str,
    user_id: str,
    action: str,
    reason: str | None = None,
) -> dict[str, str]:
    room_ids: list[str] = []
    media_paths: list[Path] = []
    with database() as db:
        db.execute("BEGIN IMMEDIATE")
        friendship = db.execute(
            "SELECT * FROM friendships WHERE id = ? AND (user1_id = ? OR user2_id = ?)",
            (friendship_id, user_id, user_id),
        ).fetchone()
        if friendship is None:
            raise HTTPException(status_code=404, detail="Connection not found")
        room_ids, media_paths = delete_circle_connection(db, friendship, user_id, action, reason)
    remove_room_media_files(media_paths)
    for room_id in room_ids:
        await manager.broadcast(room_id, room_payload(room_id, "room_dissolved", {"removed": True}))
    return {"status": action, "room_id": room_ids[-1] if room_ids else ""}


@app.post("/api/v1/circles/{friendship_id}/block")
async def block_circle_connection(
    friendship_id: str,
    authorization: str | None = Header(default=None),
) -> dict[str, str]:
    return await circle_connection_action(friendship_id, get_user_id(authorization), "block")


@app.post("/api/v1/circles/{friendship_id}/remove")
async def remove_circle_connection(
    friendship_id: str,
    authorization: str | None = Header(default=None),
) -> dict[str, str]:
    return await circle_connection_action(friendship_id, get_user_id(authorization), "remove")


@app.post("/api/v1/circles/{friendship_id}/report")
async def report_circle_connection(
    friendship_id: str,
    payload: CircleReportRequest,
    authorization: str | None = Header(default=None),
) -> dict[str, str]:
    return await circle_connection_action(friendship_id, get_user_id(authorization), "report", payload.reason)


@app.post("/api/v1/circles/{friendship_id}/continue")
async def continue_world(
    friendship_id: str,
    payload: ContinueWorldRequest,
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    user_id = get_user_id(authorization)
    ensure_user_can_interact(user_id)
    room_id: str | None = None
    waiting = False
    with database() as db:
        db.execute("BEGIN IMMEDIATE")
        friendship = db.execute(
            "SELECT * FROM friendships WHERE id = ? AND (user1_id = ? OR user2_id = ?)",
            (friendship_id, user_id, user_id),
        ).fetchone()
        if friendship is None:
            raise HTTPException(status_code=404, detail="Connection not found")
        expiry = datetime.fromisoformat(friendship["continue_expires_at"]) if friendship["continue_expires_at"] else None
        if expiry is None or datetime.now(timezone.utc) >= expiry:
            raise HTTPException(status_code=410, detail="The 7-day continue window has ended")
        first_user = friendship["user1_id"] == user_id
        own_vote_column = "user1_continue_vote" if first_user else "user2_continue_vote"
        partner_vote_column = "user2_continue_vote" if first_user else "user1_continue_vote"
        own_time_column = "user1_continue_voted_at" if first_user else "user2_continue_voted_at"
        partner_time_column = "user2_continue_voted_at" if first_user else "user1_continue_voted_at"
        own_vote = friendship[own_vote_column]
        partner_vote = friendship[partner_vote_column]
        if (own_vote == 1) != (partner_vote == 1):
            pending_at = friendship[own_time_column] if own_vote == 1 else friendship[partner_time_column]
            if pending_at and datetime.now(timezone.utc) >= datetime.fromisoformat(pending_at) + timedelta(hours=SHARE_MORE_REPLY_HOURS):
                db.execute(
                    """UPDATE friendships SET user1_continue_vote = NULL, user2_continue_vote = NULL,
                       user1_continue_voted_at = NULL, user2_continue_voted_at = NULL WHERE id = ?""",
                    (friendship_id,),
                )
                own_vote = partner_vote = None
        snapshot = json.loads(friendship["archived_room_snapshot"])
        room_id = snapshot.get("room_id")
        room = db.execute("SELECT * FROM rooms WHERE id = ? AND status = 'graduated'", (room_id,)).fetchone()
        if room is None:
            raise HTTPException(status_code=409, detail="The archived world can no longer be reopened")
        db.execute(
            f"UPDATE friendships SET {own_vote_column} = 1, {own_time_column} = COALESCE({own_time_column}, ?) WHERE id = ?",
            (now_iso(), friendship_id),
        )
        if own_vote != 1:
            own_vote = 1
        if partner_vote == 1:
            active_conflict = db.execute(
                """SELECT id FROM rooms WHERE status = 'active' AND id != ? AND
                   (user1_id IN (?, ?) OR user2_id IN (?, ?)) LIMIT 1""",
                (room_id, friendship["user1_id"], friendship["user2_id"], friendship["user1_id"], friendship["user2_id"]),
            ).fetchone()
            if active_conflict:
                raise HTTPException(status_code=409, detail="Both people need to finish their current island first")
            db.execute("UPDATE rooms SET status = 'active', dissolved_at = NULL WHERE id = ?", (room_id,))
            waiting = False
        else:
            waiting = True
    if room_id and not waiting:
        await manager.broadcast(room_id, room_payload(room_id, "state_sync", {"kind": "world_continued"}))
        return {"status": "continued", "room_id": room_id}
    return {"status": "waiting"}


@app.get("/api/v1/circles/{friendship_id}/messages")
def get_messages(friendship_id: str, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    user_id = get_user_id(authorization)
    with database() as db:
        friendship = db.execute(
            "SELECT id FROM friendships WHERE id = ? AND (user1_id = ? OR user2_id = ?)",
            (friendship_id, user_id, user_id),
        ).fetchone()
        if friendship is None:
            raise HTTPException(status_code=404, detail="Friendship not found")
        messages = db.execute(
            "SELECT id, author_id, content, created_at FROM messages WHERE friendship_id = ? ORDER BY created_at",
            (friendship_id,),
        ).fetchall()
        return {"messages": [dict(row) for row in messages]}


@app.post("/api/v1/circles/{friendship_id}/messages")
async def send_message(
    friendship_id: str,
    payload: MessageRequest,
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    user_id = get_user_id(authorization)
    ensure_user_can_interact(user_id)
    with database() as db:
        db.execute("BEGIN IMMEDIATE")
        friendship = db.execute(
            "SELECT id FROM friendships WHERE id = ? AND (user1_id = ? OR user2_id = ?)",
            (friendship_id, user_id, user_id),
        ).fetchone()
        if friendship is None:
            raise HTTPException(status_code=404, detail="Friendship not found")
        message = {
            "id": str(uuid4()),
            "author_id": user_id,
            "content": payload.content.strip(),
            "created_at": now_iso(),
        }
        db.execute(
            "INSERT INTO messages (id, friendship_id, author_id, content, created_at) VALUES (?, ?, ?, ?, ?)",
            (message["id"], friendship_id, user_id, message["content"], message["created_at"]),
        )
        partner = db.execute(
            """SELECT u.id, u.is_demo FROM friendships f JOIN users u ON u.id =
                 CASE WHEN f.user1_id = ? THEN f.user2_id ELSE f.user1_id END
               WHERE f.id = ?""",
            (user_id, friendship_id),
        ).fetchone()
        if partner and partner["is_demo"]:
            demo_message = {
                "id": str(uuid4()),
                "author_id": partner["id"],
                "content": "A little hello from your simulated companion. Real conversations need another signed-in person.",
                "created_at": now_iso(),
            }
            db.execute(
                "INSERT INTO messages (id, friendship_id, author_id, content, created_at) VALUES (?, ?, ?, ?, ?)",
                (
                    demo_message["id"],
                    friendship_id,
                    demo_message["author_id"],
                    demo_message["content"],
                    demo_message["created_at"],
                ),
            )
    return {"message": message}


@app.post("/api/v1/room/report")
def report_partner(
    payload: ReportRequest, authorization: str | None = Header(default=None)
) -> dict[str, str]:
    user_id = get_user_id(authorization)
    with database() as db:
        db.execute("BEGIN IMMEDIATE")
        room = active_room_for_user(db, user_id)
        if room is None:
            raise HTTPException(status_code=404, detail="You do not have an active room")
        partner_id = room["user2_id"] if room["user1_id"] == user_id else room["user1_id"]
        report_id = str(uuid4())
        db.execute(
            """INSERT INTO reports (id, room_id, reporter_id, reported_user_id, reason, created_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (report_id, room["id"], user_id, partner_id, payload.reason.strip(), now_iso()),
        )
    return {"status": "reported", "report_id": report_id}


def require_admin(token: str | None) -> None:
    if not token or not secrets.compare_digest(token, ADMIN_TOKEN):
        raise HTTPException(status_code=401, detail="Admin token required")


@app.get("/api/v1/admin/overview")
def admin_overview(x_admin_token: str | None = Header(default=None)) -> dict[str, Any]:
    require_admin(x_admin_token)
    with database() as db:
        users = db.execute("SELECT COUNT(*) AS count FROM users WHERE is_demo = 0").fetchone()["count"]
        active = db.execute("SELECT COUNT(*) AS count FROM rooms WHERE status = 'active'").fetchone()["count"]
        graduated = db.execute("SELECT COUNT(*) AS count FROM friendships").fetchone()["count"]
        open_reports = db.execute("SELECT COUNT(*) AS count FROM reports WHERE status = 'open'").fetchone()["count"]
        two_way_chats = db.execute(
            """SELECT COUNT(*) AS count FROM (
                   SELECT m.room_id FROM room_messages m JOIN users u ON u.id = m.author_id WHERE u.is_demo = 0
                   GROUP BY m.room_id
                   HAVING COUNT(DISTINCT author_id) >= 2
               )"""
        ).fetchone()["count"]
        mutual_prompt_days = db.execute(
            """SELECT COUNT(*) AS count FROM (
                   SELECT a.room_id, a.prompt_day FROM daily_prompt_answers a
                   JOIN users u ON u.id = a.user_id WHERE u.is_demo = 0
                   GROUP BY a.room_id, a.prompt_day
                   HAVING COUNT(DISTINCT a.user_id) >= 2
               )"""
        ).fetchone()["count"]
        areas = db.execute(
            """SELECT neighborhood_tag AS neighborhood, COUNT(*) AS users
               FROM users WHERE is_demo = 0 AND neighborhood_tag != ''
               GROUP BY neighborhood_tag ORDER BY users DESC""",
        ).fetchall()
        return {
            "users": users,
            "active_rooms": active,
            "graduated_friendships": graduated,
            "open_reports": open_reports,
            "two_way_chats": two_way_chats,
            "mutual_prompt_days": mutual_prompt_days,
            "neighborhoods": [dict(row) for row in areas],
        }


@app.get("/api/v1/admin/reports")
def admin_reports(x_admin_token: str | None = Header(default=None)) -> dict[str, Any]:
    require_admin(x_admin_token)
    with database() as db:
        rows = db.execute(
            """SELECT r.id, r.room_id, r.reason, r.status, r.created_at,
                      u.anonymous_handle AS reporter, v.id AS reported_user_id,
                      v.anonymous_handle AS reported_handle
               FROM reports r JOIN users u ON u.id = r.reporter_id
               JOIN users v ON v.id = r.reported_user_id
               ORDER BY CASE r.status WHEN 'open' THEN 0 ELSE 1 END, r.created_at DESC"""
        ).fetchall()
        return {"reports": [dict(row) for row in rows]}


@app.post("/api/v1/admin/reports/{report_id}/action")
async def moderate_report(
    report_id: str,
    payload: ModerationAction,
    x_admin_token: str | None = Header(default=None),
) -> dict[str, str]:
    require_admin(x_admin_token)
    room_ids: list[str] = []
    with database() as db:
        report = db.execute(
            "SELECT reported_user_id FROM reports WHERE id = ?", (report_id,)
        ).fetchone()
        if report is None:
            raise HTTPException(status_code=404, detail="Report not found")
        action = payload.action
        if action == "hard_ban":
            db.execute("UPDATE users SET is_banned = 1 WHERE id = ?", (report["reported_user_id"],))
            room_ids = [
                row["id"]
                for row in db.execute(
                    "SELECT id FROM rooms WHERE status = 'active' AND (user1_id = ? OR user2_id = ?)",
                    (report["reported_user_id"], report["reported_user_id"]),
                ).fetchall()
            ]
            db.execute(
                """UPDATE rooms SET status = 'dissolved', dissolved_at = ?
                   WHERE status = 'active' AND (user1_id = ? OR user2_id = ?)""",
                (now_iso(), report["reported_user_id"], report["reported_user_id"]),
            )
        elif action == "shadow_ban":
            db.execute("UPDATE users SET is_shadow_banned = 1 WHERE id = ?", (report["reported_user_id"],))
        elif action == "soft_mute":
            db.execute("UPDATE users SET is_muted = 1 WHERE id = ?", (report["reported_user_id"],))
        db.execute("UPDATE reports SET status = ? WHERE id = ?", (action, report_id))
    for room_id in room_ids:
        await manager.broadcast(
            room_id,
            room_payload(room_id, "room_dissolved", {"by_admin": True}),
        )
    return {"status": action, "report_id": report_id}


@app.get("/api/v1/admin/users")
def admin_users(
    q: str = Query(default="", max_length=50),
    x_admin_token: str | None = Header(default=None),
) -> dict[str, Any]:
    require_admin(x_admin_token)
    with database() as db:
        users = db.execute(
            """SELECT id, anonymous_handle, neighborhood_tag, verification_tier, vibe_score,
                      is_banned, is_shadow_banned, is_muted, created_at
               FROM users
               WHERE is_demo = 0 AND (? = '' OR anonymous_handle LIKE ? OR phone_number LIKE ?)
               ORDER BY created_at DESC LIMIT 100""",
            (q, f"%{q}%", f"%{q}%"),
        ).fetchall()
        return {"users": [dict(row) for row in users]}


@app.post("/api/v1/admin/users/{user_id}/vibe-score")
def update_vibe_score(
    user_id: str,
    payload: VibeScoreRequest,
    x_admin_token: str | None = Header(default=None),
) -> dict[str, Any]:
    require_admin(x_admin_token)
    with database() as db:
        cursor = db.execute(
            "UPDATE users SET vibe_score = ? WHERE id = ? AND is_demo = 0",
            (payload.vibe_score, user_id),
        )
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="User not found")
    return {"user_id": user_id, "vibe_score": payload.vibe_score}


@app.post("/api/v1/admin/users/{user_id}/action")
async def admin_user_action(
    user_id: str,
    payload: AdminUserAction,
    x_admin_token: str | None = Header(default=None),
) -> dict[str, str]:
    require_admin(x_admin_token)
    columns = {
        "soft_mute": ("is_muted", 1),
        "shadow_ban": ("is_shadow_banned", 1),
        "hard_ban": ("is_banned", 1),
    }
    room_ids: list[str] = []
    with database() as db:
        user = db.execute(
            "SELECT id FROM users WHERE id = ? AND is_demo = 0", (user_id,)
        ).fetchone()
        if user is None:
            raise HTTPException(status_code=404, detail="User not found")
        if payload.action == "restore":
            db.execute(
                "UPDATE users SET is_banned = 0, is_shadow_banned = 0, is_muted = 0 WHERE id = ?",
                (user_id,),
            )
        else:
            column, value = columns[payload.action]
            db.execute(f"UPDATE users SET {column} = ? WHERE id = ?", (value, user_id))
            if payload.action == "hard_ban":
                room_ids = [
                    row["id"]
                    for row in db.execute(
                        "SELECT id FROM rooms WHERE status = 'active' AND (user1_id = ? OR user2_id = ?)",
                        (user_id, user_id),
                    ).fetchall()
                ]
                db.execute(
                    """UPDATE rooms SET status = 'dissolved', dissolved_at = ?
                       WHERE status = 'active' AND (user1_id = ? OR user2_id = ?)""",
                    (now_iso(), user_id, user_id),
                )
    for room_id in room_ids:
        await manager.broadcast(
            room_id,
            room_payload(room_id, "room_dissolved", {"by_admin": True}),
        )
    return {"status": payload.action, "user_id": user_id}


@app.get("/api/v1/admin/settings")
def admin_settings(x_admin_token: str | None = Header(default=None)) -> dict[str, int]:
    require_admin(x_admin_token)
    with database() as db:
        return {
            "matching_radius_km": get_setting(db, "matching_radius_km", 40),
            "unmask_day_threshold": get_setting(db, "unmask_day_threshold", 3),
        }


@app.get("/api/v1/admin/rooms")
def admin_rooms(x_admin_token: str | None = Header(default=None)) -> dict[str, Any]:
    require_admin(x_admin_token)
    with database() as db:
        rooms = db.execute(
            """SELECT r.id AS room_id, r.created_at,
                      first.anonymous_handle AS user1_handle,
                      second.anonymous_handle AS user2_handle
               FROM rooms r
               JOIN users first ON first.id = r.user1_id
               JOIN users second ON second.id = r.user2_id
               WHERE r.status = 'active' ORDER BY r.created_at"""
        ).fetchall()
        return {"rooms": [dict(row) for row in rooms]}


@app.put("/api/v1/admin/settings")
def update_admin_settings(
    payload: AdminSettingsRequest,
    x_admin_token: str | None = Header(default=None),
) -> dict[str, int]:
    require_admin(x_admin_token)
    with database() as db:
        db.executemany(
            "INSERT OR REPLACE INTO app_settings (setting_key, setting_value) VALUES (?, ?)",
            [
                ("matching_radius_km", payload.matching_radius_km),
                ("unmask_day_threshold", payload.unmask_day_threshold),
            ],
        )
    return {
        "matching_radius_km": payload.matching_radius_km,
        "unmask_day_threshold": payload.unmask_day_threshold,
    }


@app.post("/api/v1/admin/rooms/{room_id}/dissolve")
async def admin_dissolve_room(
    room_id: str,
    x_admin_token: str | None = Header(default=None),
) -> dict[str, str]:
    require_admin(x_admin_token)
    with database() as db:
        cursor = db.execute(
            "UPDATE rooms SET status = 'dissolved', dissolved_at = ? WHERE id = ? AND status = 'active'",
            (now_iso(), room_id),
        )
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Active room not found")
    await manager.broadcast(room_id, room_payload(room_id, "room_dissolved", {"by_admin": True}))
    return {"status": "dissolved", "room_id": room_id}


@app.websocket("/ws/room/{room_id}")
async def room_socket(websocket: WebSocket, room_id: str) -> None:
    token = websocket.query_params.get("token", "")
    try:
        user_id = get_user_id(f"Bearer {token}")
        with database() as db:
            get_room(db, room_id, user_id)
    except HTTPException:
        await websocket.close(code=1008, reason="Unauthorized or inactive room")
        return
    await manager.connect(room_id, websocket)
    await manager.broadcast(room_id, room_payload(room_id, "presence_glow", {"online": True, "from": user_id}))
    try:
        while True:
            event = await websocket.receive_json()
            event_type = event.get("event")
            with database() as db:
                db.execute("UPDATE users SET last_seen_at = ? WHERE id = ?", (now_iso(), user_id))
            if event_type == "haptic_nudge":
                try:
                    ensure_user_can_interact(user_id)
                except HTTPException as exc:
                    await websocket.send_json(room_payload(room_id, "error", {"message": exc.detail}))
                    continue
                await manager.broadcast(
                    room_id,
                    room_payload(room_id, "haptic_nudge", {"from": user_id, "type": "coffee_bump"}),
                )
            elif event_type == "presence":
                await manager.broadcast(
                    room_id,
                    room_payload(room_id, "presence_glow", {"online": bool(event.get("online", True)), "from": user_id}),
                )
            else:
                await websocket.send_json(room_payload(room_id, "error", {"message": "Unsupported room event"}))
    except WebSocketDisconnect:
        await manager.disconnect(room_id, websocket)
        await manager.broadcast(room_id, room_payload(room_id, "presence_glow", {"online": False, "from": user_id}))
