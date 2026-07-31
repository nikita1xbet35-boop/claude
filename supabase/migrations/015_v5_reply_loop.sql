-- ═══════════════════════════════════════════════════════════════════════════
-- AffiliateOS v5 — Reply Loop + Intelligence
-- Schema for: email validation gate (P0.1), reply listening (P0.2),
-- follow-up sequences (P0.3), lead scoring (P1.1), auto-draft replies (P1.2),
-- and A/B variant tracking (P1.4).
-- Idempotent: safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Small key/value store for cron cursors (e.g. last IMAP UID processed) ───
CREATE TABLE IF NOT EXISTS public.app_state (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ── Global suppression list ────────────────────────────────────────────────
-- One address can live in leads AND in several partner_leads bases, so an
-- unsubscribe has to be enforced in one shared place rather than per-table.
CREATE TABLE IF NOT EXISTS public.suppression_list (
  email      TEXT PRIMARY KEY,
  reason     TEXT,                    -- unsubscribe | hard_no | bounce | manual
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ── P0.1  Email validation gate ────────────────────────────────────────────
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS email_status TEXT DEFAULT 'unknown';
  -- unknown | valid | invalid | catch_all | disposable | role
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS validated_at TIMESTAMPTZ;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS validation_provider TEXT;

INSERT INTO public.api_usage (service, used, limit_value)
VALUES ('millionverifier', 0, 5000)
ON CONFLICT (service) DO NOTHING;

CREATE INDEX IF NOT EXISTS leads_email_status_idx
  ON public.leads (email_status) WHERE contact_email IS NOT NULL;

-- ── P0.2  Reply listening ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.replies (
  id              BIGSERIAL PRIMARY KEY,
  lead_id         UUID REFERENCES public.leads(id) ON DELETE SET NULL,
  email_log_id    BIGINT,
  thread_id       TEXT,               -- Message-ID this reply answers
  imap_uid        BIGINT,             -- dedup key within the mailbox
  from_email      TEXT NOT NULL,
  subject         TEXT,
  body            TEXT,
  lang            TEXT,
  received_at     TIMESTAMPTZ DEFAULT now(),
  category        TEXT,               -- interested|soft_no|hard_no|asks_fixed_fee|question|auto_reply|ooo|unsubscribe
  sentiment       TEXT,               -- positive|neutral|negative
  extracted_terms JSONB,              -- {rs_ask, fix_ask, geo:[], questions:[]}
  handled         BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- The unhandled queue is what the Hot Inbox reads on every load.
CREATE INDEX IF NOT EXISTS replies_unhandled_idx
  ON public.replies (received_at DESC) WHERE handled = FALSE;
CREATE INDEX IF NOT EXISTS replies_lead_idx ON public.replies (lead_id);
-- Re-polling the same mailbox window must not create duplicate rows.
CREATE UNIQUE INDEX IF NOT EXISTS replies_uid_uniq
  ON public.replies (imap_uid) WHERE imap_uid IS NOT NULL;

ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS replied_at     TIMESTAMPTZ;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS reply_category TEXT;

-- Matching an incoming reply back to the send it answers.
CREATE INDEX IF NOT EXISTS email_log_msgid_idx
  ON public.email_log (gmail_message_id) WHERE gmail_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS email_log_email_idx ON public.email_log (lower(email));

-- ── P0.3  Follow-up sequences (data-driven, no hardcoded timings) ──────────
CREATE TABLE IF NOT EXISTS public.sequences (
  id     BIGSERIAL PRIMARY KEY,
  name   TEXT NOT NULL,
  brand  TEXT NOT NULL,
  active BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS public.sequence_steps (
  id              BIGSERIAL PRIMARY KEY,
  sequence_id     BIGINT REFERENCES public.sequences(id) ON DELETE CASCADE,
  step_no         INTEGER NOT NULL,   -- 1=soft, 2=strong, 3=closing
  delay_days      INTEGER NOT NULL,   -- delay measured from the previous step
  template_key    TEXT NOT NULL,
  subject_variant TEXT,
  body_template   TEXT,
  UNIQUE (sequence_id, step_no)
);

ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS sequence_id     BIGINT;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS current_step    INTEGER DEFAULT 0;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS next_action_at  TIMESTAMPTZ;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS sequence_status TEXT DEFAULT 'active';
  -- active | completed | stopped | replied

ALTER TABLE public.send_queue ADD COLUMN IF NOT EXISTS sequence_id BIGINT;
ALTER TABLE public.send_queue ADD COLUMN IF NOT EXISTS step_no     INTEGER;

-- The hourly follow-up scan hits exactly this predicate.
CREATE INDEX IF NOT EXISTS leads_next_action_idx
  ON public.leads (next_action_at)
  WHERE sequence_status = 'active' AND next_action_at IS NOT NULL;

-- ── P1.1  Lead scoring ─────────────────────────────────────────────────────
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS fit_score       INTEGER;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS score_reasons   JSONB;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS geo_licensed    BOOLEAN;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS vertical        TEXT;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS competitor_book TEXT;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS exclude_reason  TEXT;
  -- occupied | competitor_owned | partner_territory

CREATE INDEX IF NOT EXISTS leads_fit_score_idx
  ON public.leads (fit_score DESC NULLS LAST)
  WHERE exclude_reason IS NULL;

-- ── P1.2  Auto-draft replies ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.draft_replies (
  id         BIGSERIAL PRIMARY KEY,
  reply_id   BIGINT REFERENCES public.replies(id) ON DELETE CASCADE,
  lead_id    UUID REFERENCES public.leads(id) ON DELETE SET NULL,
  draft_body TEXT NOT NULL,
  subject    TEXT,
  lang       TEXT,
  status     TEXT DEFAULT 'pending',  -- pending|approved|rejected|sent
  created_at TIMESTAMPTZ DEFAULT now(),
  sent_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS draft_replies_pending_idx
  ON public.draft_replies (created_at DESC) WHERE status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS draft_replies_reply_uniq ON public.draft_replies (reply_id);

-- ── P1.4  A/B variant tracking ─────────────────────────────────────────────
ALTER TABLE public.send_queue ADD COLUMN IF NOT EXISTS variant_key   TEXT;
ALTER TABLE public.email_log  ADD COLUMN IF NOT EXISTS variant_key   TEXT;
ALTER TABLE public.email_log  ADD COLUMN IF NOT EXISTS sequence_step INTEGER;

-- ── Access (this project runs with RLS off and grants to anon, like the
--    existing partner_bases tables) ───────────────────────────────────────────
ALTER TABLE public.replies         DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.draft_replies   DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.sequences       DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.sequence_steps  DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.suppression_list DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_state       DISABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.replies          TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.draft_replies    TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sequences        TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sequence_steps   TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.suppression_list TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.app_state        TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.replies_id_seq        TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.draft_replies_id_seq  TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.sequences_id_seq      TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.sequence_steps_id_seq TO anon, authenticated;

-- ── Default 3-step sequence (soft → strong → closing) ──────────────────────
-- Timings live here, so they can be retuned without a deploy.
INSERT INTO public.sequences (name, brand, active)
SELECT '1xBet RevShare — 3 касания', '1xbet', TRUE
WHERE NOT EXISTS (SELECT 1 FROM public.sequences WHERE name = '1xBet RevShare — 3 касания');

-- Copy lives in the table, not in code: retuning the follow-ups is a data edit.
-- {contact} / {geo} / {site} are substituted at send time.
INSERT INTO public.sequence_steps (sequence_id, step_no, delay_days, template_key, subject_variant, body_template)
SELECT s.id, v.step_no, v.delay_days, v.template_key, v.subject_variant, v.body_template
FROM public.sequences s
CROSS JOIN (VALUES
  (2, 4, 'strong', 'Re: partnership — quick follow-up',
E'Hi{contact},\n\nFollowing up on my note about a RevShare partnership for {site}.\n\nShort version: we pay revenue share with no admin fee, {geo} is a licensed market for us, and payouts run twice a month. Most partners we onboard there see the second month beat the first, because players keep generating after the initial deposit.\n\nIf the split is the blocker, tell me what you are on now and I will tell you straight whether we can beat it.\n\nNick\n1xPartners'),
  (3, 5, 'closing', 'Last note re: RevShare',
E'Hi{contact},\n\nLast note from me so I am not cluttering your inbox.\n\nIf a partnership for {site} is not a fit right now, no problem at all. If it is just bad timing, reply with a month and I will come back then.\n\nThe offer stays open: revenue share, no admin fee, twice-monthly payouts, {geo} fully licensed.\n\nNick\n1xPartners')
) AS v(step_no, delay_days, template_key, subject_variant, body_template)
WHERE s.name = '1xBet RevShare — 3 касания'
  AND NOT EXISTS (
    SELECT 1 FROM public.sequence_steps ss
    WHERE ss.sequence_id = s.id AND ss.step_no = v.step_no
  );
