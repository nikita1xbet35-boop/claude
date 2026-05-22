// Supabase Edge Function: generate-queue
// Builds and continuously tops up the daily send queue.
//
// Runs every 15 minutes (rolling model — NOT once a day):
//   - Repacks all still-pending items into a tight 5-7 min cadence from now
//   - Pulls in newly-eligible leads (with contacts) found since the last run
//   - Keeps the queue within the daily target (100 weekday / 30 weekend)
//   - Respects working hours 09:00-18:00 GMT+3 and the 13:00-14:00 lunch break
//
// This replaces the old "schedule the whole day at 08:00" approach, which
// spread a handful of leads hours apart. With the rolling model, sends happen
// every 5-7 minutes as long as there are leads with contacts available.
//
// Deploy: supabase functions deploy generate-queue
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto-injected)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const WEEKDAY_TARGET = 100;
const WEEKEND_TARGET = 30;
// 4-6 min cadence (avg 5) fits ~96 sends into the 09-18 window minus lunch.
// Randomized so the pattern stays human, not robotic.
const MIN_INTERVAL_MS = 4 * 60 * 1000;
const MAX_INTERVAL_MS = 6 * 60 * 1000;
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

    // All still-pending queue items — these get repacked into a tight cadence
    const { data: pendingRaw, error: pendErr } = await supabase
      .from('send_queue')
      .select('id, lead_id, brand, gmail_account')
      .eq('status', 'pending')
      .order('scheduled_at', { ascending: true })
      .order('id', { ascending: true });
    if (pendErr) throw new Error(`send_queue query failed: ${pendErr.message}`);

    // Drop queue items whose lead has no contact_email — endless repacking with nothing to send.
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

    const pending = (pendingRaw || [])
      .filter(p => !noContactLeadIds.has(p.lead_id as string))
      .slice(0, capacity);

    // Fill remaining capacity with new eligible leads
    const newQuota = capacity - pending.length;
    let newLeads: Array<{ id: string; brand: string }> = [];

    if (newQuota > 0) {
      // Emails contacted in the last 30 days — dedup by address (spec §9)
      const thirtyDaysAgo = new Date(nowMs - 30 * 24 * 60 * 60 * 1000).toISOString();
      const { data: recentSent } = await supabase
        .from('email_log').select('email').gt('sent_at', thirtyDaysAgo);
      const emailedSet = new Set(
        (recentSent || []).map((r: any) => (r.email || '').toLowerCase()).filter(Boolean),
      );
      const queuedLeadIds = new Set(pending.map(p => p.lead_id));

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

    // Build the schedule: repacked pending rows first, then new leads
    type Slot = { kind: 'update'; queueId: number } | { kind: 'insert'; leadId: string; brand: string };
    const slots: Slot[] = [
      ...pending.map(p => ({ kind: 'update' as const, queueId: p.id as number })),
      ...newLeads.map(l => ({ kind: 'insert' as const, leadId: l.id, brand: l.brand })),
    ];

    let cursor = Math.max(nowMs + START_DELAY_MS, workStartMs);

    const updates: Array<{ id: number; scheduled_at: string }> = [];
    const inserts: Array<Record<string, unknown>> = [];

    for (const slot of slots) {
      // Jump over the lunch break
      if (cursor >= lunchStart && cursor < lunchEnd) cursor = lunchEnd;
      // Day is over — remaining leads wait for tomorrow
      if (cursor >= workEndMs) break;

      const scheduledAt = new Date(cursor).toISOString();

      if (slot.kind === 'update') {
        updates.push({ id: slot.queueId, scheduled_at: scheduledAt });
      } else {
        inserts.push({
          lead_id:       slot.leadId,
          brand:         slot.brand,
          gmail_account: slot.brand === 'luckypari' ? 'lp' : 'main',
          scheduled_at:  scheduledAt,
          status:        'pending',
        });
      }

      cursor += randInterval();
    }

    // Apply: repack existing rows, insert new ones
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
      message: `Queue updated — repacked ${updates.length}, added ${inserts.length} (sent today ${sentToday ?? 0}/${dailyTarget})`,
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
