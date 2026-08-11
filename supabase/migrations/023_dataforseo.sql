-- ═══════════════════════════════════════════════════════════════════════════
-- AffiliateOS v7 — DataForSEO backlink-harvest module
--
-- WHY THIS EXISTS
-- The keyword-search pipeline (find-and-queue) has hit a mathematical ceiling.
-- 150 keywords × ~12 results × 3 pages of pagination ≈ 5 400 unique URLs — that
-- is the entire world it can physically see. Of ~1985 hits a day, ~1729 are
-- already-known domains thrown away by the dedup. Real output: 2-3 new sites a
-- day. Swapping the keywords buys a few thousand more URLs and hits the same
-- wall in a fortnight, and raising the frequency gets the shared egress IP
-- banned by DuckDuckGo (proven: tripling it killed the feed in two days).
--
-- So the METHOD changes, not the keywords. Every site linking to a competitor
-- bookmaker is an affiliate by definition — not "probably on topic" but
-- demonstrably monetising betting traffic, because an SEO affiliate cannot earn
-- without linking to a book. bet9ja.com alone has 18 115 referring domains;
-- fifteen competitors put the addressable pool in the hundreds of thousands.
--
-- The module runs as its OWN pipeline end to end (leads.pipeline='dataforseo'),
-- with its own send queue and its own daily limit, so it can be measured — and
-- paused — independently of the existing search pipeline.
--
-- Idempotent: safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════


-- ── Raw material: domains harvested from DataForSEO ────────────────────────
-- One row per domain, NOT per backlink. A domain met on several competitors'
-- profiles keeps ONE row and grows its intersect_count — that counter is the
-- primary sort key of the qualification queue, because linking to three books
-- at once is the single highest-precision affiliate signal available.
CREATE TABLE IF NOT EXISTS public.dfs_domains (
  id                BIGSERIAL PRIMARY KEY,
  domain            TEXT UNIQUE NOT NULL,
  source            TEXT NOT NULL,          -- referring_domains | intersection | labs_similar | serp
  seed_competitor   TEXT,                   -- whose profile it came off
  intersect_count   INTEGER DEFAULT 1,      -- how many competitors it links to ← main priority
  competitors_list  TEXT[],                 -- which ones, for the operator to eyeball
  dfs_rank          INTEGER,                -- DataForSEO rank 0-100
  spam_score        INTEGER,
  backlinks_count   INTEGER,
  referring_pages   INTEGER,
  anchor            TEXT,                   -- from backlinks/live — qualifies without a page fetch
  page_title        TEXT,                   -- from backlinks/live
  first_seen        TIMESTAMPTZ,
  status            TEXT DEFAULT 'raw',     -- raw | qualifying | qualified | rejected | promoted
  reject_reason     TEXT,
  discovered_at     TIMESTAMPTZ DEFAULT now(),
  -- When dfs-qualify took this row out of the queue. The stale-claim sweep keys
  -- on THIS, not on discovered_at: discovered_at is stamped at harvest and never
  -- moves, so a sweep against it would hand every row harvested more than the
  -- timeout ago straight back to the queue on the very next tick — defeating the
  -- claim it exists to protect.
  claimed_at        TIMESTAMPTZ,
  qualified_at      TIMESTAMPTZ
);
-- Idempotent add for databases created before this column existed.
ALTER TABLE public.dfs_domains ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
-- The queue index: exactly the ORDER BY dfs-qualify uses, so the hot path is an
-- index scan even when the table reaches hundreds of thousands of rows.
CREATE INDEX IF NOT EXISTS dfs_domains_queue
  ON public.dfs_domains (status, intersect_count DESC, dfs_rank DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS dfs_domains_status ON public.dfs_domains (status);

ALTER TABLE public.dfs_domains DISABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dfs_domains TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.dfs_domains_id_seq TO anon, authenticated;


-- ── Seed list: competitor bookmakers whose backlinks we mine ───────────────
CREATE TABLE IF NOT EXISTS public.dfs_competitors (
  id                BIGSERIAL PRIMARY KEY,
  domain            TEXT UNIQUE NOT NULL,
  brand_name        TEXT,
  geo               TEXT,
  priority          INTEGER DEFAULT 5,      -- 1 = harvest first
  total_ref_domains INTEGER,                -- total_count from the last pull, for progress display
  harvested_offset  INTEGER DEFAULT 0,      -- how far pagination got — resume point
  last_harvest_at   TIMESTAMPTZ,
  active            BOOLEAN DEFAULT TRUE,
  created_at        TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.dfs_competitors DISABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dfs_competitors TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.dfs_competitors_id_seq TO anon, authenticated;


-- ── Spend log ──────────────────────────────────────────────────────────────
-- cost_usd is the value DataForSEO returns on the response, never a local
-- estimate — the dashboard's budget figure has to be the real one.
CREATE TABLE IF NOT EXISTS public.dfs_usage (
  id             BIGSERIAL PRIMARY KEY,
  endpoint       TEXT NOT NULL,
  target         TEXT,
  rows_returned  INTEGER,
  cost_usd       NUMERIC(10,6),
  status_code    INTEGER,
  error_message  TEXT,
  created_at     TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dfs_usage_day ON public.dfs_usage (created_at DESC);

ALTER TABLE public.dfs_usage DISABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dfs_usage TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.dfs_usage_id_seq TO anon, authenticated;


-- ── Owner clusters: site portfolios behind one operator ────────────────────
-- Affiliates run portfolios. Twenty sites sharing a Google Analytics or AdSense
-- id are one owner, and one owner with twenty sites is the actual target —
-- worth far more than twenty separate cold approaches.
CREATE TABLE IF NOT EXISTS public.owner_clusters (
  id             BIGSERIAL PRIMARY KEY,
  cluster_key    TEXT UNIQUE NOT NULL,      -- GA / GTM / AdSense id
  key_type       TEXT,                      -- ga | gtm | adsense | ip
  sites_count    INTEGER DEFAULT 1,
  best_lead_id   BIGINT,
  created_at     TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS owner_clusters_size ON public.owner_clusters (sites_count DESC);

ALTER TABLE public.owner_clusters DISABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.owner_clusters TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.owner_clusters_id_seq TO anon, authenticated;


-- ── leads: carry the new pipeline's data ───────────────────────────────────
-- pipeline defaults to 'search' so every existing row stays attributed to the
-- old funnel and the two never mix in a stat.
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS pipeline            TEXT DEFAULT 'search';
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS dfs_domain_id       BIGINT REFERENCES public.dfs_domains(id);
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS analytics_ids       TEXT[];
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS owner_cluster_id    BIGINT REFERENCES public.owner_clusters(id);
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS affiliate_maturity  TEXT;    -- hobby | semi_pro | professional
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS pro_signals         JSONB;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS commercial_keywords INTEGER; -- commercial keys in the top 20
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS contact_source      TEXT;    -- homepage|partners|archive|wp_api|pattern|social
-- dfs-enrich's own claim marker. contact_source cannot serve as one: the salvage
-- pass (recover-contacts) also writes it, so claiming on it would let one
-- function permanently hide leads from the other. Each pass owns a timestamp;
-- contact_source stays purely descriptive — WHICH method found the contact.
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS enriched_at         TIMESTAMPTZ;

-- Snapshot of the link-graph evidence at qualification time. Denormalised on
-- purpose: score-leads weights it, the lead card displays it, and both would
-- otherwise need a join through dfs_domain_id on every row of every list.
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS dfs_intersect_count INTEGER;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS dfs_rank            INTEGER;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS dfs_spam_score      INTEGER;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS dfs_competitors     TEXT[];

CREATE INDEX IF NOT EXISTS leads_pipeline       ON public.leads (pipeline);
CREATE INDEX IF NOT EXISTS leads_owner_cluster  ON public.leads (owner_cluster_id) WHERE owner_cluster_id IS NOT NULL;
-- Analytics-id lookup is the cluster join; without GIN it is a full scan per lead.
CREATE INDEX IF NOT EXISTS leads_analytics_ids  ON public.leads USING GIN (analytics_ids);


-- ── Separate send queue + per-pipeline daily limits ────────────────────────
ALTER TABLE public.send_queue ADD COLUMN IF NOT EXISTS pipeline TEXT DEFAULT 'search';
ALTER TABLE public.email_log  ADD COLUMN IF NOT EXISTS pipeline TEXT DEFAULT 'search';
CREATE INDEX IF NOT EXISTS send_queue_pipeline ON public.send_queue (pipeline);
CREATE INDEX IF NOT EXISTS email_log_pipeline  ON public.email_log  (pipeline);

-- daily_limit is the PIPELINE's ceiling, spread across several sending
-- accounts — not a per-mailbox figure. 200 cold emails a day out of one Gmail
-- is a spam flag and a burnt domain inside a week; the sender divides this
-- number between accounts and ramps each one up.
CREATE TABLE IF NOT EXISTS public.pipeline_limits (
  pipeline       TEXT PRIMARY KEY,          -- 'search' | 'dataforseo'
  daily_limit    INTEGER NOT NULL,
  sent_today     INTEGER DEFAULT 0,
  last_reset     DATE DEFAULT CURRENT_DATE,
  paused         BOOLEAN DEFAULT FALSE
);
-- 'search' MUST match generate-queue's WEEKDAY_TARGET. process-queue enforces
-- this table at send time, so seeding a lower number here would silently cap the
-- existing funnel — 100 against a target of 250 is a 60% cut that would look
-- like a mysterious drop in output, not like a config value.
INSERT INTO public.pipeline_limits (pipeline, daily_limit) VALUES
  ('dataforseo', 200),
  ('search',     250)
ON CONFLICT (pipeline) DO NOTHING;

ALTER TABLE public.pipeline_limits DISABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pipeline_limits TO anon, authenticated;


-- ── Search-source health ───────────────────────────────────────────────────
-- DuckDuckGo does not announce a ban; it just starts returning thin pages. One
-- row per source per hourly window makes that visible as a falling average
-- BEFORE the feed goes to zero, which is how the last outage was only noticed
-- days later.
CREATE TABLE IF NOT EXISTS public.source_health (
  id             BIGSERIAL PRIMARY KEY,
  source         TEXT NOT NULL,             -- ddg | dataforseo_serp | serpapi
  requests       INTEGER DEFAULT 0,
  results_total  INTEGER DEFAULT 0,
  empty_results  INTEGER DEFAULT 0,
  avg_results    NUMERIC(5,2),
  throttled      BOOLEAN DEFAULT FALSE,
  throttle_until TIMESTAMPTZ,
  window_start   TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS source_health_recent ON public.source_health (source, window_start DESC);

ALTER TABLE public.source_health DISABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.source_health TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.source_health_id_seq TO anon, authenticated;


-- ── keywords: which search source a key should go to ───────────────────────
-- Layer B (corporate pages: /advertise, media kits) and layer C (exact-phrase
-- footprints like "affiliate disclosure") are things Google indexes properly
-- and DuckDuckGo handles badly, so those layers route to DataForSEO SERP.
ALTER TABLE public.keywords ADD COLUMN IF NOT EXISTS source_pref TEXT DEFAULT 'ddg';  -- ddg | dataforseo


-- ── Seed the competitor list ───────────────────────────────────────────────
-- Intersections are only run WITHIN a geo: a site linking to Bet9ja + SportyBet
-- + BetKing is a Nigerian affiliate, whereas a Nigeria×Kenya intersection
-- returns near-nothing. The geo column is what groups them for that.
INSERT INTO public.dfs_competitors (domain, brand_name, geo, priority) VALUES
  ('bet9ja.com',         'Bet9ja',      'NG',      1),
  ('sportybet.com',      'SportyBet',   'NG',      1),
  ('betking.com',        'BetKing',     'NG',      2),
  ('nairabet.com',       'NairaBet',    'NG',      3),
  ('betika.com',         'Betika',      'KE',      1),
  ('sportpesa.com',      'SportPesa',   'KE',      1),
  ('odibets.com',        'Odibets',     'KE',      2),
  ('mozzartbet.co.ke',   'Mozzartbet',  'KE',      3),
  ('betway.com.gh',      'Betway',      'GH',      1),
  ('soccabet.com',       'Soccabet',    'GH',      3),
  ('betpawa.com',        'Betpawa',     'GH',      1),
  ('premierbet.com',     'Premier Bet', 'FR_AFR',  1),
  ('1win.pro',           '1win',        'FR_AFR',  1),
  ('betclic.com',        'Betclic',     'FR_AFR',  2),
  ('sunubet.com',        'Sunubet',     'SN',      2),
  ('fortebet.ug',        'Fortebet',    'UG',      2),
  ('gsb.co.ug',          'Gal Sport',   'UG',      3),
  ('meridianbet.co.tz',  'Meridianbet', 'TZ',      3)
ON CONFLICT (domain) DO NOTHING;


-- ── Bulk upsert for the harvester ─────────────────────────────────────────
-- The harvester pulls up to 1000 rows per API call and the SAME domain arrives
-- repeatedly — once per competitor it links to. Doing that from the edge
-- function would be a select-then-write round trip per row; here it is one call
-- per batch, and the competitor merge stays atomic.
--
-- Deliberately does NOT touch `status`: a domain already rejected or promoted
-- must not fall back to 'raw' and be re-qualified on the next harvest.
CREATE OR REPLACE FUNCTION public.dfs_array_union(a TEXT[], b TEXT[])
RETURNS TEXT[] LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(
    ARRAY(SELECT DISTINCT x FROM unnest(COALESCE(a, '{}') || COALESCE(b, '{}')) AS x
          WHERE x IS NOT NULL ORDER BY x),
    '{}'::TEXT[]);
$$;

CREATE OR REPLACE FUNCTION public.dfs_upsert_domains(p_rows JSONB)
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE
  affected INTEGER;
BEGIN
  WITH incoming AS (
    SELECT * FROM jsonb_to_recordset(p_rows) AS x(
      domain          TEXT,
      source          TEXT,
      competitor      TEXT,
      dfs_rank        INTEGER,
      spam_score      INTEGER,
      backlinks_count INTEGER,
      referring_pages INTEGER,
      anchor          TEXT,
      page_title      TEXT,
      first_seen      TIMESTAMPTZ)
  ),
  -- One row per domain before the INSERT: Postgres refuses to let a single
  -- ON CONFLICT statement touch the same target row twice, and a domain
  -- linking to three competitors arrives as three rows by design.
  agg AS (
    SELECT
      i.domain,
      min(i.source)     AS source,
      min(i.competitor) AS seed_competitor,
      COALESCE(array_agg(DISTINCT i.competitor)
                 FILTER (WHERE i.competitor IS NOT NULL), '{}'::TEXT[]) AS comps,
      max(i.dfs_rank)        AS dfs_rank,
      min(i.spam_score)      AS spam_score,
      max(i.backlinks_count) AS backlinks_count,
      max(i.referring_pages) AS referring_pages,
      min(i.anchor)          AS anchor,
      min(i.page_title)      AS page_title,
      min(i.first_seen)      AS first_seen
    FROM incoming i
    WHERE i.domain IS NOT NULL AND i.domain <> ''
    GROUP BY i.domain
  )
  INSERT INTO public.dfs_domains AS d (
    domain, source, seed_competitor, intersect_count, competitors_list,
    dfs_rank, spam_score, backlinks_count, referring_pages,
    anchor, page_title, first_seen)
  SELECT
    a.domain, a.source, a.seed_competitor,
    GREATEST(COALESCE(array_length(a.comps, 1), 1), 1),
    a.comps,
    a.dfs_rank, a.spam_score, a.backlinks_count, a.referring_pages,
    a.anchor, a.page_title, a.first_seen
  FROM agg a
  ON CONFLICT (domain) DO UPDATE SET
    competitors_list = public.dfs_array_union(d.competitors_list, EXCLUDED.competitors_list),
    intersect_count  = GREATEST(
      COALESCE(array_length(
        public.dfs_array_union(d.competitors_list, EXCLUDED.competitors_list), 1), 1),
      COALESCE(d.intersect_count, 1)),
    dfs_rank         = COALESCE(EXCLUDED.dfs_rank, d.dfs_rank),
    spam_score       = COALESCE(EXCLUDED.spam_score, d.spam_score),
    backlinks_count  = GREATEST(COALESCE(EXCLUDED.backlinks_count, 0), COALESCE(d.backlinks_count, 0)),
    referring_pages  = GREATEST(COALESCE(EXCLUDED.referring_pages, 0), COALESCE(d.referring_pages, 0)),
    -- Phase C fills these in later; never overwrite an anchor we already have.
    anchor           = COALESCE(d.anchor, EXCLUDED.anchor),
    page_title       = COALESCE(d.page_title, EXCLUDED.page_title),
    first_seen       = LEAST(COALESCE(d.first_seen, EXCLUDED.first_seen),
                             COALESCE(EXCLUDED.first_seen, d.first_seen));
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;

GRANT EXECUTE ON FUNCTION public.dfs_upsert_domains(JSONB) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.dfs_array_union(TEXT[], TEXT[]) TO anon, authenticated, service_role;


COMMENT ON COLUMN public.dfs_domains.intersect_count IS
  'How many distinct competitor bookmakers this domain links to. A news site '
  'mentions one book once; only an affiliate review site links to three. This '
  'is the highest-precision signal in the module and the queue''s primary sort.';

COMMENT ON COLUMN public.dfs_domains.anchor IS
  'Anchor text of the link to the competitor. "Bet9ja promo code" qualifies a '
  'domain as an affiliate on its own, so the LLM can judge it without fetching '
  'the page — which is what makes qualifying hundreds of thousands of rows '
  'affordable.';

COMMENT ON COLUMN public.pipeline_limits.daily_limit IS
  'Ceiling for the whole pipeline, to be divided across several sending '
  'accounts with ramp-up — NOT a per-mailbox limit.';
