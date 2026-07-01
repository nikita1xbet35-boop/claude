-- AffiliateOS — Migration 005: watchdog agent log
-- Records every observation, auto-action, and approval-gated proposal from the
-- Claude-based watchdog agent (Block 3). Idempotent.

CREATE TABLE IF NOT EXISTS public.agent_log (
  id            BIGSERIAL PRIMARY KEY,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  level         SMALLINT NOT NULL,          -- 1 observer, 2 advisor(approval), 3 autopilot
  kind          TEXT NOT NULL,              -- anomaly / action key
  summary       TEXT,                       -- what was detected (deterministic)
  diagnosis     TEXT,                       -- Claude-written explanation (optional)
  action        TEXT,                       -- action key taken (L3) or proposed (L2)
  status        TEXT NOT NULL,              -- alerted | auto_done | pending_approval | approved | rejected | failed
  result        TEXT,                       -- outcome of an executed action
  tg_message_id BIGINT                      -- Telegram message id (to edit after a decision)
);

CREATE INDEX IF NOT EXISTS agent_log_created ON public.agent_log (created_at DESC);
CREATE INDEX IF NOT EXISTS agent_log_status  ON public.agent_log (status);
