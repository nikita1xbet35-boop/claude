// AffiliateOS — Cloudflare Worker
// fetch()     → serves the static dashboard via Cloudflare Assets
// scheduled() → drives the autonomous pipeline by firing Supabase Edge Functions:
//
//   every 5 min  → process-queue    (send due emails)
//                + extract-contacts (find emails for new leads)
//   every 15 min → cron-search      (autonomous GEO-rotating lead search)
//                + generate-queue   (rolling queue top-up, 4-6 min cadence)
//   every 30 min → check-limits     (API limit monitoring + Telegram alerts)
//   06:00 UTC    → daily-report     (09:00 GMT+3 Telegram report)
//
// Env vars (optional — sane fallbacks below): SUPABASE_URL, SUPABASE_ANON_KEY

const DEFAULT_SUPABASE_URL = 'https://lxsyrserfuighwxuymgb.supabase.co';
const DEFAULT_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx4c3lyc2VyZnVpZ2h3eHV5bWdiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ5NDUwNDgsImV4cCI6MjA5MDUyMTA0OH0.6SgyPJZ_TKeKJoC_E4mIQhd373UMP8-K1VMSZJJacsM';

export default {
  async fetch(request, env, ctx) {
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    const SUPABASE_URL  = env.SUPABASE_URL || DEFAULT_SUPABASE_URL;
    const SUPABASE_KEY  = env.SUPABASE_ANON_KEY || DEFAULT_ANON_KEY;
    const FUNCTIONS_URL = SUPABASE_URL + '/functions/v1';

    const headers = {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
    };

    // Fire an edge function, log failures (don't throw — one failure must not
    // block the rest of the pipeline).
    const call = async (name, body) => {
      try {
        const res = await fetch(FUNCTIONS_URL + '/' + name, {
          method: 'POST',
          headers,
          body: JSON.stringify(body || {}),
        });
        if (!res.ok) {
          console.error(name + ' failed:', res.status, await res.text());
        }
      } catch (e) {
        console.error(name + ' error:', e && e.message);
      }
    };

    const cron = event.cron;

    if (cron === '*/5 * * * *') {
      // Sending and contact extraction run on the fast tick
      await call('process-queue', { cron });
      await call('extract-contacts', { cron });
      return;
    }

    if (cron === '*/15 * * * *') {
      // find-and-queue: full pipeline (SerpAPI → contact → lead insert)
      // cron-search:    calls auto-search as secondary breadth source
      // Both run in parallel; generate-queue runs after to schedule new leads
      await Promise.all([call('find-and-queue', {}), call('cron-search', {})]);
      await call('generate-queue', {});
      return;
    }

    if (cron === '*/30 * * * *') {
      await call('check-limits', { cron });
      return;
    }

    if (cron === '0 6 * * *') {
      await call('daily-report', {});
      return;
    }
  },
};
