// Supabase Edge Function: generate-queue-brand
// ════════════════════════════════════════════════════════════════════════════
// Send-queue filler for the BRAND pipeline (v8) ONLY.
//
// Separate from generate-queue and generate-queue-dfs for the same reason those
// two are separate from each other: different ceiling, different lead quality,
// different email template. Here the same scheduling rules are applied to a
// disjoint set of leads.
//
// SHIPS PAUSED. pipeline_limits.brand.paused is TRUE out of migration 029 and
// must stay that way until the brand outreach template exists. The approach to
// a site intercepting "mostbet apk" is not the approach to a review blog, and
// sending the main pipeline's letter to these people would burn the best list
// in the system on the first pass. Unpause together with the template.
//
// Two exclusions are specific to this module and are not negotiable:
//   occupied           — the site already pushes 1xBet with a promo code, so
//                        another manager owns that relationship
//   suspected_official — might be an operator's own mirror; a human decides
// Both are carried on leads.exclude_reason, which this function filters on.
//
// Deploy: supabase functions deploy generate-queue-brand --no-verify-jwt
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const PIPELINE = 'brand';
const MIN_INTERVAL_MS = 30 * 1000;
const MAX_INTERVAL_MS = 90 * 1000;
const START_DELAY_MS  = 30 * 1000;
const LEAD_WINDOW     = 400;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const randInterval = () =>
  MIN_INTERVAL_MS + Math.floor(Math.random() * (MAX_INTERVAL_MS - MIN_INTERVAL_MS));

const EMAIL_RE   = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;
const DISPOSABLE = ['mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail', 'throwaway'];
const JUNK_DOMAINS = new Set([
  'email.com', 'mydomain.com', 'yourdomain.com', 'domain.com', 'company.com',
  'yoursite.com', 'mysite.com', 'website.com', 'example.com', 'test.com',
]);

function isSendable(e: string | null): boolean {
  if (!e) return false;
  const l = e.toLowerCase().trim();
  if (!EMAIL_RE.test(l)) return false;
  if (DISPOSABLE.some(d => l.includes(d))) return false;
  const dom = l.split('@')[1] || '';
  if (JUNK_DOMAINS.has(dom)) return false;
  return true;
}

async function quiet(p: PromiseLike<unknown>): Promise<void> {
  try { await p; } catch { /* bookkeeping is best-effort */ }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const stats = {
    generated: 0, sent_today: 0, daily_limit: 0, capacity: 0,
    pending: 0, skipped: false, reason: '',
  };
  const json = (s: unknown, code = 200) => new Response(JSON.stringify(s),
    { status: code, headers: { ...cors, 'Content-Type': 'application/json' } });

  try {
    // ── Limit + pause switch ──────────────────────────────────────────────
    const { data: limitRow } = await supabase.from('pipeline_limits')
      .select('daily_limit, paused').eq('pipeline', PIPELINE).maybeSingle();
    if (!limitRow) { stats.reason = 'no pipeline_limits row'; stats.skipped = true; return json(stats); }
    if (limitRow.paused) { stats.reason = 'pipeline paused'; stats.skipped = true; return json(stats); }
    stats.daily_limit = Number(limitRow.daily_limit) || 0;

    // ── Working hours 08:00–20:00 GMT+3, same as the main pipeline ────────
    const now   = new Date();
    const gmt3  = new Date(now.getTime() + 3 * 60 * 60 * 1000);
    const hour  = gmt3.getUTCHours();
    const today = gmt3.toISOString().slice(0, 10);
    if (hour < 8 || hour >= 20) {
      stats.skipped = true;
      stats.reason = hour < 8 ? 'before working hours' : 'after working hours';
      return json(stats);
    }
    const nowMs     = now.getTime();
    const workEndMs = new Date(`${today}T20:00:00+03:00`).getTime();

    // ── Today's spend for THIS pipeline ───────────────────────────────────
    const dayStart = new Date(`${today}T00:00:00+03:00`).toISOString();
    const dayEnd   = new Date(`${today}T23:59:59+03:00`).toISOString();
    const { count: sentToday } = await supabase.from('email_log')
      .select('id', { count: 'exact', head: true })
      .eq('pipeline', PIPELINE)
      .gte('sent_at', dayStart).lte('sent_at', dayEnd);
    stats.sent_today = sentToday ?? 0;

    // Already-queued items count against the ceiling too, otherwise every run
    // would top the queue back up to the full limit and the day's real total
    // would be a multiple of it.
    const { data: pending } = await supabase.from('send_queue')
      .select('id, lead_id').eq('pipeline', PIPELINE).eq('status', 'pending');
    stats.pending = (pending || []).length;

    const capacity = stats.daily_limit - stats.sent_today - stats.pending;
    stats.capacity = capacity;
    if (capacity <= 0) {
      stats.reason = `daily ceiling reached (${stats.sent_today} sent + ${stats.pending} queued / ${stats.daily_limit})`;
      stats.skipped = true;
      return json(stats);
    }

    // ── Candidates ────────────────────────────────────────────────────────
    const queuedLeadIds = new Set((pending || []).map((p: any) => String(p.lead_id)));

    // Paginated: PostgREST caps an unbounded select at 1000 rows, so a plain
    // .select() here would silently truncate the all-time dedup once email_log
    // outgrew that — and a stale dedup set means re-mailing people who already
    // heard from us, which is the one mistake this whole gate exists to prevent.
    const sentRows: Array<{ lead_id: unknown; email: unknown }> = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase.from('email_log')
        .select('lead_id, email').range(from, from + 999);
      if (error) throw new Error('email_log query failed: ' + error.message);
      sentRows.push(...(data || []));
      if (!data || data.length < 1000) break;
      if (sentRows.length >= 200_000) break;   // sanity stop
    }
    const sentLeadIds = new Set(sentRows.map(r => String(r.lead_id)).filter(Boolean));
    // All-time dedup by address: the same mailbox can sit on several domains.
    const emailed = new Set(sentRows
      .map(r => String(r.email || '').toLowerCase()).filter(Boolean));

    const { data: suppressed } = await supabase.from('suppression_list').select('email');
    const suppressedSet = new Set((suppressed || [])
      .map((s: any) => String(s.email || '').toLowerCase()));

    const { data: candidates, error: leadsErr } = await supabase.from('leads')
      .select('id, brand, contact_email, fit_score, email_status, exclude_reason, '
            + 'serp_position, has_apk, suspected_official')
      .eq('pipeline', PIPELINE)
      .in('stage', ['new', 'ready', 'researched', 'followup'])
      .not('contact_email', 'is', null)
      .neq('contact_email', '')
      .is('exclude_reason', null)
      .order('fit_score', { ascending: false, nullsFirst: false })
      .limit(LEAD_WINDOW);
    if (leadsErr) throw new Error('leads query failed: ' + leadsErr.message);

    // Best brand position first, then APK, then fit_score. Position in a brand
    // SERP is the closest thing this module has to a traffic estimate: rank 2
    // for "mostbet apk" intercepts a different order of volume than rank 30,
    // and the daily ceiling is only 50, so the order decides who ever gets a
    // letter at all.
    const rank = (l: any) => {
      const pos = Number(l.serp_position) || 99;
      return (pos <= 5 ? 1000 : pos <= 15 ? 400 : 0)
           + (l.has_apk ? 250 : 0)
           + ((l.fit_score ?? 35) as number);
    };
    const ranked = [...(candidates || [])].sort((a, b) => rank(b) - rank(a));

    const picked: Array<{ id: string; brand: string }> = [];
    for (const l of ranked) {
      if (picked.length >= capacity) break;
      if (queuedLeadIds.has(String(l.id))) continue;
      if (sentLeadIds.has(String(l.id))) continue;
      if (!isSendable(l.contact_email)) continue;
      const em = String(l.contact_email).toLowerCase();
      if (emailed.has(em)) continue;
      if (suppressedSet.has(em)) continue;
      if (l.email_status === 'invalid' || l.email_status === 'disposable') continue;
      // Belt and braces on top of the `.is('exclude_reason', null)` filter
      // above: suspected_official is also its own boolean column, and a lead
      // that got the flag without the reason being written must still never be
      // mailed automatically.
      if (l.suspected_official) continue;
      picked.push({ id: String(l.id), brand: l.brand || '1xbet' });
    }

    if (!picked.length) { stats.reason = 'no eligible leads'; return json(stats); }

    // ── Schedule ──────────────────────────────────────────────────────────
    let cursor = nowMs + START_DELAY_MS;
    const inserts: Array<Record<string, unknown>> = [];
    for (const l of picked) {
      if (cursor >= workEndMs) break;
      inserts.push({
        lead_id:       l.id,
        brand:         l.brand,
        gmail_account: 'main',
        scheduled_at:  new Date(cursor).toISOString(),
        status:        'pending',
        source:        'brand',
        pipeline:      PIPELINE,
      });
      cursor += randInterval();
    }

    if (inserts.length) {
      const { error: insErr } = await supabase.from('send_queue').insert(inserts);
      if (insErr) throw new Error('insert failed: ' + insErr.message);
      stats.generated = inserts.length;
    }

    await quiet(supabase.from('error_log').insert([{
      level: 'info', service: 'generate-queue-brand',
      message: `added ${stats.generated} (sent ${stats.sent_today} + queued ${stats.pending} `
        + `/ limit ${stats.daily_limit})`,
    }]));

    return json(stats);
  } catch (e: any) {
    await quiet(supabase.from('error_log').insert([{
      level: 'critical', service: 'generate-queue-brand', message: String(e?.message || e),
    }]));
    return json({ ...stats, error: String(e?.message || e) }, 500);
  }
});
