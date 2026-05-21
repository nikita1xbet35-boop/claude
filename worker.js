/**
 * AffiliateOS — Cloudflare Worker
 *
 * fetch()     → serves the static index.html (via Cloudflare Assets)
 * scheduled() → fires Supabase Edge Functions on cron schedule:
 *               "*/30 * * * *"  every 30 min  → check-limits
 *               "0 6 * * *"     06:00 UTC      → check-limits + daily-report (09:00 GMT+3)
 *
 * Required Worker env vars (set in Cloudflare dashboard or wrangler secret):
 *   SUPABASE_URL      – your project URL, e.g. https://xxxx.supabase.co
 *   SUPABASE_ANON_KEY – anon/public key
 */

export default {
  // ── HTTP handler ─────────────────────────────────────────────────────────────
  async fetch(request, env, ctx) {
    // Static assets (index.html, etc.) are served automatically via the
    // `assets` binding configured in wrangler.jsonc.
    return new Response('AffiliateOS', { status: 200 });
  },

  // ── Cron handler ─────────────────────────────────────────────────────────────
  async scheduled(event, env, ctx) {
    const SUPABASE_URL = env.SUPABASE_URL || 'https://lxsyrserfuighwxuymgb.supabase.co';
    const SUPABASE_KEY = env.SUPABASE_ANON_KEY || '';
    const FUNCTIONS_URL = SUPABASE_URL + '/functions/v1';

    const headers = {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
    };

    const cron = event.cron; // e.g. "*/30 * * * *" or "0 6 * * *"

    try {
      // Always check API limits on every cron tick
      const limitsResp = await fetch(FUNCTIONS_URL + '/check-limits', {
        method: 'POST',
        headers,
        body: JSON.stringify({ cron }),
      });

      if (!limitsResp.ok) {
        console.error('check-limits failed:', limitsResp.status, await limitsResp.text());
      }

      // Daily report at 06:00 UTC = 09:00 GMT+3
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
