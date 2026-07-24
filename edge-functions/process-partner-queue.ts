// Supabase Edge Function: process-partner-queue
// Per-base auto-send for the isolated Partner Bases (warm/RevShare outreach).
// Sends through the SAME Gmail (main) as the cold flow, but each base has its own
// template, its own daily limit, and its own pause/start toggle. It NEVER touches
// the cold flow (SEO/YouTube/forms) — different table (partner_leads), different
// counters. A base sends only when sending_enabled = true.
//
// Called by worker.js on the */2 tick. Sends at most PER_RUN leads per invocation,
// respects working hours + a shared Gmail mailbox cap + a per-run jitter so bursts
// don't land on a fixed grid.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto), SUPABASE_ANON_KEY
// (retrigger: prior deploy hit a transient esm.sh 522 while bundling extract-contacts)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL  = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SUPABASE_ANON = Deno.env.get('SUPABASE_ANON_KEY') || '';
const FUNCTIONS_URL = SUPABASE_URL + '/functions/v1';

const MAILBOX_DAILY_LIMIT = 300;  // shared Gmail(main) cap — matches process-queue
const WORK_START = 8, WORK_END = 20;  // GMT+3 working hours
const PER_RUN    = 3;             // leads sent per invocation (across all bases) — with the
                                  // */2 tick this allows ~3×/2min ≈ up to ~80/hour of headroom
const JITTER_SKIP = 0.15;         // fraction of ticks skipped so sends aren't on a grid

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function toGMT3(d: Date) {
  const g = new Date(d.getTime() + 3 * 3600 * 1000);
  return { hour: g.getUTCHours(), dateStr: g.toISOString().slice(0, 10) };
}

function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }

function fill(tpl: string, l: Record<string, unknown>): string {
  return (tpl || '')
    .replace(/\{contact\}/g,    (l.contact as string)   || 'there')
    .replace(/\{geo\}/g,        (l.geo as string)        || '')
    .replace(/\{promocode\}/g,  (l.promocode as string)  || '')
    .replace(/\{deal_terms\}/g, (l.deal_terms as string) || '')
    .replace(/\{vertical\}/g,   (l.vertical as string)   || '');
}

async function sendEmail(to: string, subject: string, body: string): Promise<boolean> {
  try {
    const res = await fetch(FUNCTIONS_URL + '/send-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON, 'Authorization': 'Bearer ' + SUPABASE_ANON },
      body: JSON.stringify({ to, subject, body, account: 'main' }),
    });
    const data = await res.json().catch(() => ({}));
    return res.ok && !!data.success;
  } catch (_) { return false; }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const stats = { sent: 0, skipped: 0, reason: '' };
  try {
    const now = new Date();
    const { hour, dateStr } = toGMT3(now);

    if (hour < WORK_START || hour >= WORK_END) {
      stats.reason = 'outside working hours';
      return new Response(JSON.stringify(stats), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    if (Math.random() < JITTER_SKIP) {
      stats.reason = 'jitter skip';
      return new Response(JSON.stringify(stats), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    // Enabled bases only.
    const { data: bases } = await supabase.from('partner_bases')
      .select('*').eq('sending_enabled', true).order('created_at');
    if (!bases || !bases.length) {
      stats.reason = 'no active bases';
      return new Response(JSON.stringify(stats), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    // Shared Gmail(main) mailbox cap — must count BOTH cold-flow sends and partner
    // sends. Cold sends come from email_log (main, non-partner source); partner
    // sends are counted from the base counters (their email_log insert can fail),
    // so we don't rely on it and never double-count.
    const dayStart = new Date(`${dateStr}T00:00:00+03:00`).toISOString();
    const dayEnd   = new Date(`${dateStr}T23:59:59+03:00`).toISOString();
    const { count: coldMainToday } = await supabase.from('email_log')
      .select('id', { count: 'exact', head: true })
      .eq('gmail_account', 'main').not('source', 'like', 'partner:%')
      .gte('sent_at', dayStart).lte('sent_at', dayEnd);
    const partnerSentStart = bases.reduce((s, b) => {
      const reset = b.last_send_reset ? toGMT3(new Date(b.last_send_reset)).dateStr : '';
      return s + (reset === dateStr ? (b.sent_today ?? 0) : 0); // ignore stale (pre-today) counters
    }, 0);
    const mailboxUsedStart = (coldMainToday ?? 0) + partnerSentStart;
    if (mailboxUsedStart >= MAILBOX_DAILY_LIMIT) {
      stats.reason = 'mailbox daily cap reached';
      return new Response(JSON.stringify(stats), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    let sentThisRun = 0;
    for (const base of bases) {
      if (sentThisRun >= PER_RUN) break;

      // Reset the per-base daily counter at GMT+3 midnight.
      let sentToday = base.sent_today ?? 0;
      const lastReset = base.last_send_reset ? toGMT3(new Date(base.last_send_reset)).dateStr : '';
      if (lastReset !== dateStr) {
        await supabase.from('partner_bases')
          .update({ sent_today: 0, last_send_reset: now.toISOString() }).eq('id', base.id);
        sentToday = 0;
      }
      if (sentToday >= (base.daily_limit ?? 20)) { stats.skipped++; continue; }

      if (!base.template_body) { stats.skipped++; continue; }   // not configured yet
      const subjects = String(base.template_subject || 'Partnership')
        .split('\n').map(s => s.trim()).filter(Boolean);
      if (!subjects.length) { stats.skipped++; continue; }

      // Send a BATCH this run — bounded by PER_RUN (across bases), the base's own
      // daily limit, and the shared mailbox cap. (Previously 1 lead/base/run, which
      // capped a single active base at ~1 email per tick regardless of its limit.)
      const room = Math.max(0, Math.min(
        PER_RUN - sentThisRun,
        (base.daily_limit ?? 20) - sentToday,
        MAILBOX_DAILY_LIMIT - mailboxUsedStart - stats.sent,
      ));
      if (room <= 0) { continue; }

      // Un-sent leads, ordered by id (a random UUID) so sends go out shuffled.
      const { data: leads } = await supabase.from('partner_leads')
        .select('*').eq('base_id', base.id).eq('status', 'new')
        .not('email', 'is', null).order('id', { ascending: true }).limit(room);
      if (!leads?.length) { continue; }

      let baseSent = 0;
      for (const lead of leads) {
        if (sentThisRun >= PER_RUN) break;
        const subject = fill(pick(subjects), lead);
        const body    = fill(base.template_body, lead);
        const ok = await sendEmail(lead.email, subject, body);
        const sentAt = new Date().toISOString();
        if (ok) {
          baseSent++;
          await supabase.from('partner_leads')
            .update({ status: 'sent', sent_at: sentAt, updated_at: sentAt }).eq('id', lead.id);
          // Log against gmail(main) so the shared mailbox cap counts partner sends too.
          await supabase.from('email_log').insert([{
            email: lead.email, brand: base.name, subject,
            gmail_account: 'main', sent_at: sentAt, bounced: false,
            source: 'partner:' + base.name,
          }]).catch(() => {});
          stats.sent++; sentThisRun++;
        } else {
          await supabase.from('error_log').insert([{
            level: 'warning', service: 'process-partner-queue',
            message: `send failed base=${base.name} lead=${lead.id} ${lead.email}`,
          }]).catch(() => {});
          stats.skipped++;
        }
      }

      // Update the base counter + gmail usage once, by the actual number sent.
      if (baseSent > 0) {
        const at = new Date().toISOString();
        await supabase.from('partner_bases')
          .update({ sent_today: sentToday + baseSent, last_send_reset: base.last_send_reset || now.toISOString() })
          .eq('id', base.id);
        const { data: cur } = await supabase.from('api_usage').select('used').eq('service', 'gmail_main').single();
        await supabase.from('api_usage')
          .update({ used: ((cur?.used ?? 0) as number) + baseSent, updated_at: at }).eq('service', 'gmail_main');
      }
    }

    return new Response(JSON.stringify(stats), { headers: { ...cors, 'Content-Type': 'application/json' } });
  } catch (e: any) {
    return new Response(JSON.stringify({ ...stats, error: e.message }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
});
