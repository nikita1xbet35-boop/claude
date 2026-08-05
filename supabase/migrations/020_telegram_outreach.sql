-- ═══════════════════════════════════════════════════════════════════════════
-- Telegram Outreach Agent — schema
--
-- Discovery-only pipeline for public Telegram channels:
--   scan-tg-channels   → finds public t.me channels via web search, scores them
--   extract-tg-contact → reads the PUBLIC channel page, pulls the owner contact
--   draft-tg-message   → writes a personalised first message (draft only)
--   send-tg-leads      → delivers a lead card to the operator's Telegram
--
-- The system NEVER messages a channel owner. It stops at "here is a card and a
-- ready-to-paste draft" — the operator sends it by hand. Private invite links
-- (t.me/+…, t.me/joinchat/…) are filtered out at discovery and never fetched.
--
-- Idempotent: safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Discovered channels ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.telegram_channels (
  id            BIGSERIAL PRIMARY KEY,
  channel_url   TEXT UNIQUE NOT NULL,   -- canonical https://t.me/<username>
  channel_name  TEXT,
  subscribers   INTEGER,
  geo           TEXT,
  language      TEXT,                   -- ISO-ish code: en | ru | fr | pt | sw …
  niche         TEXT,                   -- betting_tips | casino | aviator | esports …
  description   TEXT,
  owner_contact TEXT,
  contact_type  TEXT,                   -- username | email | bot | none
  ai_score      INTEGER,                -- 0-100 partner fitness
  ai_reasoning  TEXT,
  -- new         — discovered, needs contact extraction
  -- no_contact  — public page carries no reachable owner contact
  -- dead        — page gone / unreachable after repeated attempts
  -- ready       — contact + draft present, waiting for a card
  -- sent_to_bot — card delivered to the operator
  -- contacted   — operator took it (they message the owner themselves)
  -- rejected    — operator (or a hard filter) dropped it
  -- No CHECK constraint on purpose: adding a state must not need a migration.
  status        TEXT DEFAULT 'new',
  draft_message TEXT,
  found_query   TEXT,                   -- which search query surfaced it
  attempts      INTEGER DEFAULT 0,      -- extraction attempts, bounds retries
  found_at      TIMESTAMPTZ DEFAULT now(),
  reviewed_at   TIMESTAMPTZ,
  contacted_at  TIMESTAMPTZ,
  notes         TEXT
);

-- The three pipeline stages all read "oldest interesting row in state X", so a
-- composite (status, ai_score DESC) serves every one of them from one index.
CREATE INDEX IF NOT EXISTS telegram_channels_status_score_idx
  ON public.telegram_channels (status, ai_score DESC);
CREATE INDEX IF NOT EXISTS telegram_channels_found_at_idx
  ON public.telegram_channels (found_at DESC);

-- ── Audit trail ────────────────────────────────────────────────────────────
-- Every state change an operator or a job makes, so "why is this channel
-- rejected" is answerable after the fact.
CREATE TABLE IF NOT EXISTS public.telegram_channel_log (
  id         BIGSERIAL PRIMARY KEY,
  channel_id BIGINT REFERENCES public.telegram_channels(id) ON DELETE CASCADE,
  action     TEXT,                      -- created | extracted | drafted | sent | taken | rejected | dead
  user_id    TEXT,                      -- Telegram user id when an operator acted
  metadata   JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS telegram_channel_log_channel_idx
  ON public.telegram_channel_log (channel_id, created_at DESC);

-- ── Search queries ─────────────────────────────────────────────────────────
-- In the table rather than in code, for the same reason keywords are: retuning
-- the discovery angles is a data edit, not a deploy. Yield columns make a dead
-- query visible instead of it silently burning search budget.
CREATE TABLE IF NOT EXISTS public.tg_search_queries (
  id             BIGSERIAL PRIMARY KEY,
  query          TEXT UNIQUE NOT NULL,
  active         BOOLEAN DEFAULT TRUE,
  runs           INTEGER DEFAULT 0,
  channels_found INTEGER DEFAULT 0,
  last_run_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tg_search_queries_rotation_idx
  ON public.tg_search_queries (last_run_at NULLS FIRST) WHERE active;

-- ── Access (RLS off + grants to anon, matching the rest of this project) ────
ALTER TABLE public.telegram_channels    DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.telegram_channel_log DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.tg_search_queries    DISABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.telegram_channels    TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.telegram_channel_log TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tg_search_queries    TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.telegram_channels_id_seq    TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.telegram_channel_log_id_seq TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.tg_search_queries_id_seq    TO anon, authenticated;

-- ── Seed queries ───────────────────────────────────────────────────────────
-- site:t.me keeps the result set on public channel pages instead of the whole
-- web, which is what makes a free DuckDuckGo query usable here at all.
-- African GEOs first (the current focus), plus a few generic angles.
INSERT INTO public.tg_search_queries (query)
SELECT q FROM (VALUES
  ('site:t.me betting tips nigeria'),
  ('site:t.me sports predictions nigeria channel'),
  ('site:t.me aviator predictions nigeria'),
  ('site:t.me 1xbet promo code nigeria'),
  ('site:t.me betting tips kenya'),
  ('site:t.me sportpesa jackpot predictions kenya'),
  ('site:t.me aviator signals kenya'),
  ('site:t.me betting tips ghana'),
  ('site:t.me sure odds ghana channel'),
  ('site:t.me betting tips tanzania'),
  ('site:t.me betting tips uganda'),
  ('site:t.me betting tips zambia'),
  ('site:t.me betting tips cameroun pronostics'),
  ('site:t.me pronostics paris sportifs senegal'),
  ('site:t.me pronostics foot cote d''ivoire'),
  ('site:t.me apostas desportivas angola'),
  ('site:t.me apostas mocambique palpites'),
  ('site:t.me mchezo kubashiri mpira'),
  ('site:t.me sure odds daily free tips'),
  ('site:t.me fixed odds football predictions africa'),
  ('site:t.me casino slots bonus africa'),
  ('site:t.me aviator predictor free signals'),
  ('site:t.me esports betting tips'),
  ('site:t.me crypto betting signals africa'),
  ('site:t.me premier league betting tips channel'),
  ('site:t.me champions league accumulator tips'),
  ('site:t.me betting affiliate partners africa'),
  ('site:t.me odds bonus promo channel africa')
) AS v(q)
ON CONFLICT (query) DO NOTHING;
