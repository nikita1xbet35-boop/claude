// AffiliateOS — Cloudflare Worker
// fetch()     → serves static index.html via Cloudflare Assets
// scheduled() → fires Supabase Edge Functions on cron schedule:
//   every 5 min   → process-queue
//   every 15 min  → search-and-analyze (continuous lead search)
//   every 30 min  → check-limits
//   05:00 UTC     → generate-queue (08:00 GMT+3)
//   06:00 UTC     → daily-report (09:00 GMT+3)
// Env vars needed: SUPABASE_URL, SUPABASE_ANON_KEY

export default {
  // ── HTTP handler ─────────────────────────────────────────────────────────────
  async fetch(request, env, ctx) {
    return env.ASSETS.fetch(request);
  },

  // ── Cron handler ─────────────────────────────────────────────────────────────
  async scheduled(event, env, ctx) {
    const SUPABASE_URL = env.SUPABASE_URL || 'https://lxsyrserfuighwxuymgb.supabase.co';
    const SUPABASE_KEY = env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx4c3lyc2VyZnVpZ2h3eHV5bWdiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ5NDUwNDgsImV4cCI6MjA5MDUyMTA0OH0.6SgyPJZ_TKeKJoC_E4mIQhd373UMP8-K1VMSZJJacsM';
    const FUNCTIONS_URL = SUPABASE_URL + '/functions/v1';

    const headers = {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
    };

    const cron = event.cron; // e.g. "*/30 * * * *" or "0 6 * * *"

    try {
      // ── Every 5 min: process the send queue ────────────────────────────────
      if (cron === '*/5 * * * *') {
        const queueResp = await fetch(FUNCTIONS_URL + '/process-queue', {
          method: 'POST',
          headers,
          body: JSON.stringify({ cron }),
        });

        if (!queueResp.ok) {
          console.error('process-queue failed:', queueResp.status, await queueResp.text());
        }
        return; // skip check-limits on high-frequency ticks
      }

      // ── Every 15 min: run search-and-analyze (continuous lead search) ──────
      if (cron === '*/15 * * * *') {
        const searchResp = await fetch(FUNCTIONS_URL + '/search-and-analyze', {
          method: 'POST',
          headers,
          body: JSON.stringify({ cron }),
        });

        if (!searchResp.ok) {
          console.error('search-and-analyze failed:', searchResp.status, await searchResp.text());
        }
        return;
      }

      // ── 05:00 UTC = 08:00 GMT+3: generate daily queue ─────────────────────
      if (cron === '0 5 * * *') {
        const genResp = await fetch(FUNCTIONS_URL + '/generate-queue', {
          method: 'POST',
          headers,
          body: JSON.stringify({}),
        });

        if (!genResp.ok) {
          console.error('generate-queue failed:', genResp.status, await genResp.text());
        }
      }

      // ── Every 30 min and 06:00 UTC: check API limits ───────────────────────
      const limitsResp = await fetch(FUNCTIONS_URL + '/check-limits', {
        method: 'POST',
        headers,
        body: JSON.stringify({ cron }),
      });

      if (!limitsResp.ok) {
        console.error('check-limits failed:', limitsResp.status, await limitsResp.text());
      }

      // ── Daily report at 06:00 UTC = 09:00 GMT+3 ───────────────────────────
      if (cron === '0 6 * * *') {
        const reportResp = await fetch(FUNCTIONS_URL + '/daily-report', {
          method: 'POST',
          headers,
          body: JSON.stringify({}),
        });

        if (!reportResp.ok) {
          console.error('daily-report failed:', reportResp.status, await reportResp.text());
        }
      }
    } catch (e) {
      console.error('Cron error:', e);
    }
  },
};
