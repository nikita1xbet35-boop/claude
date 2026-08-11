-- ═══════════════════════════════════════════════════════════════════════════
-- Fix: intersection harvests always re-bought the same page
--
-- The broad phase (referring_domains) walks harvested_offset forward on every
-- call, so a second run reaches deeper into the profile. The intersection
-- phase never did that — its request always sent offset: 0 — so every run,
-- however many times it was pressed, re-fetched the exact same top rows by
-- rank. Those rows were already in dfs_domains from the first run and already
-- through dfs-qualify (rejected or promoted), so the upsert just touched
-- existing rows: DataForSEO charged for the call, and the queue gained nothing
-- new. That is what "потратил $0.1, но ничего не выдало" actually was.
--
-- One row per GEO (not per competitor — an intersection is keyed on the geo's
-- target pair, not on a single domain) tracking how far that geo's pagination
-- has gone.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.dfs_intersect_state (
  geo               TEXT PRIMARY KEY,
  harvested_offset  INTEGER DEFAULT 0,
  total_count       INTEGER,
  last_harvest_at   TIMESTAMPTZ
);

ALTER TABLE public.dfs_intersect_state DISABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dfs_intersect_state TO anon, authenticated, service_role;

COMMENT ON TABLE public.dfs_intersect_state IS
  'Pagination state for the intersection harvest phase, one row per geo. '
  'Mirrors dfs_competitors.harvested_offset, which serves the same purpose for '
  'the broad (referring_domains) phase — intersections are keyed on a geo''s '
  'target pair rather than a single competitor, so they need their own table '
  'rather than a column on dfs_competitors.';
