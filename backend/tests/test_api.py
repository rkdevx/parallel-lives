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


def create_user(client: TestClient, phone: str = "+919876543210") -> tuple[str, str]:
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
            "handle": "quietorbit",
            "neighborhood": "Baner",
            "latitude": 18.5204,
            "longitude": 73.8567,
            "vibes": ["music", "coffee"],
        },
    )
    assert profile.status_code == 200
    assert profile.json()["user"]["latitude"] == 18.5204
    assert profile.json()["user"]["longitude"] == 73.8567
    return token, headers["Authorization"]


def test_room_lifecycle_assets_circle_and_moderation(client: TestClient):
    token, authorization = create_user(client)
    headers = {"Authorization": authorization}

    matched = client.post(
        "/api/v1/match/find-companion",
        headers=headers,
        json={"latitude": 18.5204, "longitude": 73.8567, "vibe_filters": ["music"]},
    )
    assert matched.status_code == 200
    room = matched.json()
    room_id = room["room_id"]
    assert room["demo_companion"] is True
    assert room["partner"]["verification_tier"] == "demo"
    assert room["days_until_unmask"] == 9

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
    assert watered.json()["shared_state"]["plant_health"] == 91
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
    graduated = client.post(
        "/api/v1/room/unmask-opt-in", headers=headers, json={"accept": True}
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
    assert len(messages) == 2
    assert "simulated companion" in messages[1]["content"]

    overview = client.get(
        "/api/v1/admin/overview", headers={"X-Admin-Token": main.ADMIN_TOKEN}
    )
    assert overview.status_code == 200
    assert overview.json()["users"] == 1
    assert overview.json()["graduated_friendships"] == 1
    assert overview.json()["open_reports"] == 1
    admin_headers = {"X-Admin-Token": main.ADMIN_TOKEN}
    assert client.get("/api/v1/admin/settings", headers=admin_headers).json() == {
        "matching_radius_km": 5,
        "unmask_day_threshold": 10,
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
        json={"matching_radius_km": 26, "unmask_day_threshold": 12},
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
    assert listed_users.json()["users"][0]["vibe_score"] == 78

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
    assert rematch.json()["room_id"] != room_id
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
    again = client.post(
        "/api/v1/match/find-companion",
        headers=headers,
        json={"latitude": 18.5204, "longitude": 73.8567},
    )
    assert again.status_code == 200
    assert again.json()["room_id"] == matched.json()["room_id"]


def test_room_websocket_auth_and_shared_state(client: TestClient):
    token, authorization = create_user(client, "+919876543212")
    room = client.post(
        "/api/v1/match/find-companion",
        headers={"Authorization": authorization},
        json={"latitude": 18.5204, "longitude": 73.8567},
    ).json()

    with client.websocket_connect(
        f"/ws/room/{room['room_id']}?token={token}"
    ) as websocket:
        connected = websocket.receive_json()
        assert connected["event"] == "presence_glow"
        websocket.send_json({"event": "update_jukebox", "track_id": "Night Bloom"})
        update = websocket.receive_json()
        assert update["event"] == "state_sync"
        assert update["payload"]["active_track"] == "Night Bloom"
        websocket.send_json({"event": "haptic_nudge"})
        nudge = websocket.receive_json()
        assert nudge["event"] == "haptic_nudge"
        assert nudge["payload"]["type"] == "coffee_bump"

    active = client.get(
        "/api/v1/room/active", headers={"Authorization": authorization}
    ).json()
    assert active["shared_state"]["active_track"] == "Night Bloom"
