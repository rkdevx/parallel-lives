# Parallel Lives

Parallel Lives is an early-stage social app MVP built around slow, anonymous, one-to-one connections. Two people meet in a private room, chat and save shared moments on an evolving island. If both choose to stay connected, their chat moves to Circle.

## Product flow

1. **Find one companion.** Matching uses the user's submitted location inside the Pune service area. A person can have only one active island at a time. There is no group fallback.
2. **Build a shared island.** People can chat, answer a daily prompt, save notes and photos, and explore the island together. Photos are limited to one per person every 24 hours.
3. **Choose on day 3.** Each person can choose to continue together. Both must say yes to enter Circle. If one person declines, or the other person does not respond within 24 hours of the first yes, the room and its shared content are deleted.
4. **Stay in touch in Circle.** Circle connections have a private one-to-one chat and a continuation option for 7 days after joining. One person can invite the other; the second person has 24 hours to agree. If both agree, the original room reopens with its existing history and memories. The 7-day window controls whether the world can be reopened; it does not currently trigger automatic deletion of an archived connection.
5. **Manage a connection.** Remove deletes the friendship and shared room data for both people. Block also prevents future matching. Report saves the selected reason for moderation, blocks future matching, and deletes shared room data. Reports are retained for review.

The Circle screen is intentionally focused on chat, the 7-day continuation option, and connection controls. It does not show an archived-memory browser.

## Project layout

- `backend/` — FastAPI API, SQLite runtime database, photo storage, and API tests
- `backend/app/schema.sql` — PostgreSQL/PostGIS starting point for a future hosted database; the local app does not use this file
- `mobile/` — Expo React Native app
- `admin/` — Next.js admin dashboard

The SQLite database is created automatically at `backend/app/parallel_lives.db`. Uploaded photos are stored under `backend/app/media/`. Set `PARALLEL_LIVES_DB` to use a different database file; media files are stored beside that database in a `media` directory.

## Requirements

- Python 3.10 or newer
- Node.js and npm compatible with the pinned Expo and Next.js versions
- Expo Go or an Android/iOS simulator for mobile development

## Run the API

In PowerShell:

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

API documentation: <http://localhost:8000/docs>  
Health check: <http://localhost:8000/health>

The local OTP is `123456`; no SMS is sent. The development admin token is `dev-admin-token`.

## Run the mobile app

In another PowerShell window:

```powershell
cd mobile
npm install
npx expo start
```

The default API URL is `http://10.0.2.2:8000` for the Android emulator. For an iOS Simulator, use `http://localhost:8000`. For a physical device, use the development computer's LAN IP. Set the URL before starting Expo, for example:

```powershell
$env:EXPO_PUBLIC_API_URL = "http://192.168.1.20:8000"
npx expo start
```

The app requests foreground location permission for matching. Precise coordinates are used for distance calculations and are not displayed to the companion. A Pune test-location shortcut is available only in development builds on Android.

## Run the admin dashboard

In another PowerShell window:

```powershell
cd admin
npm install
$env:NEXT_PUBLIC_API_URL = "http://localhost:8000"
npm run dev
```

Open <http://localhost:3000> and enter the admin token. If the API uses a different address, update `NEXT_PUBLIC_API_URL` before starting the dashboard.

## Configuration

| Variable | Used by | Default | Purpose |
| --- | --- | --- | --- |
| `PARALLEL_LIVES_DB` | API | `backend/app/parallel_lives.db` | SQLite database location |
| `PARALLEL_LIVES_ADMIN_TOKEN` | API and admin dashboard | `dev-admin-token` | Protects admin endpoints and dashboard |
| `PARALLEL_LIVES_DEMO_OTP` | API | `123456` | Local development OTP |
| `EXPO_PUBLIC_API_URL` | Mobile | `http://10.0.2.2:8000` | API address used by the app |
| `NEXT_PUBLIC_API_URL` | Admin dashboard | `http://localhost:8000` | API address used by the admin app |

## Run backend tests

```powershell
cd backend
python -m pip install -r requirements.txt
python -m pytest
```

## Prototype limitations

This project is a local MVP, not a production-ready social network. OTP delivery is simulated, sessions use prototype bearer tokens, and real-person matching depends on another active user being available. Location matching checks submitted coordinates against hard-coded Pune bounds; it does not verify location independently. The admin token is a shared development credential unless replaced.

Before public use, add production authentication and authorization, reliable data retention and deletion jobs, protected media storage, abuse and image moderation, verified location and identity checks, rate limiting, secure admin access, backups, and operational monitoring. Do not expose the development service publicly or use real personal data until those protections are in place.
