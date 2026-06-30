-- AffiliateOS — Migration 002: contact-form delivery channel
-- Adds a second outreach channel (website contact form) for leads without email.
-- Idempotent: safe to run multiple times.

-- ── leads: form-channel state ───────────────────────────────────────────────
-- form_status:
--   NULL            — not yet checked
--   'simple'        — simple HTML form found, ready to auto-submit
--   'manual_required' — captcha / JS-rendered / non-standard required fields → human handles it
--   'no_form'       — no usable form found
--   'submitted'     — form successfully submitted
--   'failed'        — submission failed twice, give up
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS form_status   TEXT    DEFAULT NULL;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS form_url      TEXT    DEFAULT NULL;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS form_fields   JSONB   DEFAULT NULL;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS form_attempts INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS leads_form_status ON public.leads (form_status);

-- ── form_submissions: log of every form-channel send attempt ─────────────────
CREATE TABLE IF NOT EXISTS public.form_submissions (
  id              BIGSERIAL PRIMARY KEY,
  lead_id         UUID REFERENCES public.leads(id) ON DELETE SET NULL,
  channel         TEXT NOT NULL DEFAULT 'form',
  url             TEXT,                 -- the lead site
  form_url        TEXT,                 -- the page the form lived on
  form_action     TEXT,                 -- the POST endpoint
  status          TEXT NOT NULL,        -- 'sent' | 'failed'
  http_status     INTEGER,
  response_snippet TEXT,
  submitted_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS form_submissions_submitted ON public.form_submissions (submitted_at DESC);
CREATE INDEX IF NOT EXISTS form_submissions_lead       ON public.form_submissions (lead_id);

-- ── api_usage: daily quota for the form channel (starts conservative) ────────
INSERT INTO public.api_usage (service, used, limit_value, reset_period)
VALUES ('form_main', 0, 50, 'daily')
ON CONFLICT (service) DO NOTHING;
