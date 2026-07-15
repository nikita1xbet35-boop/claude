-- Migration 011: allow email_log rows without a lead_id.
-- Partner-base sends aren't tied to a leads row (they live in partner_leads), so
-- their email_log insert was failing on the NOT NULL lead_id and getting swallowed.
-- With this, partner sends log properly → they count toward the shared mailbox cap
-- and show up in stats. Idempotent.

ALTER TABLE public.email_log ALTER COLUMN lead_id DROP NOT NULL;
