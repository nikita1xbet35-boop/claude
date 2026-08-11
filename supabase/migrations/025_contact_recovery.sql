-- ═══════════════════════════════════════════════════════════════════════════
-- Contact recovery for the leads that came back empty
--
-- ~4000 sites in the base have no contact at all. They were found, judged
-- relevant, and then dropped on the floor because the homepage walk found no
-- address — and among them sits real traffic. The homepage is simply not the
-- only place a contact exists:
--
--   * Affiliates HIDE their address over time. Wayback snapshots from 2021-2023
--     routinely still carry it in plain text. Free, and the single highest-yield
--     source of the lot.
--   * Most affiliate sites run WordPress, and many leave /wp-json/wp/v2/users
--     open. That gives an author NAME — a person to find and message directly,
--     which beats info@ by a wide margin.
--   * Footer social links are often a warmer channel than email anyway.
--
-- contact_recovery_at is a SEPARATE marker from contact_source on purpose:
-- dfs-enrich claims rows by `contact_source IS NULL`, so reusing that column
-- here would have the two functions fighting over the same leads.
--
-- Idempotent: safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS contact_recovery_at TIMESTAMPTZ;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS contact_person      TEXT;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS contact_socials     TEXT[];

-- The recovery queue: no address, never attempted. Partial index because the
-- rows that matter are a shrinking minority of the table.
CREATE INDEX IF NOT EXISTS leads_recovery_queue
  ON public.leads (fit_score DESC NULLS LAST)
  WHERE contact_email IS NULL AND contact_recovery_at IS NULL;

COMMENT ON COLUMN public.leads.contact_recovery_at IS
  'When the salvage pass (archive.org / WP API / socials) last ran for this lead. '
  'Set even when nothing is found, so a dead site is attempted once rather than '
  'on every tick. Deliberately separate from contact_source, which dfs-enrich '
  'uses as its own claim marker.';

COMMENT ON COLUMN public.leads.contact_person IS
  'Author name from the site''s open WordPress users endpoint. A name plus a '
  'domain is enough to find the human on LinkedIn/X and open a direct '
  'conversation instead of mailing info@.';
