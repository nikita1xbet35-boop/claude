// Supabase Edge Function: generate-queue-dfs
// ════════════════════════════════════════════════════════════════════════════
// Send-queue filler for the DataForSEO pipeline ONLY.
//
// This is deliberately a separate function rather than a flag on generate-queue.
// The two funnels have different ceilings, different lead quality and different
// email templates, and generate-queue carries a lot of hard-won scheduling
// behaviour (stable future slots, backlog drain, overdue repacking) that is not
// worth risking to serve a second caller. Here the same rules are applied to a
// disjoint set of leads.
//
// The daily ceiling lives in pipeline_limits and is a PIPELINE total to be split
// across several sending accounts — not a per-mailbox figure. 200 cold emails a
// day out of a single Gmail is a spam flag and a burnt domain inside a week.
// Nothing here fans out across accounts yet, so until several senders are wired
// up the effective safe ceiling is whatever one warmed account can carry;
// pipeline_limits.daily_limit is the knob for that.
//
// Deploy: supabase functions deploy generate-queue-dfs --no-verify-jwt
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const PIPELINE = 'dataforseo';
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

// ── Block 2 (§4.4 ТЗ): contact_registry gate — see generate-queue.ts for the
// full reasoning.
function domainOf(url: string | null | undefined): string {
  if (!url) return '';
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return String(url).toLowerCase().replace(/^www\./, ''); }
}

async function loadCooldownMap(): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    const { data } = await supabase.from('brands').select('id, cooldown_days');
    for (const b of (data || [])) map.set(String(b.id), Number(b.cooldown_days) || 3);
  } catch (_) { /* empty map — capture falls back to 3 below */ }
  return map;
}

async function captureAllowed(
  email: string, url: string, brandId: string | null, cooldownDays: number,
): Promise<boolean> {
  if (!brandId) return true;
  try {
    const { data, error } = await supabase.rpc('fn_capture_contact', {
      p_email: email, p_domain: domainOf(url), p_brand_id: brandId, p_cooldown_days: cooldownDays,
    });
    if (error) {
      await quiet(supabase.from('error_log').insert([{
        level: 'warning', service: 'generate-queue-dfs',
        message: `fn_capture_contact RPC failed, allowing through: ${error.message}`,
      }]));
      return true;
    }
    const row = Array.isArray(data) ? data[0] : data;
    return row?.allowed !== false;
  } catch (_) { return true; }
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
    // Round the clock — see the note in process-queue. The recipients span a
    // dozen time zones, so a Moscow window was arbitrary for nearly all of
    // them, and compressing a day's volume into twelve hours reads more like a
    // campaign than spreading it does. The daily ceiling still caps the day.

    const nowMs     = now.getTime();
    // Schedule out to the end of the day, not to 20:00 — the cursor below
    // stops adding rows once it passes this, and stopping at 20:00 left the
    // late-evening capacity unused every single day.
    const workEndMs = new Date(`${today}T23:59:00+03:00`).getTime();

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

    const cooldownMap = await loadCooldownMap();

    const { data: candidates, error: leadsErr } = await supabase.from('leads')
      .select('id, brand, brand_id, url, contact_email, fit_score, email_status, exclude_reason, affiliate_maturity')
      .eq('pipeline', PIPELINE)
      .in('stage', ['new', 'ready', 'researched', 'followup'])
      .not('contact_email', 'is', null)
      .neq('contact_email', '')
      .is('exclude_reason', null)
      .order('fit_score', { ascending: false, nullsFirst: false })
      .limit(LEAD_WINDOW);
    if (leadsErr) throw new Error('leads query failed: ' + leadsErr.message);

    // Professionals first, then by fit_score. A professional affiliate with a
    // portfolio is the target this whole module was built to reach; sending to
    // them a week after a hobby blog wastes the pipeline's best material.
    const rank = (l: any) => (l.affiliate_maturity === 'professional' ? 1000 : 0)
                           + (l.affiliate_maturity === 'semi_pro' ? 200 : 0)
                           + ((l.fit_score ?? 35) as number);
    const ranked = [...(candidates || [])].sort((a, b) => rank(b) - rank(a));

    const picked: Array<{ id: string; brand: string; brand_id: string | null; contact_email: string; url: string }> = [];
    for (const l of ranked) {
      if (picked.length >= capacity) break;
      if (queuedLeadIds.has(String(l.id))) continue;
      if (sentLeadIds.has(String(l.id))) continue;
      if (!isSendable(l.contact_email)) continue;
      const em = String(l.contact_email).toLowerCase();
      if (emailed.has(em)) continue;
      if (suppressedSet.has(em)) continue;
      if (l.email_status === 'invalid' || l.email_status === 'disposable') continue;
      // NB: contact_registry gate moved to the scheduling loop below — see the
      // comment there. Capturing during selection extended ownership for
      // candidates this run then never queues.
      picked.push({
        id: String(l.id), brand: l.brand || '1xbet',
        brand_id: l.brand_id ? String(l.brand_id) : null,
        contact_email: l.contact_email, url: l.url || '',
      });
    }

    if (!picked.length) { stats.reason = 'no eligible leads'; return json(stats); }

    // ── Schedule ──────────────────────────────────────────────────────────
    let cursor = nowMs + START_DELAY_MS;
    const inserts: Array<Record<string, unknown>> = [];
    // §4.4 ТЗ: the contact_registry gate belongs HERE, not in the selection loop.
    // fn_capture_contact extends owned_until as a side effect, so calling it
    // while merely considering a candidate handed this brand ownership over
    // leads the loop below then drops on `cursor >= workEndMs` — re-extended
    // every run, starving the rotation the gate exists to enforce. A denied
    // lead does not advance `cursor`, so it costs no slot.
    let blockedByRotation = 0;
    for (const l of picked) {
      if (cursor >= workEndMs) break;
      const cd = l.brand_id ? (cooldownMap.get(l.brand_id) ?? 3) : 3;
      if (!(await captureAllowed(l.contact_email, l.url, l.brand_id, cd))) { blockedByRotation++; continue; }
      inserts.push({
        lead_id:       l.id,
        brand:         l.brand,
        brand_id:      l.brand_id,
        gmail_account: 'main',
        scheduled_at:  new Date(cursor).toISOString(),
        status:        'pending',
        source:        'dataforseo',
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
      level: 'info', service: 'generate-queue-dfs',
      message: `added ${stats.generated} (sent ${stats.sent_today} + queued ${stats.pending} `
        + `/ limit ${stats.daily_limit})`
        + (blockedByRotation ? `, ${blockedByRotation} blocked by rotation` : ''),
    }]));

    return json(stats);
  } catch (e: any) {
    await quiet(supabase.from('error_log').insert([{
      level: 'critical', service: 'generate-queue-dfs', message: String(e?.message || e),
    }]));
    return json({ ...stats, error: String(e?.message || e) }, 500);
  }
});
