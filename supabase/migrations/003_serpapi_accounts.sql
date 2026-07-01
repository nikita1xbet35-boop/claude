-- AffiliateOS — Migration 003: SerpApi account rotation
-- Registers up to 3 SerpApi accounts as api_usage counters (monthly, 250 each).
-- The API keys themselves live in Supabase function secrets (SERPAPI_KEY_1/2/3),
-- never in the DB. Idempotent.

INSERT INTO public.api_usage (service, used, limit_value, reset_period) VALUES
  ('serpapi_1', 0, 250, 'monthly'),
  ('serpapi_2', 0, 250, 'monthly'),
  ('serpapi_3', 0, 250, 'monthly')
ON CONFLICT (service) DO NOTHING;
