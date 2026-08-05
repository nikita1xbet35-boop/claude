// Supabase Edge Function: archive-keywords
// ════════════════════════════════════════════════════════════════════════════
// Search v6 §9 — keyword yield audit + auto-archival.
//
// The v5 pool burned out over roughly a month and nobody found out from the
// system: it surfaced as falling lead intake weeks later. Keywords now carry
// their own yield stats, and this job retires the dead ones on a schedule and
// says so in Telegram, so the pool can never quietly rot again.
//
// Archival rules (from the brief):
//   runs >= 15 AND leads_created = 0            -> dead on arrival
//   runs >= 30 AND leads_created/runs < 0.02    -> burned out
//
// Also warns when a preset/layer combination drops below MIN_ACTIVE keywords,
// i.e. the pool needs topping up with fresh ones.
//
// Runs weekly (Monday) off the daily 07:00 UTC tick — Cloudflare's free plan
// caps cron triggers at 5, so it rides an existing one rather than taking a slot.
// Accepts { force: true } to run on demand.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ALERTS_BOT_TOKEN, ALERTS_CHAT_ID

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const TG_TOKEN     = Deno.env.get('ALERTS_BOT_TOKEN') || '';
const TG_CHAT      = Deno.env.get('ALERTS_CHAT_ID') || '';

const MIN_RUNS_DEAD     = 15;   // never produced a lead in this many runs
const MIN_RUNS_BURNED   = 30;   // enough runs to judge a yield ratio
const MIN_YIELD         = 0.02; // leads per run below which a keyword is spent
const MIN_ACTIVE        = 5;    // per preset+layer, below this the pool needs topping up

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function tg(text: string) {
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
  } catch { /* alerting is best-effort */ }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const stats = { checked: 0, archived: 0, thin_pools: 0, reason: '' };

  try {
    const body = await req.json().catch(() => ({}));
    const force = !!(body as Record<string, unknown>).force;

    // Weekly: Monday only, unless forced.
    if (!force && new Date().getUTCDay() !== 1) {
      stats.reason = 'not Monday — weekly job';
      return new Response(JSON.stringify(stats), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    const { data: rows, error } = await supabase.from('keywords')
      .select('id, preset, layer, keyword, runs, urls_found, leads_created, hot_leads')
      .eq('active', true);
    if (error) throw new Error(error.message);
    if (!rows?.length) {
      stats.reason = 'no active keywords';
      return new Response(JSON.stringify(stats), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    stats.checked = rows.length;

    const doomed = rows.filter(k => {
      const runs  = k.runs ?? 0;
      const leads = k.leads_created ?? 0;
      if (runs >= MIN_RUNS_DEAD   && leads === 0) return true;
      if (runs >= MIN_RUNS_BURNED && leads / runs < MIN_YIELD) return true;
      return false;
    });

    if (doomed.length) {
      const now = new Date().toISOString();
      // Chunked so a large sweep doesn't build an oversized URL filter.
      for (let i = 0; i < doomed.length; i += 50) {
        const ids = doomed.slice(i, i + 50).map(k => k.id);
        await supabase.from('keywords')
          .update({ active: false, archived_at: now }).in('id', ids);
      }
      stats.archived = doomed.length;
    }

    // Remaining pool depth per preset+layer, after archival.
    const remaining = new Map<string, number>();
    for (const k of rows) {
      if (doomed.some(d => d.id === k.id)) continue;
      const key = `${k.preset}|${k.layer}`;
      remaining.set(key, (remaining.get(key) ?? 0) + 1);
    }
    const thin = [...remaining.entries()].filter(([, n]) => n < MIN_ACTIVE);
    stats.thin_pools = thin.length;

    if (doomed.length || thin.length) {
      // Group the archived ones for a readable message.
      const byGroup = new Map<string, number>();
      for (const k of doomed) {
        const key = `${k.preset}|${k.layer}`;
        byGroup.set(key, (byGroup.get(key) ?? 0) + 1);
      }
      const lines: string[] = [];
      if (doomed.length) {
        lines.push(`🧹 <b>Выгорело ключей: ${doomed.length}</b>`);
        for (const [key, n] of [...byGroup.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
          const [preset, layer] = key.split('|');
          const left = remaining.get(key) ?? 0;
          lines.push(`· ${preset} слой ${layer}: −${n}, осталось ${left}`);
        }
      }
      if (thin.length) {
        lines.push('');
        lines.push(`⚠️ <b>Пул истощается</b> (меньше ${MIN_ACTIVE} активных):`);
        for (const [key, n] of thin.slice(0, 12)) {
          const [preset, layer] = key.split('|');
          lines.push(`· ${preset} слой ${layer}: ${n}`);
        }
        lines.push('');
        lines.push('Нужны свежие ключи для этих пресетов.');
      }
      await tg(lines.join('\n'));
    }

    // NB: a Supabase query builder is a thenable WITHOUT .catch — chaining
    // `.catch()` onto it throws TypeError, which used to turn this Monday-only
    // job into a 500 right after it had already done its work.
    try {
      await supabase.from('error_log').insert([{
        level: 'info', service: 'archive-keywords',
        message: `checked=${stats.checked} archived=${stats.archived} thin_pools=${stats.thin_pools}`,
      }]);
    } catch { /* logging is best-effort */ }

    return new Response(JSON.stringify(stats), { headers: { ...cors, 'Content-Type': 'application/json' } });
  } catch (e: any) {
    return new Response(JSON.stringify({ ...stats, error: String(e.message || e) }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
});
