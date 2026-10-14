from __future__ import annotations

import base64
from datetime import datetime, timedelta, timezone
from io import BytesIO

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import main


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "DATABASE_PATH", tmp_path / "parallel-lives-test.db")
    with TestClient(main.app) as test_client:
        yield test_client


def create_user(
    client: TestClient,
    phone: str = "+919876543210",
    latitude: float = 18.5204,
    longitude: float = 73.8567,
) -> tuple[str, str]:
    sent = client.post("/api/v1/auth/request-otp", json={"phone": phone})
    assert sent.status_code == 200
    verified = client.post(
        "/api/v1/auth/verify-otp", json={"phone": phone, "code": main.DEMO_OTP}
    )
    assert verified.status_code == 200
    token = verified.json()["token"]
    headers = {"Authorization": f"Bearer {token}"}
    profile = client.post(
        "/api/v1/profile",
        headers=headers,
        json={
            "handle": f"quietorbit{phone[-4:]}",
            "neighborhood": "Baner",
            "latitude": latitude,
            "longitude": longitude,
            "vibes": ["music", "coffee"],
        },
    )
    assert profile.status_code == 200
    assert profile.json()["user"]["latitude"] == latitude
    assert profile.json()["user"]["longitude"] == longitude
    return token, headers["Authorization"]


def match_two_users(
    client: TestClient,
    first_authorization: str,
    second_authorization: str,
    latitude: float = 18.5204,
    longitude: float = 73.8567,
) -> dict:
    first = client.post(
        "/api/v1/match/find-companion",
        headers={"Authorization": first_authorization},
        json={"latitude": latitude, "longitude": longitude},
    )
    assert first.status_code == 200
    assert first.json()["status"] == "waiting"
    second = client.post(
        "/api/v1/match/find-companion",
        headers={"Authorization": second_authorization},
        json={"latitude": latitude, "longitude": longitude},
    )
    assert second.status_code == 200
    assert second.json()["room_id"]
    return second.json()


def test_room_lifecycle_assets_circle_and_moderation(client: TestClient):
    token, authorization = create_user(client)
    headers = {"Authorization": authorization}
    second_token, second_authorization = create_user(client, "+919876543217")
    second_headers = {"Authorization": second_authorization}
    room = match_two_users(client, authorization, second_authorization)
    room_id = room["room_id"]
    assert room["demo_companion"] is False
    assert room["days_until_unmask"] == 2
    assert room["daily_prompt"]["day"] == 1
    prompt_answer = client.post(
        "/api/v1/room/daily-prompt",
        headers=headers,
        json={"day": 1, "answer": "The evening breeze on my walk."},
    )
    assert prompt_answer.status_code == 200
    assert prompt_answer.json()["daily_prompt"]["revealed"] is False
    partner_answer = client.post(
        "/api/v1/room/daily-prompt",
        headers=second_headers,
        json={"day": 1, "answer": "The evening sky on my walk."},
    )
    assert partner_answer.json()["daily_prompt"]["revealed"] is True
    room_message = client.post(
        "/api/v1/room/messages", headers=headers, json={"content": "Hey, how was your day?"}
    )
    assert room_message.status_code == 200
    assert room_message.json()["message"]["content"] == "Hey, how was your day?"
    partner_message = client.post(
        "/api/v1/room/messages", headers=second_headers, json={"content": "Pretty good, thanks for asking."}
    )
    assert partner_message.status_code == 200
    assert client.get("/api/v1/room/messages", headers=headers).json()["messages"][0]["id"] == room_message.json()["message"]["id"]

    note = client.post(
        "/api/v1/room/asset",
        headers=headers,
        json={"asset_type": "sticky_note", "content": "A little note"},
    )
    assert note.status_code == 200
    image = Image.new("RGB", (24, 24), color="salmon")
    exif = Image.Exif()
    exif[274] = 3
    encoded = BytesIO()
    image.save(encoded, format="JPEG", exif=exif)
    polaroid = client.post(
        "/api/v1/room/polaroid",
        headers=headers,
        json={
            "image_base64": base64.b64encode(encoded.getvalue()).decode("ascii"),
            "content_type": "image/jpeg",
        },
    )
    assert polaroid.status_code == 200
    photo_url = polaroid.json()["asset"]["media_url"]
    photo = client.get(photo_url, headers=headers)
    assert photo.status_code == 200
    with Image.open(BytesIO(photo.content)) as normalized:
        assert normalized.getexif().get(274) is None
    second_polaroid = client.post(
        "/api/v1/room/polaroid",
        headers=headers,
        json={
            "image_base64": base64.b64encode(encoded.getvalue()).decode("ascii"),
            "content_type": "image/jpeg",
        },
    )
    assert second_polaroid.status_code == 429

    watered = client.post("/api/v1/room/water-plant", headers=headers)
    assert watered.status_code == 200
    assert watered.json()["shared_state"]["plant_health"] == 100
    assert client.post("/api/v1/room/water-plant", headers=headers).status_code == 409

    report = client.post(
        "/api/v1/room/report", headers=headers, json={"reason": "Test safety report"}
    )
    assert report.status_code == 200
    assert client.post(
        "/api/v1/room/unmask-opt-in", headers=headers, json={"accept": True}
    ).status_code == 409

    old_enough = (datetime.now(timezone.utc) - timedelta(days=9, minutes=1)).isoformat()
    with main.database() as db:
        db.execute("UPDATE rooms SET created_at = ? WHERE id = ?", (old_enough, room_id))
    waiting = client.post(
        "/api/v1/room/unmask-opt-in", headers=headers, json={"accept": True}
    )
    assert waiting.status_code == 200
    assert waiting.json()["status"] == "waiting_for_partner"
    graduated = client.post(
        "/api/v1/room/unmask-opt-in", headers=second_headers, json={"accept": True}
    )
    assert graduated.status_code == 200
    assert graduated.json()["status"] == "graduated"
    assert client.get("/api/v1/room/active", headers=headers).status_code == 404

    circles = client.get("/api/v1/circles", headers=headers).json()["friendships"]
    assert len(circles) == 1
    friendship_id = circles[0]["friendship_id"]
    sent_message = client.post(
        f"/api/v1/circles/{friendship_id}/messages",
        headers=headers,
        json={"content": "Hello from the preview"},
    )
    assert sent_message.status_code == 200
    messages = client.get(
        f"/api/v1/circles/{friendship_id}/messages", headers=headers
    ).json()["messages"]
    assert len(messages) == 3
    assert messages[0]["content"] == "Hey, how was your day?"
    assert messages[1]["content"] == "Pretty good, thanks for asking."
    assert messages[2]["content"] == "Hello from the preview"

    overview = client.get(
        "/api/v1/admin/overview", headers={"X-Admin-Token": main.ADMIN_TOKEN}
    )
    assert overview.status_code == 200
    assert overview.json()["users"] == 2
    assert overview.json()["graduated_friendships"] == 1
    assert overview.json()["open_reports"] == 1
    admin_headers = {"X-Admin-Token": main.ADMIN_TOKEN}
    assert client.get("/api/v1/admin/settings", headers=admin_headers).json() == {
        "matching_radius_km": 40,
        "unmask_day_threshold": 3,
    }
    settings = client.put(
        "/api/v1/admin/settings",
        headers=admin_headers,
        json={"matching_radius_km": 25, "unmask_day_threshold": 12},
    )
    assert settings.status_code == 200
    assert client.put(
        "/api/v1/admin/settings",
        headers=admin_headers,
        json={"matching_radius_km": 41, "unmask_day_threshold": 12},
    ).status_code == 422
    current_user = client.get("/api/v1/me", headers=headers).json()["user"]
    score = client.post(
        f"/api/v1/admin/users/{current_user['id']}/vibe-score",
        headers=admin_headers,
        json={"vibe_score": 78},
    )
    assert score.status_code == 200
    listed_users = client.get("/api/v1/admin/users?q=quietorbit", headers=admin_headers)
    assert listed_users.status_code == 200
    assert next(user for user in listed_users.json()["users"] if user["id"] == current_user["id"])["vibe_score"] == 78

    reports = client.get(
        "/api/v1/admin/reports", headers={"X-Admin-Token": main.ADMIN_TOKEN}
    ).json()["reports"]
    report_id = reports[0]["id"]
    moderated = client.post(
        f"/api/v1/admin/reports/{report_id}/action",
        headers={"X-Admin-Token": main.ADMIN_TOKEN},
        json={"action": "dismiss"},
    )
    assert moderated.status_code == 200
    assert client.get(
        "/api/v1/admin/overview", headers={"X-Admin-Token": main.ADMIN_TOKEN}
    ).json()["open_reports"] == 0

    rematch = client.post(
        "/api/v1/match/find-companion",
        headers=headers,
        json={"latitude": 18.5204, "longitude": 73.8567},
    )
    assert rematch.status_code == 200
    assert rematch.json()["status"] == "waiting"
    rematched = client.post(
        "/api/v1/match/find-companion",
        headers=second_headers,
        json={"latitude": 18.5204, "longitude": 73.8567},
    )
    assert rematched.json()["room_id"] != room_id
    active_rooms = client.get("/api/v1/admin/rooms", headers=admin_headers).json()["rooms"]
    assert len(active_rooms) == 1
    dissolved = client.post(
        f"/api/v1/admin/rooms/{active_rooms[0]['room_id']}/dissolve",
        headers=admin_headers,
    )
    assert dissolved.status_code == 200
    assert client.get("/api/v1/room/active", headers=headers).status_code == 404
    muted = client.post(
        f"/api/v1/admin/users/{current_user['id']}/action",
        headers=admin_headers,
        json={"action": "soft_mute"},
    )
    assert muted.status_code == 200
    assert client.post(
        f"/api/v1/circles/{friendship_id}/messages",
        headers=headers,
        json={"content": "This should be blocked"},
    ).status_code == 403
    restored = client.post(
        f"/api/v1/admin/users/{current_user['id']}/action",
        headers=admin_headers,
        json={"action": "restore"},
    )
    assert restored.status_code == 200


def test_geo_lock_authentication_and_active_room_access(client: TestClient):
    token, authorization = create_user(client, "+919876543211")
    headers = {"Authorization": authorization}
    outside = client.post(
        "/api/v1/match/find-companion",
        headers=headers,
        json={"latitude": 19.0, "longitude": 73.8},
    )
    assert outside.status_code == 403
    assert client.get("/api/v1/room/active").status_code == 401
    assert client.get(
        "/api/v1/me", headers={"Authorization": f"Bearer {token}-invalid"}
    ).status_code == 401

    matched = client.post(
        "/api/v1/match/find-companion",
        headers=headers,
        json={"latitude": 18.5204, "longitude": 73.8567},
    )
    assert matched.status_code == 200
    assert matched.json()["status"] == "waiting"
    again = client.post(
        "/api/v1/match/find-companion",
        headers=headers,
        json={"latitude": 18.5204, "longitude": 73.8567},
    )
    assert again.status_code == 200
    assert again.json()["queued_at"] == matched.json()["queued_at"]
    _, second_authorization = create_user(client, "+919876543218")
    room = client.post(
        "/api/v1/match/find-companion",
        headers={"Authorization": second_authorization},
        json={"latitude": 18.5204, "longitude": 73.8567},
    ).json()
    assert room["room_id"]
    assert client.get("/api/v1/match/status", headers=headers).json()["room"]["room_id"] == room["room_id"]


def test_daily_prompt_answers_stay_private_until_both_submit(client: TestClient):
    _, first_authorization = create_user(client, "+919876543213")
    first_headers = {"Authorization": first_authorization}
    waiting = client.post(
        "/api/v1/match/find-companion",
        headers=first_headers,
        json={"latitude": 18.5204, "longitude": 73.8567},
    ).json()
    _, second_authorization = create_user(client, "+919876543214")
    second_headers = {"Authorization": second_authorization}
    room = client.post(
        "/api/v1/match/find-companion",
        headers=second_headers,
        json={"latitude": 18.5204, "longitude": 73.8567},
    ).json()
    assert waiting["status"] == "waiting"

    assert client.post(
        "/api/v1/room/daily-prompt",
        headers=first_headers,
        json={"day": 1, "answer": "   "},
    ).status_code == 422
    first_answer = client.post(
        "/api/v1/room/daily-prompt",
        headers=first_headers,
        json={"day": 1, "answer": "A slow breakfast."},
    )
    assert first_answer.status_code == 200
    assert first_answer.json()["daily_prompt"] == {
        "day": 1,
        "question": room["daily_prompt"]["question"],
        "my_answer": "A slow breakfast.",
        "partner_answer": None,
        "revealed": False,
    }
    second_view = client.get("/api/v1/room/active", headers=second_headers).json()["daily_prompt"]
    assert second_view["my_answer"] is None
    assert second_view["partner_answer"] is None
    assert second_view["revealed"] is False
    assert client.post(
        "/api/v1/room/daily-prompt",
        headers=first_headers,
        json={"day": 1, "answer": "Trying to change it."},
    ).status_code == 409

    second_answer = client.post(
        "/api/v1/room/daily-prompt",
        headers=second_headers,
        json={"day": 1, "answer": "The first rain of the season."},
    )
    assert second_answer.status_code == 200
    assert second_answer.json()["daily_prompt"]["partner_answer"] == "A slow breakfast."
    first_view = client.get("/api/v1/room/active", headers=first_headers).json()["daily_prompt"]
    assert first_view["partner_answer"] == "The first rain of the season."
    assert first_view["revealed"] is True


def test_day_one_chat_day_three_reveal_plant_progress_and_inactivity(client: TestClient):
    _, first_authorization = create_user(client, "+919876543215")
    first_headers = {"Authorization": first_authorization}
    _, second_authorization = create_user(client, "+919876543216")
    second_headers = {"Authorization": second_authorization}
    second_user = client.get("/api/v1/me", headers=second_headers).json()["user"]
    room = match_two_users(client, first_authorization, second_authorization)

    first_message = client.post(
        "/api/v1/room/messages", headers=first_headers, json={"content": "Hey, what kind of music do you like?"}
    )
    second_message = client.post(
        "/api/v1/room/messages", headers=second_headers, json={"content": "Mostly mellow indie lately."}
    )
    assert first_message.status_code == 200
    assert second_message.status_code == 200
    assert len(client.get("/api/v1/room/messages", headers=first_headers).json()["messages"]) == 2
    assert client.post("/api/v1/room/messages", headers=first_headers, json={"content": "   "}).status_code == 422

    too_early = client.post("/api/v1/room/share-more", headers=first_headers, json={"accept": True})
    assert too_early.status_code == 409

    for prompt_day in range(1, 4):
        created_at = (datetime.now(timezone.utc) - timedelta(days=prompt_day - 1, seconds=1)).isoformat()
        with main.database() as db:
            db.execute("UPDATE rooms SET created_at = ? WHERE id = ?", (created_at, room["room_id"]))
        for authorization, answer in (
            (first_authorization, f"Day {prompt_day}, something small I enjoyed."),
            (second_authorization, f"Day {prompt_day}, a quiet walk."),
        ):
            response = client.post(
                "/api/v1/room/daily-prompt",
                headers={"Authorization": authorization},
                json={"day": prompt_day, "answer": answer},
            )
            assert response.status_code == 200
        current_room = client.get("/api/v1/room/active", headers=first_headers).json()
        assert current_room["plant_growth"] == {"stage": prompt_day, "completed_days": prompt_day}

    with main.database() as db:
        db.execute(
            "UPDATE users SET last_seen_at = ? WHERE id = ?",
            ((datetime.now(timezone.utc) - timedelta(hours=25)).isoformat(), second_user["id"]),
        )
    inactive_room = client.get("/api/v1/room/active", headers=first_headers).json()
    assert inactive_room["partner_inactive_hours"] >= 25
    assert inactive_room["can_rematch"] is True

    first_share = client.post(
        "/api/v1/room/share-more", headers=first_headers, json={"accept": True}
    )
    assert first_share.status_code == 200
    assert first_share.json()["share_more"]["mutual"] is False
    first_view = client.get("/api/v1/room/active", headers=first_headers).json()
    assert first_view["share_more"]["partner_vibe_tags"] == []
    second_share = client.post(
        "/api/v1/room/share-more", headers=second_headers, json={"accept": True}
    )
    assert second_share.status_code == 200
    assert second_share.json()["share_more"]["mutual"] is True
    assert second_share.json()["status"] == "graduated"
    assert client.get("/api/v1/room/active", headers=first_headers).status_code == 404
    circles = client.get("/api/v1/circles", headers=first_headers).json()["friendships"]
    assert len(circles) == 1
    assert circles[0]["anonymous_handle"] == "quietorbit3216"
    friendship_id = circles[0]["friendship_id"]
    circle_messages = client.get(
        f"/api/v1/circles/{friendship_id}/messages", headers=first_headers
    ).json()["messages"]
    assert [message["content"] for message in circle_messages] == [
        "Hey, what kind of music do you like?",
        "Mostly mellow indie lately.",
    ]

    overview = client.get(
        "/api/v1/admin/overview", headers={"X-Admin-Token": main.ADMIN_TOKEN}
    ).json()
    assert overview["two_way_chats"] == 1
    assert overview["mutual_prompt_days"] == 3


def test_waiting_queue_cancels_and_forms_three_person_group(client: TestClient):
    with main.database() as db:
        db.execute(
            "UPDATE app_settings SET setting_value = 5 WHERE setting_key = 'matching_radius_km'"
        )
    _, first_authorization = create_user(client, "+919876543221", longitude=73.78)
    _, second_authorization = create_user(client, "+919876543222", longitude=73.85)
    _, third_authorization = create_user(client, "+919876543223", longitude=73.92)
    coordinates = [
        (first_authorization, 73.78),
        (second_authorization, 73.85),
        (third_authorization, 73.92),
    ]
    for authorization, longitude in coordinates:
        response = client.post(
            "/api/v1/match/find-companion",
            headers={"Authorization": authorization},
            json={"latitude": 18.5204, "longitude": longitude},
        )
        assert response.status_code == 200
        assert response.json()["status"] == "waiting"

    user_ids = [
        client.get("/api/v1/me", headers={"Authorization": authorization}).json()["user"]["id"]
        for authorization in (first_authorization, second_authorization, third_authorization)
    ]
    with main.database() as db:
        old_queue_time = (datetime.now(timezone.utc) - timedelta(seconds=main.GROUP_FALLBACK_AFTER_SECONDS + 1)).isoformat()
        for user_id in user_ids:
            db.execute("UPDATE match_queue SET queued_at = ? WHERE user_id = ?", (old_queue_time, user_id))

    first_status = client.get("/api/v1/match/status", headers={"Authorization": first_authorization}).json()
    assert first_status["status"] == "group"
    group_id = first_status["group"]["group_id"]
    assert first_status["group"]["member_count"] == 3
    for authorization in (second_authorization, third_authorization):
        status = client.get("/api/v1/match/status", headers={"Authorization": authorization}).json()
        assert status["status"] == "group"
        assert status["group"]["group_id"] == group_id

    message = client.post(
        "/api/v1/group/messages",
        headers={"Authorization": first_authorization},
        json={"content": "Anyone else watching the sunset?"},
    )
    assert message.status_code == 200
    group_messages = client.get(
        "/api/v1/group/messages", headers={"Authorization": third_authorization}
    ).json()["messages"]
    assert group_messages[0]["content"] == "Anyone else watching the sunset?"
    assert client.post(
        "/api/v1/group/messages",
        headers={"Authorization": second_authorization},
        json={"content": "The sky is lovely from here."},
    ).status_code == 200

    report = client.post(
        "/api/v1/group/report",
        headers={"Authorization": first_authorization},
        json={
            "reported_user_id": client.get("/api/v1/me", headers={"Authorization": second_authorization}).json()["user"]["id"],
            "reason": "Test group safety report",
        },
    )
    assert report.status_code == 200
    assert client.post(
        "/api/v1/group/block",
        headers={"Authorization": third_authorization},
        json={"blocked_user_id": client.get("/api/v1/me", headers={"Authorization": second_authorization}).json()["user"]["id"]},
    ).status_code == 200
    assert client.get("/api/v1/match/status", headers={"Authorization": third_authorization}).json()["status"] == "idle"
    assert client.get("/api/v1/match/status", headers={"Authorization": first_authorization}).json()["group"]["member_count"] == 2
    admin_headers = {"X-Admin-Token": main.ADMIN_TOKEN}
    overview = client.get("/api/v1/admin/overview", headers=admin_headers).json()
    assert overview["active_groups"] == 1
    assert overview["two_way_chats"] == 1
    groups = client.get("/api/v1/admin/groups", headers=admin_headers).json()["groups"]
    assert groups[0]["member_count"] == 2
    dissolved = client.post(f"/api/v1/admin/groups/{group_id}/dissolve", headers=admin_headers)
    assert dissolved.status_code == 200
    assert client.get("/api/v1/match/status", headers={"Authorization": first_authorization}).json()["status"] == "idle"

    _, cancel_authorization = create_user(client, "+919876543224", longitude=73.7)
    cancel_headers = {"Authorization": cancel_authorization}
    queued = client.post(
        "/api/v1/match/find-companion",
        headers=cancel_headers,
        json={"latitude": 18.52, "longitude": 73.7},
    )
    assert queued.json()["status"] == "waiting"
    assert client.delete("/api/v1/match/queue", headers=cancel_headers).json()["status"] == "cancelled"
    assert client.get("/api/v1/match/status", headers=cancel_headers).json()["status"] == "idle"


def test_room_websocket_auth_and_shared_state(client: TestClient):
    token, authorization = create_user(client, "+919876543212")
    _, second_authorization = create_user(client, "+919876543219")
    room = match_two_users(client, authorization, second_authorization)

    with client.websocket_connect(
        f"/ws/room/{room['room_id']}?token={token}"
    ) as websocket:
        connected = websocket.receive_json()
        assert connected["event"] == "presence_glow"
        spotify_track = "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC"
        websocket.send_json({"event": "update_jukebox", "track_id": spotify_track})
        update = websocket.receive_json()
        assert update["event"] == "state_sync"
        assert update["payload"]["active_track"] == spotify_track
        websocket.send_json({"event": "haptic_nudge"})
        nudge = websocket.receive_json()
        assert nudge["event"] == "haptic_nudge"
        assert nudge["payload"]["type"] == "coffee_bump"

    active = client.get(
        "/api/v1/room/active", headers={"Authorization": authorization}
    ).json()
    assert active["shared_state"]["active_track"] == spotify_track
