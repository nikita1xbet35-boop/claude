// Supabase Edge Function: check-limits
// Checks api_usage table, fires warning at 80% and critical at 100%.
// Resets daily counters at midnight GMT+3.
// Deploy: supabase functions deploy check-limits
// Env vars needed: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL  = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const FUNCTIONS_URL = SUPABASE_URL + '/functions/v1';
const SUPABASE_ANON = Deno.env.get('SUPABASE_ANON_KEY') || '';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const SERVICE_NAMES: Record<string, string> = {
  serpapi:    'SerpAPI',
  groq:       'Groq AI',
  gmail_main: 'Gmail (main)',
  gmail_lp:   'Gmail (LP)',
  jina:       'Jina.ai',
};

async function sendAlert(level: string, service: string, message: string) {
  await fetch(FUNCTIONS_URL + '/send-alert', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON,
      'Authorization': 'Bearer ' + SUPABASE_ANON
    },
    body: JSON.stringify({ level, service, message })
  });
}

/** Returns true if current UTC time is within 30 minutes of midnight GMT+3. */
function isGMT3Midnight(now: Date): boolean {
  const gmt3 = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  return gmt3.getUTCHours() === 0 && gmt3.getUTCMinutes() < 31;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    const now = new Date();
    const { data: services, error } = await supabase.from('api_usage').select('*');
    if (error) throw error;

    const results: any[] = [];

    for (const svc of (services || [])) {
      const pct  = svc.used / svc.limit_value;
      const name = SERVICE_NAMES[svc.service] || svc.service;

      // ── Reset daily counters at midnight GMT+3 ──────────────────────────────
      if (svc.reset_period === 'daily' && isGMT3Midnight(now)) {
        const lastReset      = new Date(svc.last_reset_at);
        const hoursSinceReset = (now.getTime() - lastReset.getTime()) / (1000 * 60 * 60);

        if (hoursSinceReset > 1) {  // guard against double-reset within same window
          await supabase.from('api_usage').update({
            used:                  0,
            last_reset_at:         now.toISOString(),
            alert_sent_warning:    false,
            alert_sent_critical:   false,
            paused:                false,
            updated_at:            now.toISOString()
          }).eq('service', svc.service);

          await supabase.from('error_log').insert([{
            level:   'info',
            service: svc.service,
            message: `Daily counter reset. Was: ${svc.used}/${svc.limit_value}`
          }]);

          results.push({ service: svc.service, action: 'reset' });
          continue;
        }
      }

      // Only Gmail send-quota matters for alerting. The free/best-effort services
      // (jina, groq, serpapi) self-heal — Jina is just a fallback page-fetcher, so
      // hitting its quota never stops the pipeline. We never pause anything.
      const isSendQuota = svc.service === 'gmail_main' || svc.service === 'gmail_lp';
      if (!isSendQuota) continue;

      // ── Critical: 100%+ ────────────────────────────────────────────────────
      if (pct >= 1.0 && !svc.alert_sent_critical) {
        await sendAlert(
          'critical',
          name,
          `Daily send quota reached (${svc.used}/${svc.limit_value}).`
        );
        await supabase.from('api_usage').update({
          alert_sent_critical: true,
          updated_at:          now.toISOString()
        }).eq('service', svc.service);

        results.push({ service: svc.service, action: 'critical_alert' });
      }
      // ── Warning: 80%+ ──────────────────────────────────────────────────────
      else if (pct >= 0.8 && !svc.alert_sent_warning) {
        const remaining = svc.limit_value - svc.used;
        await sendAlert(
          'warning',
          name,
          `80% of daily send quota used (${svc.used}/${svc.limit_value}). ~${remaining} remaining.`
        );
        await supabase.from('api_usage').update({
          alert_sent_warning: true,
          updated_at:         now.toISOString()
        }).eq('service', svc.service);

        results.push({ service: svc.service, action: 'warning_alert' });
      }
    }

    return new Response(
      JSON.stringify({ success: true, checked: services?.length || 0, actions: results }),
      { headers: { ...cors, 'Content-Type': 'application/json' } }
    );
  } catch (e: any) {
    return new Response(
      JSON.stringify({ success: false, error: e.message }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } }
    );
  }
});
