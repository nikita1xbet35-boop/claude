-- AffiliateOS — Migration 004: propagate `source` across the pipeline
-- Standardizes leads.source to 'seo' (was default 'search'), and adds a `source`
-- column to send_queue / email_log / form_submissions so sends can be counted
-- per source (seo / youtube / appstore). Idempotent.

-- Normalize existing lead sources to the spec's vocabulary.
UPDATE public.leads SET source = 'seo' WHERE source IS NULL OR source = 'search';
ALTER TABLE public.leads ALTER COLUMN source SET DEFAULT 'seo';

-- Carry source through the send path. Existing rows all predate youtube/appstore,
-- so the 'seo' default is correct for the backfill.
ALTER TABLE public.send_queue       ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'seo';
ALTER TABLE public.email_log        ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'seo';
ALTER TABLE public.form_submissions ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'seo';

CREATE INDEX IF NOT EXISTS email_log_source ON public.email_log (source);
CREATE INDEX IF NOT EXISTS email_log_sent_at ON public.email_log (sent_at);
