-- Telegram outreach: track channel freshness.
--
-- extract-tg-contact already reads the public post feed (t.me/s/<name>) to find
-- an owner contact; the newest post's timestamp is sitting right there in the
-- same page and was simply never kept. Without it there was no way to tell a
-- channel that posts daily from one abandoned a year ago — both looked
-- identical in the base once a contact was on file.
--
-- Idempotent: safe to re-run.

ALTER TABLE public.tg_outreach_channels
  ADD COLUMN IF NOT EXISTS last_post_at TIMESTAMPTZ;

COMMENT ON COLUMN public.tg_outreach_channels.last_post_at IS
  'Timestamp of the newest post in the public preview feed at extraction time. '
  'NULL means the feed could not be read (preview disabled, fetch failed) — '
  'freshness is unknown, not zero, and the stale filter does not fire on it.';

CREATE INDEX IF NOT EXISTS tg_outreach_channels_last_post_idx
  ON public.tg_outreach_channels (last_post_at DESC NULLS LAST);
