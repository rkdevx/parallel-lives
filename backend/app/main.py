from __future__ import annotations

import asyncio
import base64
import json
import math
import os
import secrets
import sqlite3
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timezone
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
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                created_at TEXT NOT NULL
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
                user1_vote INTEGER,
                user2_vote INTEGER,
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
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS daily_actions (
                room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
                user_id TEXT NOT NULL REFERENCES users(id),
                action_date TEXT NOT NULL,
                action TEXT NOT NULL,
                PRIMARY KEY (room_id, user_id, action_date, action)
            );
            CREATE TABLE IF NOT EXISTS friendships (
                id TEXT PRIMARY KEY,
                user1_id TEXT NOT NULL REFERENCES users(id),
                user2_id TEXT NOT NULL REFERENCES users(id),
                archived_room_snapshot TEXT NOT NULL,
                created_at TEXT NOT NULL,
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
        db.execute(
            "INSERT OR IGNORE INTO app_settings (setting_key, setting_value) VALUES ('matching_radius_km', 5)"
        )
        db.execute(
            "INSERT OR IGNORE INTO app_settings (setting_key, setting_value) VALUES ('unmask_day_threshold', 10)"
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


def serialize_asset(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "author_id": row["author_id"],
        "asset_type": row["asset_type"],
        "content": row["content"],
        "media_url": row["media_url"],
        "created_at": row["created_at"],
    }


def serialize_room(db: sqlite3.Connection, room: sqlite3.Row, user_id: str) -> dict[str, Any]:
    partner_id = room["user2_id"] if room["user1_id"] == user_id else room["user1_id"]
    partner = db.execute(
        """SELECT id, anonymous_handle, neighborhood_tag, verification_tier, is_demo
           FROM users WHERE id = ?""",
        (partner_id,),
    ).fetchone()
    created = datetime.fromisoformat(room["created_at"])
    days_elapsed = max(1, (datetime.now(timezone.utc) - created).days + 1)
    unmask_day = get_setting(db, "unmask_day_threshold", 10)
    assets = db.execute(
        "SELECT * FROM assets WHERE room_id = ? ORDER BY created_at ASC", (room["id"],)
    ).fetchall()
    friendship = db.execute(
        """SELECT id FROM friendships
           WHERE (user1_id = ? AND user2_id = ?) OR (user1_id = ? AND user2_id = ?)""",
        (room["user1_id"], room["user2_id"], room["user2_id"], room["user1_id"]),
    ).fetchone()
    return {
        "room_id": room["id"],
        "room_level": room["room_level"],
        "day_streak": min(days_elapsed, unmask_day),
        "days_elapsed": days_elapsed,
        "days_until_unmask": max(0, unmask_day - days_elapsed),
        "unmask_day_threshold": unmask_day,
        "shared_state": json.loads(room["shared_state"]),
        "assets": [serialize_asset(asset) for asset in assets],
        "partner": dict(partner) if partner else None,
        "demo_companion": bool(partner and partner["is_demo"]),
        "is_unmasked": friendship is not None,
        "friendship_id": friendship["id"] if friendship else None,
        "my_unmask_vote": room["user1_vote"] if room["user1_id"] == user_id else room["user2_vote"],
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
    asset_type: str = Field(pattern=r"^sticky_note$")
    content: str | None = Field(default=None, max_length=140)


class PolaroidUploadRequest(BaseModel):
    image_base64: str = Field(min_length=100, max_length=3_000_000)
    content_type: str = Field(pattern=r"^image/(jpeg|png|webp)$")


class UnmaskRequest(BaseModel):
    accept: bool


class MessageRequest(BaseModel):
    content: str = Field(min_length=1, max_length=2000)


class ReportRequest(BaseModel):
    reason: str = Field(min_length=3, max_length=500)


class ModerationAction(BaseModel):
    action: str = Field(pattern=r"^(review|soft_mute|shadow_ban|hard_ban|dismiss)$")


class AdminSettingsRequest(BaseModel):
    matching_radius_km: int = Field(ge=1, le=25)
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
        user = db.execute(
            "SELECT anonymous_handle, latitude, longitude, vibe_tags FROM users WHERE id = ?",
            (user_id,),
        ).fetchone()
        if not user or not user["anonymous_handle"] or user["latitude"] is None or user["longitude"] is None:
            raise HTTPException(status_code=409, detail="Complete your anonymous profile before matching")
        room = active_room_for_user(db, user_id)
        if room is not None:
            return serialize_room(db, room, user_id)
        partner_id = str(uuid4())
        offset = 0.008
        partner_latitude = user["latitude"] + offset if user["latitude"] + offset <= max_lat else user["latitude"] - offset
        partner_longitude = user["longitude"] + offset if user["longitude"] + offset <= max_lng else user["longitude"] - offset
        latitude_delta = math.radians(user["latitude"] - partner_latitude)
        longitude_delta = math.radians(user["longitude"] - partner_longitude)
        haversine = math.sin(latitude_delta / 2) ** 2 + math.cos(math.radians(user["latitude"])) * math.cos(
            math.radians(partner_latitude)
        ) * math.sin(longitude_delta / 2) ** 2
        distance_km = 6371 * 2 * math.asin(math.sqrt(haversine))
        matching_radius = get_setting(db, "matching_radius_km", 5)
        if distance_km > matching_radius:
            raise HTTPException(status_code=404, detail="No companion is available within your matching radius")
        room_id = str(uuid4())
        db.execute(
            """INSERT INTO users
               (id, phone_number, anonymous_handle, neighborhood_tag, latitude, longitude,
                verification_tier, is_demo, created_at)
               VALUES (?, ?, ?, ?, ?, ?, 'demo', 1, ?)""",
            (
                partner_id,
                f"demo+{partner_id}@parallel-lives.invalid",
                f"cinder{partner_id[:4]}",
                "Baner",
                partner_latitude,
                partner_longitude,
                now_iso(),
            ),
        )
        db.execute(
            "INSERT INTO rooms (id, user1_id, user2_id, shared_state, created_at) VALUES (?, ?, ?, ?, ?)",
            (
                room_id,
                user_id,
                partner_id,
                json.dumps({"plant_health": 86, "active_track": None, "theme": "sunset"}),
                now_iso(),
            ),
        )
        db.execute(
            """INSERT INTO assets (id, room_id, author_id, asset_type, content, created_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (str(uuid4()), room_id, partner_id, "sticky_note", "A quiet room is still a room.", now_iso()),
        )
        room = db.execute("SELECT * FROM rooms WHERE id = ?", (room_id,)).fetchone()
        result = serialize_room(db, room, user_id)
        result["match"] = {
            "distance_km": round(distance_km, 1),
            "vibe_match": payload.vibe_filters or json.loads(user["vibe_tags"]),
            "demo_companion": True,
        }
    await manager.broadcast(room_id, room_payload(room_id, "state_sync", {"kind": "room_created"}))
    return result


@app.get("/api/v1/room/active")
def get_active_room(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    user_id = get_user_id(authorization)
    with database() as db:
        db.execute("BEGIN IMMEDIATE")
        room = active_room_for_user(db, user_id)
        if room is None:
            raise HTTPException(status_code=404, detail="You do not have an active room")
        return serialize_room(db, room, user_id)


@app.post("/api/v1/room/asset")
async def create_room_asset(
    payload: AssetRequest,
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    user_id = get_user_id(authorization)
    ensure_user_can_interact(user_id)
    if not (payload.content or "").strip():
        raise HTTPException(status_code=422, detail="Sticky notes need text")
    with database() as db:
        room = active_room_for_user(db, user_id)
        if room is None:
            raise HTTPException(status_code=404, detail="You do not have an active room")
        asset_id = str(uuid4())
        db.execute(
            """INSERT INTO assets (id, room_id, author_id, asset_type, content, media_url, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (asset_id, room["id"], user_id, payload.asset_type, payload.content, None, now_iso()),
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
        uploaded_today = db.execute(
            """SELECT 1 FROM assets WHERE room_id = ? AND author_id = ? AND asset_type = 'polaroid'
               AND date(created_at) = date('now')""",
            (room["id"], user_id),
        ).fetchone()
        if uploaded_today:
            raise HTTPException(status_code=429, detail="You can add one polaroid per day")
        media_path.write_bytes(image_bytes)
        media_url = f"/api/v1/media/{asset_id}"
        try:
            db.execute(
                """INSERT INTO assets (id, room_id, author_id, asset_type, media_url, created_at)
                   VALUES (?, ?, ?, 'polaroid', ?, ?)""",
                (asset_id, room["id"], user_id, media_url, now_iso()),
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
                 AND (r.user1_id = ? OR r.user2_id = ?)""",
            (asset_id, user_id, user_id),
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
    with database() as db:
        db.execute("BEGIN IMMEDIATE")
        room = active_room_for_user(db, user_id)
        if room is None:
            raise HTTPException(status_code=404, detail="You do not have an active room")
        db.execute(
            "UPDATE rooms SET status = 'dissolved', dissolved_at = ? WHERE id = ?",
            (now_iso(), room["id"]),
        )
    await manager.broadcast(room["id"], room_payload(room["id"], "room_dissolved", {}))
    return {"status": "dissolved", "room_id": room["id"]}


@app.post("/api/v1/room/unmask-opt-in")
async def unmask_opt_in(
    payload: UnmaskRequest, authorization: str | None = Header(default=None)
) -> dict[str, Any]:
    user_id = get_user_id(authorization)
    with database() as db:
        db.execute("BEGIN IMMEDIATE")
        room = active_room_for_user(db, user_id)
        if room is None:
            raise HTTPException(status_code=404, detail="You do not have an active room")
        if payload.accept:
            elapsed = (datetime.now(timezone.utc) - datetime.fromisoformat(room["created_at"])).days + 1
            unmask_day = get_setting(db, "unmask_day_threshold", 10)
            if elapsed < unmask_day:
                raise HTTPException(
                    status_code=409,
                    detail=f"Unmasking opens on day {unmask_day} ({unmask_day - elapsed} days to go)",
                )
        column = "user1_vote" if room["user1_id"] == user_id else "user2_vote"
        db.execute(f"UPDATE rooms SET {column} = ? WHERE id = ?", (int(payload.accept), room["id"]))
        updated = db.execute("SELECT * FROM rooms WHERE id = ?", (room["id"],)).fetchone()
        if not payload.accept:
            db.execute(
                "UPDATE rooms SET status = 'dissolved', dissolved_at = ? WHERE id = ?",
                (now_iso(), room["id"]),
            )
            result = {"status": "dissolved", "is_unmasked": False}
        else:
            partner_id = room["user2_id"] if room["user1_id"] == user_id else room["user1_id"]
            partner = db.execute("SELECT is_demo FROM users WHERE id = ?", (partner_id,)).fetchone()
            if partner and partner["is_demo"]:
                other_vote = "user2_vote" if room["user1_id"] == user_id else "user1_vote"
                db.execute(f"UPDATE rooms SET {other_vote} = 1 WHERE id = ?", (room["id"],))
                updated = db.execute("SELECT * FROM rooms WHERE id = ?", (room["id"],)).fetchone()
        if payload.accept and updated["user1_vote"] == 1 and updated["user2_vote"] == 1:
            friendship_id = str(uuid4())
            db.execute(
                """INSERT OR IGNORE INTO friendships
                   (id, user1_id, user2_id, archived_room_snapshot, created_at)
                   VALUES (?, ?, ?, ?, ?)""",
                (
                    friendship_id,
                    room["user1_id"],
                    room["user2_id"],
                    json.dumps({"room_id": room["id"], "shared_state": json.loads(room["shared_state"])}),
                    now_iso(),
                ),
            )
            db.execute(
                "UPDATE rooms SET status = 'graduated' WHERE id = ?", (room["id"],)
            )
            result = {"status": "graduated", "is_unmasked": True, "friendship_id": friendship_id}
        else:
            result = {"status": "waiting_for_partner", "is_unmasked": False}
    await manager.broadcast(room["id"], room_payload(room["id"], "unmask_updated", result))
    return result


@app.get("/api/v1/circles")
def get_circles(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    user_id = get_user_id(authorization)
    with database() as db:
        friendships = db.execute(
            """SELECT f.id AS friendship_id, f.created_at, u.id AS partner_id,
                      u.anonymous_handle, u.neighborhood_tag, u.verification_tier
               FROM friendships f JOIN users u ON u.id =
                 CASE WHEN f.user1_id = ? THEN f.user2_id ELSE f.user1_id END
               WHERE f.user1_id = ? OR f.user2_id = ? ORDER BY f.created_at DESC""",
            (user_id, user_id, user_id),
        ).fetchall()
        return {"friendships": [dict(row) for row in friendships]}


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
            "matching_radius_km": get_setting(db, "matching_radius_km", 5),
            "unmask_day_threshold": get_setting(db, "unmask_day_threshold", 10),
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
    await manager.broadcast(room_id, room_payload(room_id, "presence_glow", {"online": True}))
    try:
        while True:
            event = await websocket.receive_json()
            event_type = event.get("event")
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
            elif event_type == "update_jukebox":
                try:
                    ensure_user_can_interact(user_id)
                except HTTPException as exc:
                    await websocket.send_json(room_payload(room_id, "error", {"message": exc.detail}))
                    continue
                track = str(event.get("track_id", ""))[:100]
                with database() as db:
                    room = get_room(db, room_id, user_id)
                    state = json.loads(room["shared_state"])
                    state["active_track"] = track or None
                    db.execute("UPDATE rooms SET shared_state = ? WHERE id = ?", (json.dumps(state), room_id))
                await manager.broadcast(room_id, room_payload(room_id, "state_sync", {"active_track": track}))
            elif event_type == "presence":
                await manager.broadcast(
                    room_id,
                    room_payload(room_id, "presence_glow", {"online": bool(event.get("online", True)), "from": user_id}),
                )
            else:
                await websocket.send_json(room_payload(room_id, "error", {"message": "Unsupported room event"}))
    except WebSocketDisconnect:
        await manager.disconnect(room_id, websocket)
        await manager.broadcast(room_id, room_payload(room_id, "presence_glow", {"online": False}))
