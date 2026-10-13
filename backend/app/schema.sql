-- PostgreSQL/PostGIS deployment schema draft. The runnable local MVP uses SQLite.
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone_number VARCHAR(16) UNIQUE NOT NULL,
    anonymous_handle VARCHAR(30) NOT NULL DEFAULT '',
    neighborhood_tag VARCHAR(80) NOT NULL DEFAULT '',
    location GEOGRAPHY(Point, 4326),
    vibe_tags JSONB NOT NULL DEFAULT '[]'::jsonb,
    verification_tier VARCHAR(20) NOT NULL DEFAULT 'unverified',
    vibe_score INTEGER NOT NULL DEFAULT 100 CHECK (vibe_score BETWEEN 0 AND 100),
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    is_banned BOOLEAN NOT NULL DEFAULT FALSE,
    is_shadow_banned BOOLEAN NOT NULL DEFAULT FALSE,
    is_muted BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_users_location ON users USING GIST (location);

CREATE TABLE sessions (
    token_hash BYTEA PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE app_settings (
    setting_key VARCHAR(40) PRIMARY KEY,
    setting_value INTEGER NOT NULL,
    CHECK (
        (setting_key = 'matching_radius_km' AND setting_value BETWEEN 1 AND 25)
        OR (setting_key = 'unmask_day_threshold' AND setting_value BETWEEN 1 AND 30)
    )
);
INSERT INTO app_settings (setting_key, setting_value) VALUES
    ('matching_radius_km', 5),
    ('unmask_day_threshold', 10);

CREATE TABLE active_rooms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user1_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user2_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    room_level INTEGER NOT NULL DEFAULT 1,
    shared_state JSONB NOT NULL DEFAULT
        '{"plant_health":100,"active_track":null,"theme":"default"}'::jsonb,
    status VARCHAR(16) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'dissolved', 'graduated')),
    user1_vote BOOLEAN,
    user2_vote BOOLEAN,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    dissolved_at TIMESTAMPTZ,
    CHECK (user1_id <> user2_id)
);

CREATE UNIQUE INDEX one_active_room_per_user1
    ON active_rooms(user1_id) WHERE status = 'active';
CREATE UNIQUE INDEX one_active_room_per_user2
    ON active_rooms(user2_id) WHERE status = 'active';

CREATE FUNCTION enforce_one_active_room_per_user() RETURNS trigger AS $$
BEGIN
    PERFORM id FROM users
    WHERE id IN (NEW.user1_id, NEW.user2_id)
    ORDER BY id
    FOR UPDATE;
    IF NEW.status = 'active' AND EXISTS (
        SELECT 1 FROM active_rooms existing
        WHERE existing.id <> NEW.id
          AND existing.status = 'active'
          AND (
              existing.user1_id IN (NEW.user1_id, NEW.user2_id)
              OR existing.user2_id IN (NEW.user1_id, NEW.user2_id)
          )
    ) THEN
        RAISE EXCEPTION 'a user may only have one active room';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_one_active_room
    BEFORE INSERT OR UPDATE OF user1_id, user2_id, status ON active_rooms
    FOR EACH ROW EXECUTE FUNCTION enforce_one_active_room_per_user();

CREATE TABLE room_assets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id UUID NOT NULL REFERENCES active_rooms(id) ON DELETE CASCADE,
    author_id UUID NOT NULL REFERENCES users(id),
    asset_type VARCHAR(20) NOT NULL CHECK
        (asset_type IN ('sticky_note', 'polaroid', 'jukebox_track')),
    content VARCHAR(140),
    media_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_day DATE NOT NULL DEFAULT ((CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date)
);
CREATE UNIQUE INDEX one_polaroid_per_user_per_day
    ON room_assets(room_id, author_id, created_day)
    WHERE asset_type = 'polaroid';

CREATE TABLE daily_actions (
    room_id UUID NOT NULL REFERENCES active_rooms(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id),
    action_date DATE NOT NULL DEFAULT CURRENT_DATE,
    action VARCHAR(40) NOT NULL,
    PRIMARY KEY (room_id, user_id, action_date, action)
);

CREATE TABLE friendships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user1_id UUID NOT NULL REFERENCES users(id),
    user2_id UUID NOT NULL REFERENCES users(id),
    archived_room_snapshot JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (user1_id <> user2_id)
);

CREATE UNIQUE INDEX unique_friendship_pair
    ON friendships (LEAST(user1_id, user2_id), GREATEST(user1_id, user2_id));

CREATE TABLE messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    friendship_id UUID NOT NULL REFERENCES friendships(id) ON DELETE CASCADE,
    author_id UUID NOT NULL REFERENCES users(id),
    content VARCHAR(2000) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id UUID REFERENCES active_rooms(id) ON DELETE SET NULL,
    reporter_id UUID NOT NULL REFERENCES users(id),
    reported_user_id UUID NOT NULL REFERENCES users(id),
    reason VARCHAR(500) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'open',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
