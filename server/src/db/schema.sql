-- GST Tracker Database Schema (idempotent — safe to run multiple times)

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Contacts being tracked
CREATE TABLE IF NOT EXISTS contacts (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    phone       VARCHAR(20) NOT NULL UNIQUE,
    name        VARCHAR(100) NOT NULL,
    jid         VARCHAR(50) NOT NULL UNIQUE,  -- phone@s.whatsapp.net
    is_active   BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Raw presence transition events
CREATE TABLE IF NOT EXISTS presence_logs (
    id          BIGSERIAL PRIMARY KEY,
    contact_id  UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    status      VARCHAR(10) NOT NULL CHECK (status IN ('online', 'offline')),
    timestamp   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_presence_logs_contact_time ON presence_logs(contact_id, timestamp DESC);

-- Computed online sessions (start -> end)
CREATE TABLE IF NOT EXISTS sessions (
    id          BIGSERIAL PRIMARY KEY,
    contact_id  UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    start_time  TIMESTAMPTZ NOT NULL,
    end_time    TIMESTAMPTZ,
    duration_s  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_contact_time ON sessions(contact_id, start_time DESC);

-- Pre-aggregated daily analytics
CREATE TABLE IF NOT EXISTS daily_stats (
    id              BIGSERIAL PRIMARY KEY,
    contact_id      UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    date            DATE NOT NULL,
    total_online_s  INTEGER NOT NULL DEFAULT 0,
    session_count   INTEGER NOT NULL DEFAULT 0,
    first_seen      TIME,
    last_seen       TIME,
    peak_hour       SMALLINT,
    UNIQUE(contact_id, date)
);
CREATE INDEX IF NOT EXISTS idx_daily_stats_contact_date ON daily_stats(contact_id, date DESC);

-- Push notification subscriptions
CREATE TABLE IF NOT EXISTS push_subscriptions (
    id              BIGSERIAL PRIMARY KEY,
    endpoint        TEXT NOT NULL UNIQUE,
    keys_p256dh     TEXT NOT NULL,
    keys_auth       TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
