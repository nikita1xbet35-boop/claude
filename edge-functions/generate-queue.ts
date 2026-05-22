// Supabase Edge Function: generate-queue
// Generates the daily send schedule and fills send_queue with emails
// distributed throughout the working day in a human-like pattern.
//
// Distribution (100 emails/day, 09:00-18:00 GMT+3, lunch 13:00-14:00):
//   09:00-11:00 → 15 emails
//   11:00-13:00 → 30 emails
//   13:00-14:00 → 0 (lunch)
//   14:00-17:00 → 40 emails
//   17:00-18:00 → 15 emails
//
// Weekend: 30 emails (same proportional distribution).
//
// Deploy: supabase functions deploy generate-queue
// Env vars needed: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Time window definitions ──────────────────────────────────────────────────
// Each window: [startHour, endHour, fraction of daily total]
const WINDOWS = [
  { start: 9,  end: 11, weight: 15 },
  { start: 11, end: 13, weight: 30 },
  // 13-14 lunch break — skipped
  { start: 14, end: 17, weight: 40 },
  { start: 17, end: 18, weight: 15 },
];
const TOTAL_WEIGHT = WINDOWS.reduce((s, w) => s + w.weight, 0); // 100

/**
 * Generate N timestamps within [startHour, endHour) on the given date (GMT+3).
 * Applies ±2-3 min jitter around evenly spaced slots.
 */
function generateTimestamps(
  dateGMT3: Date,
  startHour: number,
  endHour: number,
  count: number
): Date[] {
  if (count <= 0) return [];

  const windowMinutes = (endHour - startHour) * 60;
  const timestamps: Date[] = [];

  // Evenly space slots, then add jitter
  for (let i = 0; i < count; i++) {
    // Base offset within window (in minutes)
    const baseOffset = (i / count) * windowMinutes + Math.random() * (windowMinutes / count);
    const clampedOffset = Math.min(baseOffset, windowMinutes - 1);

    const hours   = startHour + Math.floor(clampedOffset / 60);
    const minutes = Math.floor(clampedOffset % 60);

    // Apply ±2-3 min jitter, ensure result stays in [startHour, endHour)
    const jitter = Math.floor(Math.random() * 6) - 3; // -3 to +2
    let totalMinutes = hours * 60 + minutes + jitter;
    totalMinutes = Math.max(startHour * 60, Math.min(endHour * 60 - 1, totalMinutes));

    const finalHour = Math.floor(totalMinutes / 60);
    // Use non-round minute; try the computed minute first, adjust if round
    let finalMinute = totalMinutes % 60;
    if (finalMinute % 5 === 0) {
      // Shift by 1-2 min while staying in window
      const bump = (Math.random() < 0.5 ? 1 : 2) * (Math.random() < 0.5 ? 1 : -1);
      const adjusted = totalMinutes + bump;
      if (adjusted >= startHour * 60 && adjusted < endHour * 60) {
        finalMinute = adjusted % 60;
      } else {
        finalMinute = (finalMinute + 1) % 60;
      }
    }

    // Add random seconds (non-zero) for extra human-like feel
    const seconds = 7 + Math.floor(Math.random() * 47); // 7-53 seconds

    // Build UTC timestamp: dateGMT3 is already midnight in GMT+3 expressed as UTC
    // dateGMT3.getTime() is the UTC ms of GMT+3 midnight
    const utcMs = dateGMT3.getTime() + (finalHour * 60 + finalMinute - 3 * 60) * 60 * 1000 + seconds * 1000;
    timestamps.push(new Date(utcMs));
  }

  // Sort chronologically
  timestamps.sort((a, b) => a.getTime() - b.getTime());
  return timestamps;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    const now = new Date();

    // ── Determine today's date in GMT+3 ────────────────────────────────────
    const gmt3offset = 3 * 60 * 60 * 1000;
    const nowGMT3    = new Date(now.getTime() + gmt3offset);

    // Midnight of today in GMT+3, expressed as a plain UTC Date
    const todayGMT3 = new Date(nowGMT3);
    todayGMT3.setUTCHours(0, 0, 0, 0);
    // todayGMT3 is now: "today 00:00 GMT+3" = "today 00:00 UTC - 3h" as UTC ms
    const todayMidnightUTC = new Date(todayGMT3.getTime() - gmt3offset);

    const tomorrowMidnightUTC = new Date(todayMidnightUTC.getTime() + 24 * 60 * 60 * 1000);

    // Date string for logging
    const todayStr = nowGMT3.toISOString().slice(0, 10); // YYYY-MM-DD

    // ── Step 1: Check if queue already generated for today ──────────────────
    // FIX: with head:true, data=null and count is a separate field — must destructure count directly
    const { count: existingCount, error: existingError } = await supabase
      .from('send_queue')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending')
      .gte('scheduled_at', todayMidnightUTC.toISOString())
      .lt('scheduled_at',  tomorrowMidnightUTC.toISOString());

    if (existingError) throw existingError;

    if ((existingCount ?? 0) > 0) {
      return new Response(JSON.stringify({
        generated: 0,
        date:       todayStr,
        skipped:    true,
        reason:     'Queue already generated for today',
      }), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    // ── Step 2: Determine target count (weekend vs weekday) ─────────────────
    const dayOfWeek = nowGMT3.getUTCDay(); // 0=Sun, 6=Sat
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    const target    = isWeekend ? 30 : 100;

    // ── Step 3: Collect excluded lead IDs ──────────────────────────────────
    // FIX: PostgREST does not support SQL subqueries in URL params.
    // Fetch excluded IDs as separate queries, then pass integer arrays.

    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const [recentlySentRes, alreadyQueuedRes] = await Promise.all([
      supabase
        .from('email_log')
        .select('lead_id')
        .gt('sent_at', thirtyDaysAgo),
      supabase
        .from('send_queue')
        .select('lead_id')
        .gte('scheduled_at', todayMidnightUTC.toISOString())
        .lt('scheduled_at',  tomorrowMidnightUTC.toISOString()),
    ]);

    if (recentlySentRes.error) throw recentlySentRes.error;
    if (alreadyQueuedRes.error) throw alreadyQueuedRes.error;

    const excludedIds: number[] = [
      ...(recentlySentRes.data  || []).map((r: any) => r.lead_id),
      ...(alreadyQueuedRes.data || []).map((r: any) => r.lead_id),
    ].filter(Boolean);

    // ── Step 4: Get eligible leads ──────────────────────────────────────────
    let leadsQuery = supabase
      .from('leads')
      .select('id, brand, contact_email')
      .eq('stage', 'new')
      .not('contact_email', 'is', null)
      .neq('contact_email', '')
      .limit(target);

    if (excludedIds.length > 0) {
      leadsQuery = leadsQuery.not('id', 'in', `(${excludedIds.join(',')})`);
    }

    const { data: eligibleLeads, error: leadsError } = await leadsQuery;
    if (leadsError) throw leadsError;

    const leads = eligibleLeads || [];
    const count  = Math.min(leads.length, target);

    if (count === 0) {
      await supabase.from('error_log').insert([{
        level:   'info',
        service: 'generate-queue',
        message: `Generated 0 items for queue, date: ${todayStr} — no eligible leads`,
      }]);

      return new Response(JSON.stringify({
        generated:     0,
        date:          todayStr,
        eligible_leads: 0,
      }), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    // ── Step 5: Distribute across time windows ──────────────────────────────
    // Compute per-window email counts (proportional to weight)
    const windowCounts = WINDOWS.map(w => ({
      ...w,
      count: Math.round((w.weight / TOTAL_WEIGHT) * count),
    }));

    // Correct rounding drift so sum equals count
    const assignedSum = windowCounts.reduce((s, w) => s + w.count, 0);
    const drift = count - assignedSum;
    if (drift !== 0) {
      const largest = windowCounts.reduce((a, b) => a.count > b.count ? a : b);
      largest.count += drift;
    }

    // Generate all timestamps
    const allTimestamps: Date[] = [];
    for (const w of windowCounts) {
      const ts = generateTimestamps(todayGMT3, w.start, w.end, w.count);
      allTimestamps.push(...ts);
    }
    allTimestamps.sort((a, b) => a.getTime() - b.getTime());

    // ── Step 6: Build queue rows ────────────────────────────────────────────
    const rows = leads.slice(0, allTimestamps.length).map((lead: any, i: number) => ({
      lead_id:       lead.id,
      brand:         lead.brand,
      gmail_account: lead.brand === 'luckypari' ? 'lp' : 'main',
      scheduled_at:  allTimestamps[i].toISOString(),
      status:        'pending',
    }));

    const { error: insertError } = await supabase.from('send_queue').insert(rows);
    if (insertError) throw insertError;

    // ── Step 7: Log to error_log ────────────────────────────────────────────
    await supabase.from('error_log').insert([{
      level:   'info',
      service: 'generate-queue',
      message: `Generated ${rows.length} items for queue, date: ${todayStr}`,
    }]);

    // ── Step 8: Return summary ──────────────────────────────────────────────
    return new Response(JSON.stringify({
      generated:      rows.length,
      date:           todayStr,
      eligible_leads: leads.length,
      target,
      is_weekend:     isWeekend,
      excluded_leads: excludedIds.length,
    }), { headers: { ...cors, 'Content-Type': 'application/json' } });

  } catch (e: any) {
    console.error('generate-queue error:', e);
    return new Response(JSON.stringify({ success: false, error: e.message }), {
      status: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }
});
