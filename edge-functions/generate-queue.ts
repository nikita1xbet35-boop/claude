// Supabase Edge Function: generate-queue
// Continuously tops up the daily send queue.
//
// Runs every 15 minutes:
//   - Leaves already future-scheduled items UNTOUCHED, so the time shown on
//     the dashboard stays stable and matches when the email actually sends
//   - Reschedules only overdue items (slot in the past) to fire again soon
//   - Appends newly-eligible leads (with contacts) after the last occupied slot
//   - Keeps the queue within the daily target (100 weekday / 30 weekend)
//   - Respects working hours 09:00-18:00 GMT+3 and the 13:00-14:00 lunch break
//
// Deploy: supabase functions deploy generate-queue --no-verify-jwt
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto-injected)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const WEEKDAY_TARGET = 100;
const WEEKEND_TARGET = 30;
// 3-5 min cadence (avg 4) gives ~120 send slots in the 09-18 window minus
// lunch — comfortably enough headroom to actually reach 100/day.
// Randomized so the pattern stays human, not robotic.
const MIN_INTERVAL_MS = 3 * 60 * 1000;
const MAX_INTERVAL_MS = 5 * 60 * 1000;
const START_DELAY_MS  = 90 * 1000;     // first slot is now + 90s

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const EMAIL_RE   = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;
const DISPOSABLE = ['mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail', 'throwaway'];

function isSendableEmail(e: string | null): boolean {
  if (!e) return false;
  const l = e.toLowerCase();
  if (DISPOSABLE.some(d => l.includes(d))) return false;
  return EMAIL_RE.test(e);
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

    // System pause check
    const { data: sysRow } = await supabase
      .from('api_usage').select('system_paused').eq('service', 'gmail_main').single();
    if (sysRow?.system_paused) {
      return new Response(JSON.stringify({ generated: 0, repacked: 0, skipped: true, reason: 'system paused' }),
        { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    // GMT+3 day boundaries / working window (as UTC instants)
    const todayMidnightUTC    = new Date(`${todayStr}T00:00:00+03:00`);
    const tomorrowMidnightUTC = new Date(todayMidnightUTC.getTime() + 24 * 60 * 60 * 1000);
    const workStartMs = new Date(`${todayStr}T09:00:00+03:00`).getTime();
    const workEndMs   = new Date(`${todayStr}T18:00:00+03:00`).getTime();
    const lunchStart  = new Date(`${todayStr}T13:00:00+03:00`).getTime();
    const lunchEnd    = new Date(`${todayStr}T14:00:00+03:00`).getTime();

    // After the work day — nothing to schedule today
    if (nowMs >= workEndMs) {
      return new Response(JSON.stringify({ generated: 0, repacked: 0, skipped: true, reason: 'after working hours' }),
        { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    const dayOfWeek    = nowGMT3.getUTCDay();
    const isWeekend    = dayOfWeek === 0 || dayOfWeek === 6;
    const dailyTarget  = isWeekend ? WEEKEND_TARGET : WEEKDAY_TARGET;

    // How many were already sent today
    const { count: sentToday } = await supabase
      .from('email_log')
      .select('id', { count: 'exact', head: true })
      .gte('sent_at', todayMidnightUTC.toISOString())
      .lt('sent_at',  tomorrowMidnightUTC.toISOString());

    const capacity = dailyTarget - (sentToday ?? 0);
    if (capacity <= 0) {
      return new Response(JSON.stringify({ generated: 0, repacked: 0, skipped: true, reason: 'daily target reached' }),
        { headers: { ...cors, 'Content-Type': 'application/json' } });
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
      // Emails contacted in the last 30 days — dedup by address (spec §9)
      const thirtyDaysAgo = new Date(nowMs - 30 * 24 * 60 * 60 * 1000).toISOString();
      const { data: recentSent } = await supabase
        .from('email_log').select('email').gt('sent_at', thirtyDaysAgo);
      const emailedSet = new Set(
        (recentSent || []).map((r: any) => (r.email || '').toLowerCase()).filter(Boolean),
      );
      const queuedLeadIds = new Set(livePending.map(p => p.lead_id));

      const { data: candidates, error: leadsErr } = await supabase
        .from('leads')
        .select('id, brand, contact_email')
        .eq('stage', 'new')
        .not('contact_email', 'is', null)
        .neq('contact_email', '')
        .order('created_at', { ascending: true })
        .limit(600);
      if (leadsErr) throw new Error(`leads query failed: ${leadsErr.message}`);

      for (const l of (candidates || [])) {
        if (newLeads.length >= newQuota) break;
        if (queuedLeadIds.has(l.id)) continue;
        if (!isSendableEmail(l.contact_email)) continue;
        if (emailedSet.has(l.contact_email.toLowerCase())) continue;
        newLeads.push({ id: l.id, brand: l.brand });
      }
    }

    // ── Scheduling ──────────────────────────────────────────────────────────
    // Future-scheduled items are LEFT UNTOUCHED so the dashboard's displayed
    // times stay stable. We only reschedule overdue items and append new leads
    // after the last occupied slot.
    const updates: Array<{ id: number; scheduled_at: string }> = [];
    const inserts: Array<Record<string, unknown>> = [];

    // Advance cursor past lunch / clamp to the working window.
    const advance = (c: number): number => {
      if (c >= lunchStart && c < lunchEnd) c = lunchEnd;
      return c;
    };

    // 1. Overdue items fire first — densely from now+delay.
    let cursor = advance(Math.max(nowMs + START_DELAY_MS, workStartMs));
    for (const p of overduePending) {
      cursor = advance(cursor);
      if (cursor >= workEndMs) break;
      updates.push({ id: p.id as number, scheduled_at: new Date(cursor).toISOString() });
      cursor += randInterval();
    }

    // 2. New leads continue after both the overdue burst and any future items.
    const latestFuture = futurePending.reduce(
      (max, p) => Math.max(max, new Date(p.scheduled_at as string).getTime()), 0,
    );
    cursor = advance(Math.max(cursor, latestFuture + randInterval()));
    for (const l of newLeads) {
      cursor = advance(cursor);
      if (cursor >= workEndMs) break;
      inserts.push({
        lead_id:       l.id,
        brand:         l.brand,
        gmail_account: l.brand === 'luckypari' ? 'lp' : 'main',
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
