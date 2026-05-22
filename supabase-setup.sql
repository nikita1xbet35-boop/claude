-- AffiliateOS v4 — Supabase Setup SQL
-- Run once in Supabase SQL Editor

-- ─────────────────────────────────────────────────────────────────────────────
-- api_usage: track per-service API consumption
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS api_usage (
  id              BIGSERIAL PRIMARY KEY,
  service         TEXT NOT NULL UNIQUE,  -- 'serpapi','groq','gmail_main','gmail_lp','jina'
  used            INTEGER NOT NULL DEFAULT 0,
  limit_value     INTEGER NOT NULL,
  reset_period    TEXT NOT NULL DEFAULT 'daily',  -- 'daily' or 'monthly'
  last_reset_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  alert_sent_warning  BOOLEAN DEFAULT FALSE,
  alert_sent_critical BOOLEAN DEFAULT FALSE,
  paused          BOOLEAN DEFAULT FALSE,
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO api_usage (service, used, limit_value, reset_period) VALUES
  ('serpapi',    0, 100,   'monthly'),
  ('groq',       0, 6000,  'daily'),
  ('gmail_main', 0, 100,   'daily'),
  ('gmail_lp',   0, 100,   'daily'),
  ('jina',       0, 500,   'daily')
ON CONFLICT (service) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- email_log: track every sent email + bounces
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_log (
  id               BIGSERIAL PRIMARY KEY,
  lead_id          UUID REFERENCES leads(id) ON DELETE SET NULL,
  email            TEXT NOT NULL,
  brand            TEXT,
  subject          TEXT,
  gmail_account    TEXT,  -- 'main' or 'lp'
  sent_at          TIMESTAMPTZ DEFAULT NOW(),
  bounced          BOOLEAN DEFAULT FALSE,
  bounce_reason    TEXT,
  gmail_message_id TEXT
);

-- ─────────────────────────────────────────────────────────────────────────────
-- send_queue: scheduled outgoing emails
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS send_queue (
  id            BIGSERIAL PRIMARY KEY,
  lead_id       UUID REFERENCES leads(id) ON DELETE CASCADE,
  brand         TEXT NOT NULL,
  gmail_account TEXT NOT NULL DEFAULT 'main',
  scheduled_at  TIMESTAMPTZ NOT NULL,
  sent_at       TIMESTAMPTZ,
  status        TEXT DEFAULT 'pending',  -- pending, sent, failed, skipped
  error         TEXT,
  retry_count   INTEGER DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS send_queue_scheduled
  ON send_queue (scheduled_at)
  WHERE status = 'pending';

-- ─────────────────────────────────────────────────────────────────────────────
-- error_log: system events and errors
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS error_log (
  id         BIGSERIAL PRIMARY KEY,
  level      TEXT NOT NULL,  -- 'error', 'warning', 'info'
  service    TEXT,
  message    TEXT NOT NULL,
  lead_id    UUID,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS error_log_created
  ON error_log (created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- auto_search_status: track autonomous search state
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE api_usage ADD COLUMN IF NOT EXISTS system_paused BOOLEAN DEFAULT FALSE;
