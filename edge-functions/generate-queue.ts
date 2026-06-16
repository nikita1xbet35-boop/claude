// Supabase Edge Function: generate-queue
// Continuously tops up the daily send queue.
//
// Runs every 15 minutes:
//   - Leaves already future-scheduled items UNTOUCHED, so the time shown on
//     the dashboard stays stable and matches when the email actually sends
//   - Reschedules only overdue items (slot in the past) to fire again soon
//   - Appends newly-eligible leads (with contacts) after the last occupied slot
//   - Keeps the queue within the daily target (200 weekday / 100 weekend)
//   - Respects working hours 08:00-20:00 GMT+3
//
// Deploy: supabase functions deploy generate-queue --no-verify-jwt
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto-injected)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const WEEKDAY_TARGET = 250;
const WEEKEND_TARGET = 100;
// 30–90 s cadence gives ~360–1080 slots in the 09-18 window.
// process-queue runs every 2 min and picks up whatever is due, so dense
// scheduling means multiple sends per run when the queue is full.
const MIN_INTERVAL_MS = 30 * 1000;
const MAX_INTERVAL_MS = 90 * 1000;
const START_DELAY_MS  = 30 * 1000;     // first slot is now + 30s

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const EMAIL_RE   = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;
const DISPOSABLE = ['mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail', 'throwaway'];
const PLACEHOLDERS = [
  'youremail','your-email','your_email','yourname','your-name',
  'email@email','test@test','user@user','name@name',
  'demo@','sample@','placeholder','changeme','username@',
  'admin@example','info@example','user@example','test@example',
  'email@domain','mail@domain','name@domain','user@domain','email@site','mail@site',
];
const PLACEHOLDER_LOCAL = new Set(['email','test','demo','sample','info123','admin123','example','noreply','donotreply','postmaster','mailer']);
// Big corporate / portal email domains — NOT affiliates. Never email these even if
// a bad lead slipped through (e.g. support@maps.yandex.ru).
// NOTE: gmail/googlemail/outlook/hotmail are CONSUMER providers, not corporate —
// small affiliate site owners (our core targets) use them as their main contact.
const CORP_EMAIL_DOMAINS = new Set([
  'yandex.ru','yandex.com','maps.yandex.ru','ya.ru','mail.ru','vk.com','ok.ru','rambler.ru',
  'avito.ru','gosuslugi.ru','sberbank.ru','tinkoff.ru','wildberries.ru','ozon.ru','2gis.ru',
  'rbc.ru','rt.com','ria.ru','tass.ru','google.com','apple.com',
  'microsoft.com','samsung.com','huawei.com','xiaomi.com',
  'baidu.com','aliexpress.com','wordpress.com','wix.com','shopify.com','cloudflare.com',
]);
// Placeholder/junk domains that never accept mail → guaranteed bounces.
const JUNK_DOMAINS = new Set([
  'email.com','mydomain.com','yourdomain.com','domain.com','company.com',
  'yoursite.com','mysite.com','website.com','example.com','test.com',
]);
// Betting operators — competitors, not affiliates. Never contact.
const COMPETITOR_DOMAINS = new Set([
  'linebet.com','paripesa.com','1xbet.com','melbet.com','22bet.com','mostbet.com',
  'betwinner.com','1win.com','parimatch.com','sportybet.com','bet9ja.com','stake.com',
]);

function isSendableEmail(e: string | null): boolean {
  if (!e) return false;
  const l = e.toLowerCase();
  if (DISPOSABLE.some(d => l.includes(d)))   return false;
  if (PLACEHOLDERS.some(p => l.includes(p))) return false;
  const local  = l.split('@')[0];
  const domain = l.split('@')[1] || '';
  if (PLACEHOLDER_LOCAL.has(local))          return false;
  if (CORP_EMAIL_DOMAINS.has(domain))        return false;
  if (JUNK_DOMAINS.has(domain))              return false;
  if (COMPETITOR_DOMAINS.has(domain))        return false;
  // Malformed: domain used as local part (e.g. site.com.ng@gmail.com)
  if (/\.(com|net|org|co|info|me|io|news|blog|site|web)\.[a-z]{2,3}$/.test(local)) return false;
  return EMAIL_RE.test(e);
}

// GEO blacklist — same logic as process-queue so nothing slips through
const GQ_EXCLUDED_TLDS = [
  '.co.uk','.org.uk','.me.uk','.com.ua','.org.ua',
  '.com.br','.net.br','.org.br','.com.au','.net.au','.org.au',
  '.co.nz','.com.nz',
];
const GQ_EXCL_CC  = ['.uk','.ua','.br','.au','.nz','.us'];
const GQ_EU_TLDS  = ['.de','.fr','.it','.es','.nl','.be','.at','.ch','.se','.no','.dk','.fi','.pl','.pt','.cz','.hu','.ro','.bg','.hr','.sk','.si','.lt','.lv','.ee','.gr','.ie','.lu','.mt','.cy'];
const GQ_GEO_KW   = ['united states','united kingdom','ukraine','brazil','australia','new zealand','usa','u.s.','u.k.','america','germany','france','italy','spain','netherlands','belgium','austria','switzerland','sweden','norway','denmark','finland','poland','portugal','czech','hungary','romania','bulgaria','croatia'];

function isGeoExcludedGQ(url: string, geo?: string): boolean {
  if (geo) { const g = geo.toLowerCase(); if (GQ_GEO_KW.some(k => g.includes(k))) return true; }
  if (!url) return false;
  let h = '';
  try { h = new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return false; }
  if (GQ_EXCLUDED_TLDS.some(t => h.endsWith(t))) return true;
  const tld = '.' + h.split('.').pop()!;
  return GQ_EXCL_CC.includes(tld) || GQ_EU_TLDS.includes(tld);
}

function randInterval(): number {
  return MIN_INTERVAL_MS + Math.floor(Math.random() * (MAX_INTERVAL_MS - MIN_INTERVAL_MS));
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    const nowMs   = Date.now();
    const nowGMT3 = new Date(nowMs + 3 * 60 * 60 * 1000);
    const todayStr = nowGMT3.toISOString().slice(0, 10);

    // generate-queue never pauses — queue prep is always safe (process-queue is the gatekeeper)

    // GMT+3 day boundaries / working window (as UTC instants)
    const todayMidnightUTC    = new Date(`${todayStr}T00:00:00+03:00`);
    const tomorrowMidnightUTC = new Date(todayMidnightUTC.getTime() + 24 * 60 * 60 * 1000);
    const workStartMs = new Date(`${todayStr}T08:00:00+03:00`).getTime();
    const workEndMs   = new Date(`${todayStr}T20:00:00+03:00`).getTime();

    const dayOfWeek    = nowGMT3.getUTCDay();
    const isWeekend    = dayOfWeek === 0 || dayOfWeek === 6;
    const dailyTarget  = isWeekend ? WEEKEND_TARGET : WEEKDAY_TARGET;

    // After the work day — nothing to schedule today
    if (nowMs >= workEndMs) {
      return new Response(JSON.stringify({
        generated: 0, repacked: 0, skipped: true,
        reason: 'after working hours',
        date: todayStr,
        is_weekend: isWeekend,
      }), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    // How many were already sent today
    const { count: sentToday } = await supabase
      .from('email_log')
      .select('id', { count: 'exact', head: true })
      .gte('sent_at', todayMidnightUTC.toISOString())
      .lt('sent_at',  tomorrowMidnightUTC.toISOString());

    const capacity = dailyTarget - (sentToday ?? 0);
    if (capacity <= 0) {
      await supabase.from('error_log').insert([{
        level: 'info', service: 'generate-queue',
        message: `Daily target reached: sent ${sentToday ?? 0}/${dailyTarget} today (${todayStr}, ${isWeekend ? 'weekend' : 'weekday'})`,
      }]);
      return new Response(JSON.stringify({
        generated: 0, repacked: 0, skipped: true,
        reason: 'daily target reached',
        sent_today: sentToday ?? 0,
        target: dailyTarget,
        date: todayStr,
        is_weekend: isWeekend,
      }), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    // All still-pending queue items
    const { data: pendingRaw, error: pendErr } = await supabase
      .from('send_queue')
      .select('id, lead_id, brand, gmail_account, scheduled_at')
      .eq('status', 'pending')
      .order('scheduled_at', { ascending: true })
      .order('id', { ascending: true });
    if (pendErr) throw new Error(`send_queue query failed: ${pendErr.message}`);

    // Drop queue items whose lead has no contact_email — nothing to ever send.
    let noContactLeadIds = new Set<string>();
    if (pendingRaw && pendingRaw.length > 0) {
      const leadIds = [...new Set(pendingRaw.map(p => p.lead_id as string))];
      const { data: leadsCheck } = await supabase
        .from('leads').select('id, contact_email').in('id', leadIds);
      noContactLeadIds = new Set(
        (leadsCheck || []).filter(l => !l.contact_email).map(l => l.id as string),
      );
      if (noContactLeadIds.size > 0) {
        const staleIds = pendingRaw
          .filter(p => noContactLeadIds.has(p.lead_id as string))
          .map(p => p.id);
        await supabase.from('send_queue')
          .update({ status: 'skipped', error: 'no contact email' })
          .in('id', staleIds);
      }
    }

    const livePending = (pendingRaw || [])
      .filter(p => !noContactLeadIds.has(p.lead_id as string));

    // Split into items already scheduled in the future (KEEP their time — this is
    // what the dashboard shows, so it must stay stable) and overdue items whose
    // slot is in the past (these get rescheduled to fire again soon).
    const futureSlack = nowMs + 30 * 1000;
    const futurePending  = livePending.filter(p => new Date(p.scheduled_at as string).getTime() > futureSlack);
    const overduePending = livePending
      .filter(p => new Date(p.scheduled_at as string).getTime() <= futureSlack)
      .slice(0, capacity);

    // Fill remaining capacity with new eligible leads
    const newQuota = Math.max(0, capacity - futurePending.length - overduePending.length);
    let newLeads: Array<{ id: string; brand: string }> = [];

    if (newQuota > 0) {
      // Hard dedup: ALL-TIME — never re-contact anyone we've ever emailed
      const { data: allSent } = await supabase
        .from('email_log').select('email, lead_id');
      const emailedSet = new Set(
        (allSent || []).map((r: any) => (r.email || '').toLowerCase()).filter(Boolean),
      );
      // Also dedup by lead_id — prevents duplicates even if contact email changed
      const sentLeadIds = new Set(
        (allSent || []).map((r: any) => r.lead_id).filter(Boolean),
      );

      const queuedLeadIds = new Set(livePending.map(p => p.lead_id));

      // 'waiting' = already contacted (set by process-queue after send). All other
      // stages with a contact email are fair game — the all-time email_log dedup below
      // guarantees we never re-contact anyone, so widening the net is safe.
      const { data: candidates, error: leadsErr } = await supabase
        .from('leads')
        .select('id, brand, contact_email, url, geo')
        .in('stage', ['new', 'ready', 'researched', 'followup'])
        .not('contact_email', 'is', null)
        .neq('contact_email', '')
        // Newest first: fresh contactable leads must send same-day. Ascending order
        // jammed the 600-row window with old already-emailed/placeholder leads,
        // so generate-queue added 0 new while fresh leads sat beyond the window.
        .order('created_at', { ascending: false })
        .limit(600);
      if (leadsErr) throw new Error(`leads query failed: ${leadsErr.message}`);

      for (const l of (candidates || [])) {
        if (newLeads.length >= newQuota) break;
        if (queuedLeadIds.has(l.id)) continue;
        if (sentLeadIds.has(l.id)) continue;                          // dedup by lead_id
        if (!isSendableEmail(l.contact_email)) continue;
        if (emailedSet.has(l.contact_email.toLowerCase())) continue;  // dedup by email
        if (isGeoExcludedGQ(l.url || '', l.geo || '')) continue;     // geo blacklist
        newLeads.push({ id: l.id, brand: l.brand });
      }
    }

    // ── Scheduling ──────────────────────────────────────────────────────────
    // Future-scheduled items are LEFT UNTOUCHED so the dashboard's displayed
    // times stay stable. We only reschedule overdue items and append new leads
    // after the last occupied slot.
    const updates: Array<{ id: number; scheduled_at: string }> = [];
    const inserts: Array<Record<string, unknown>> = [];

    // 1. Overdue items fire first — densely from now+delay.
    let cursor = Math.max(nowMs + START_DELAY_MS, workStartMs);
    for (const p of overduePending) {
      if (cursor >= workEndMs) break;
      updates.push({ id: p.id as number, scheduled_at: new Date(cursor).toISOString() });
      cursor += randInterval();
    }

    // 2. New leads are inserted starting from the current cursor (near now+90s),
    //    NOT appended after the latest future item. Future items keep their stable
    //    times and will interleave naturally — process-queue picks by scheduled_at ASC.
    //    This eliminates long gaps when future items happen to be far away.
    for (const l of newLeads) {
      if (cursor >= workEndMs) break;
      inserts.push({
        lead_id:       l.id,
        brand:         l.brand,
        gmail_account: 'main', // LP account disabled — all sends via main
        scheduled_at:  new Date(cursor).toISOString(),
        status:        'pending',
      });
      cursor += randInterval();
    }

    // Apply: reschedule overdue rows, insert new ones.
    for (const u of updates) {
      await supabase.from('send_queue')
        .update({ scheduled_at: u.scheduled_at })
        .eq('id', u.id)
        .eq('status', 'pending'); // never touch a row that just got sent
    }
    if (inserts.length > 0) {
      const { error: insErr } = await supabase.from('send_queue').insert(inserts);
      if (insErr) throw new Error(`insert failed: ${insErr.message}`);
    }

    await supabase.from('error_log').insert([{
      level: 'info', service: 'generate-queue',
      message: `Queue updated — kept ${futurePending.length} future, rescheduled ${updates.length} overdue, `
        + `added ${inserts.length} new (sent today ${sentToday ?? 0}/${dailyTarget})`,
    }]);

    return new Response(JSON.stringify({
      generated:  inserts.length,
      repacked:   updates.length,
      sent_today: sentToday ?? 0,
      target:     dailyTarget,
      is_weekend: isWeekend,
      date:       todayStr,
    }), { headers: { ...cors, 'Content-Type': 'application/json' } });

  } catch (e: any) {
    await supabase.from('error_log').insert([{
      level: 'critical', service: 'generate-queue', message: e.message,
    }]);
    return new Response(JSON.stringify({ success: false, error: e.message }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
});
