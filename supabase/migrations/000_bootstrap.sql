-- 000_bootstrap — ad-hoc column adds that used to live inline in the deploy
-- workflow as raw curl calls. Moved here so every schema change lives in one
-- place and the workflow can just loop over this directory.
-- Runs on every deploy; all statements are idempotent.

ALTER TABLE public.search_presets ADD COLUMN IF NOT EXISTS brand TEXT DEFAULT NULL;
ALTER TABLE public.leads          ADD COLUMN IF NOT EXISTS found_keyword TEXT DEFAULT NULL;

-- Custom (non-default) presets are regenerated from code on each deploy.
DELETE FROM public.search_presets WHERE is_default = false;
