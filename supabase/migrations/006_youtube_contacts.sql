-- Migration 006: YouTube contact base
-- The YouTube pipeline stores channels in telegram_channels (partner_type='youtube').
-- Add the contact columns the youtube-search function fills so the dashboard tab can
-- show every contact we found per channel (email / Telegram / WhatsApp / links).
-- Idempotent — safe to re-run; the table was created manually in Supabase.

ALTER TABLE public.telegram_channels
  ADD COLUMN IF NOT EXISTS email       text,
  ADD COLUMN IF NOT EXISTS telegram    text,
  ADD COLUMN IF NOT EXISTS whatsapp    text,
  ADD COLUMN IF NOT EXISTS links       jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS geo         text,
  ADD COLUMN IF NOT EXISTS language    text,
  ADD COLUMN IF NOT EXISTS subscribers bigint DEFAULT 0,
  ADD COLUMN IF NOT EXISTS yt_status   text DEFAULT 'new',   -- manual workflow: new / contacted / skipped
  ADD COLUMN IF NOT EXISTS created_at  timestamptz DEFAULT now();

-- Fast lookups by channel URL (the stable identifier — handles are optional).
-- Not UNIQUE: the table already holds Telegram rows and may contain historical
-- duplicates; youtube-search de-dupes by URL in code before inserting.
CREATE INDEX IF NOT EXISTS telegram_channels_url_idx
  ON public.telegram_channels (url);
