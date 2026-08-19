// Supabase Edge Function: check-limits
// Checks api_usage table, fires warning at 80% and critical at 100%.
// Alerts ONLY on the Gmail send-quota — best-effort services (SerpApi/Groq/Jina)
// self-heal (SerpApi rotates accounts then falls back to DuckDuckGo), so they must
// never page. Resets daily counters at midnight GMT+3.
// Deploy: supabase functions deploy check-limits
// Env vars needed: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY

import { createClient } from 'npm:@supabase/supabase-js@2';

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

/** Funnel thresholds (v9 block A).
 *
 *  Each check names a DIFFERENT repair, which is the whole point — before this,
 *  every one of these conditions surfaced as the same symptom ("volume is down")
 *  and the cause had to be guessed at:
 *
 *    search engine degrading  → back off, rotate, wait it out
 *    LLM rate-limited         → more keys / bigger spacing
 *    pipeline stalled         → something crashed or the scheduler stopped
 *    SERP exhausted           → new keywords and geos, nothing else will help
 *    contacts not extracted   → the problem is downstream of the search entirely
 *
 *  Alerts are deliberately not deduplicated here: check-limits runs every 15
 *  minutes, so a persisting problem repeats four times an hour. That is
 *  intentional for a system whose failures are otherwise silent.
 */
async function checkFunnel(): Promise<any[]> {
  const out: any[] = [];
  try {
    const { data: rows } = await supabase.from('funnel_24h').select('*');
    if (!rows?.length) return out;

    for (const r of rows) {
      const p = String(r.pipeline);

      // Soft ban on the search source: normal is 10-12 results per keyword.
      if (Number(r.keywords_used) >= 10 && Number(r.avg_urls_per_keyword) < 5) {
        await sendAlert('warning', 'funnel',
          `${p}: поисковик деградирует — ${r.avg_urls_per_keyword} результатов на ключ (норма 10-12). Похоже на мягкий бан.`);
        out.push({ service: 'funnel', pipeline: p, action: 'search_degraded' });
      }

      // Rate limit wall. Counted per 24h, so 10+ is a wall and not a blip.
      if (Number(r.llm_429) > 10) {
        await sendAlert('warning', 'funnel',
          `${p}: упёрлись в лимиты LLM — ${r.llm_429} ответов 429 за сутки. Нужны ключи или пауза между вызовами.`);
        out.push({ service: 'funnel', pipeline: p, action: 'llm_throttled' });
      }

      // Ran, but produced nothing. Distinct from not running at all, which is
      // the missing-row case checked below.
      if (Number(r.runs) >= 3 && Number(r.leads_created) === 0) {
        await sendAlert('critical', 'funnel',
          `${p}: пайплайн встал — ${r.runs} прогонов за сутки, ноль лидов. Найдено URL: ${r.urls_returned}, новых после дедупа: ${r.urls_after_dedup}.`);
        out.push({ service: 'funnel', pipeline: p, action: 'stalled' });
      }

      // The SERP is picked clean. No amount of retrying fixes this one.
      if (Number(r.urls_after_noise) >= 100 && Number(r.pct_new_urls) < 5) {
        await sendAlert('warning', 'funnel',
          `${p}: выдача исчерпана — только ${r.pct_new_urls}% найденных URL новые. Нужны новые ключи и ГЕО, ретраи не помогут.`);
        out.push({ service: 'funnel', pipeline: p, action: 'serp_exhausted' });
      }

      // Sites are found and qualified, but no contact can be pulled out of them.
      if (Number(r.passed_criteria) >= 20 && Number(r.pct_contacts) < 15) {
        await sendAlert('warning', 'funnel',
          `${p}: ломается извлечение контактов — ${r.pct_contacts}% (из ${r.passed_criteria} подходящих сайтов). Проблема не в поиске.`);
        out.push({ service: 'funnel', pipeline: p, action: 'contacts_failing' });
      }
    }

    // A pipeline with NO row at all did not run. That is a different failure
    // from running badly, and the one most likely to go unnoticed, because
    // nothing anywhere produces an error line when a stage simply stops.
    const seen = new Set(rows.map((r: any) => String(r.pipeline)));
    for (const p of ['search', 'brand']) {
      if (!seen.has(p)) {
        await sendAlert('critical', 'funnel',
          `${p}: за сутки нет ни одного прогона. Пайплайн не запускается — проверь планировщик.`);
        out.push({ service: 'funnel', pipeline: p, action: 'no_runs' });
      }
    }
  } catch (e: any) {
    // Never let the funnel check break the quota check it rides on.
    out.push({ service: 'funnel', action: 'check_failed', error: String(e?.message || e) });
  }
  return out;
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

      // ── Reset monthly counters on the 1st (GMT+3) — e.g. SerpApi accounts ───
      if (svc.reset_period === 'monthly') {
        const gmt3 = new Date(now.getTime() + 3 * 60 * 60 * 1000);
        const lastReset = new Date(svc.last_reset_at);
        const lastMonth = lastReset.toISOString().slice(0, 7);
        const thisMonth = gmt3.toISOString().slice(0, 7);
        if (lastMonth !== thisMonth) {
          await supabase.from('api_usage').update({
            used: 0, last_reset_at: now.toISOString(),
            alert_sent_warning: false, alert_sent_critical: false,
            paused: false, updated_at: now.toISOString(),
          }).eq('service', svc.service);
          await supabase.from('error_log').insert([{
            level: 'info', service: svc.service,
            message: `Monthly counter reset. Was: ${svc.used}/${svc.limit_value}`,
          }]);
          results.push({ service: svc.service, action: 'monthly_reset' });
          continue;
        }
      }

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
          `Достигнут дневной лимит отправки (${svc.used}/${svc.limit_value}). Отправка по этому аккаунту продолжится после сброса счётчика в полночь МСК.`
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
          `Использовано 80% дневного лимита отправки (${svc.used}/${svc.limit_value}). Осталось ~${remaining}.`
        );
        await supabase.from('api_usage').update({
          alert_sent_warning: true,
          updated_at:         now.toISOString()
        }).eq('service', svc.service);

        results.push({ service: svc.service, action: 'warning_alert' });
      }
    }

    // ── v9 block A: funnel alerts ──────────────────────────────────────────
    // Hung off this function rather than a new one, because Cloudflare's free
    // plan allows five cron triggers and all five are already spoken for. A
    // sixth would not error — it would silently never fire, which is how a whole
    // channel once went unnoticed for weeks.
    //
    // These thresholds answer "which stage is losing the volume", so each one
    // names a different repair. A generic "pipeline is down" alert would not.
    const funnelActions = await checkFunnel();
    results.push(...funnelActions);

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
