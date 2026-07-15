-- Migration 008: partner bases (isolated lead bases for warm/RevShare outreach)
-- These bases must NEVER mix with the cold flow (SEO/YouTube/forms) or each other:
-- each base has its own template, its own daily send limit, its own stats, and its
-- own pause/start toggle. Auto-send is OFF by default after import.

CREATE TABLE IF NOT EXISTS public.partner_bases (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL UNIQUE,          -- e.g. "888starz"
  template_subject text,                          -- per-base email subject
  template_body    text,                          -- per-base email body (angle differs per base)
  daily_limit      int  NOT NULL DEFAULT 20,      -- per-base daily send cap
  sent_today       int  NOT NULL DEFAULT 0,       -- counter, reset daily (GMT+3)
  last_send_reset  timestamptz DEFAULT now(),
  sending_enabled  boolean NOT NULL DEFAULT false,-- toggle: OFF until operator starts it
  created_at       timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.partner_leads (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  base_id      uuid NOT NULL REFERENCES public.partner_bases(id) ON DELETE CASCADE,
  base_name    text,                              -- denormalized for convenience
  contact      text,                              -- partner name / nick / contact person
  email        text,
  geo          text,
  promocode    text,                              -- partner's personal promo (filled later)
  vertical     text,                              -- sport / casino
  language     text,
  approach     text,                              -- angle we use (filled later)
  deal_type    text,                              -- e.g. RevShare
  deal_terms   text,                              -- concrete terms: %, details (filled later)
  status       text NOT NULL DEFAULT 'new',       -- new/queued/sent/in_progress/success/rejected
  note         text,                              -- free-form working note
  sent_at      timestamptz,
  created_at   timestamptz DEFAULT now(),
  updated_at   timestamptz DEFAULT now()
);

-- Dedup within a base by email (never across bases — bases are isolated).
-- Email is stored lowercased by the importer, so a plain composite unique works
-- as an upsert conflict target (functional/partial indexes can't be one).
CREATE UNIQUE INDEX IF NOT EXISTS partner_leads_base_email_uniq
  ON public.partner_leads (base_id, email);

CREATE INDEX IF NOT EXISTS partner_leads_base_idx   ON public.partner_leads (base_id);
CREATE INDEX IF NOT EXISTS partner_leads_status_idx ON public.partner_leads (base_id, status);

-- The dashboard reads/writes these tables with the anon key (same as leads/
-- telegram_channels), so grant access and keep RLS off to match project behavior.
ALTER TABLE public.partner_bases DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_leads DISABLE ROW LEVEL SECURITY;
GRANT ALL ON public.partner_bases TO anon, authenticated, service_role;
GRANT ALL ON public.partner_leads TO anon, authenticated, service_role;
