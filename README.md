# Parallel Lives (DualWorld)

Parallel Lives is a geo-fenced social app prototype built around anonymous one-to-one rooms, shared small activities, and a mutual day-10 graduation.

## What works in this MVP

- FastAPI backend with persistent SQLite storage, bearer-token sessions, Pune geo-fencing, and a one-active-room constraint
- Anonymous profile setup and a clearly labeled simulated companion so the app can be tried with one person
- Room notes, photo polaroids with EXIF stripping and a one-per-day limit, once-daily plant watering, live WebSocket nudges and jukebox state
- Ten-day unmask opt-in, mutual graduation, a post-graduation circle and working message endpoints
- Safety reports and an admin dashboard with live community counts, user controls, room dissolution, and matching/graduation settings
- Expo app with phone/OTP onboarding, location permission flow, room UI, circle, and profile screens

The SQLite database is created automatically at `backend/app/parallel_lives.db`. `backend/app/schema.sql` is a PostgreSQL/PostGIS migration starting point for a later hosted deployment; it is not used by the local SQLite runtime.

## Requirements

- Python 3.10 or newer
- Node.js 18.18 or newer and npm
- Expo Go or an Android/iOS simulator for the mobile app

## Start the API (Windows PowerShell)

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Interactive API documentation is available at <http://localhost:8000/docs>; health check: <http://localhost:8000/health>.

Local OTP is `123456`. No SMS is sent. The local admin token is `dev-admin-token`; set `PARALLEL_LIVES_ADMIN_TOKEN` to change it. Configure `PARALLEL_LIVES_DB` to store the SQLite file elsewhere.

## Start the admin dashboard

In a second terminal:

```powershell
cd admin
npm install
npm run dev
```

Open <http://localhost:3000> and enter the admin token. In PowerShell, set `$env:NEXT_PUBLIC_API_URL = "http://localhost:8000"` before `npm run dev` if the API is hosted elsewhere.

## Start the mobile app

In another terminal:

```powershell
cd mobile
npm install
npx expo start
```

The default API URL is `http://10.0.2.2:8000` for the Android emulator. For iOS Simulator or web, set `$env:EXPO_PUBLIC_API_URL = "http://localhost:8000"` in PowerShell before `npx expo start`. For a physical device, use your development computer's LAN IP, for example `$env:EXPO_PUBLIC_API_URL = "http://192.168.1.20:8000"`.

The app requests foreground location permission to confirm the Pune service area. Precise coordinates are used for the distance calculation but are not displayed to a companion.

## Run backend tests

```powershell
cd backend
python -m pip install -r requirements.txt
python -m pytest
```

## Important prototype limitations

This is a local MVP, not a production-ready social network. The OTP is a development code, sessions are prototype bearer tokens, and the simulated companion is not a real user. The demo companion automatically accepts day-10 unmasking and gives an explicitly simulated chat reply so the full lifecycle can be previewed. Geo checks validate submitted coordinates against the Pune bounds; IP-based location verification and real-person matching are not configured. Real SMS/phone verification, liveness and duplicate-account detection, automated image moderation, Spotify playback, Redis scaling, and production admin identity/access management are also not configured. The liveness endpoint intentionally returns `501` rather than pretending to verify a selfie.

Do not expose this service publicly or use real personal data until production authentication, authorization, storage, privacy, and moderation providers are configured.