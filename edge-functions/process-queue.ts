// Supabase Edge Function: process-queue
// Processes send_queue table and dispatches emails via the send-gmail edge function.
// Respects working hours (09:00–18:00 GMT+3, skip lunch 13:00–14:00),
// weekend throttle (≤30 sends/day on Sat/Sun), and per-account daily quota (100 emails).
// Deploy: supabase functions deploy process-queue
// Env vars needed: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL  = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SUPABASE_ANON = Deno.env.get('SUPABASE_ANON_KEY') || '';
const FUNCTIONS_URL = SUPABASE_URL + '/functions/v1';

// Per-account daily send limit
const ACCOUNT_DAILY_LIMIT = 100;
// Max emails per queue run
const BATCH_SIZE = 5;
// Max retries before marking skipped
const MAX_RETRIES = 3;
// Weekend daily send cap (30% of 100)
const WEEKEND_DAILY_CAP = 30;
// Delay between sends in ms
const SEND_DELAY_MS = 500;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Convert a UTC Date to the equivalent GMT+3 wall-clock fields. */
function toGMT3(date: Date): { hour: number; minute: number; dayOfWeek: number; dateStr: string } {
  const gmt3 = new Date(date.getTime() + 3 * 60 * 60 * 1000);
  const hour      = gmt3.getUTCHours();
  const minute    = gmt3.getUTCMinutes();
  // getUTCDay() on a shifted date gives the GMT+3 day: 0=Sun,1=Mon,...,6=Sat
  const dayOfWeek = gmt3.getUTCDay();
  // YYYY-MM-DD string in GMT+3 for "today" comparisons
  const dateStr = gmt3.toISOString().slice(0, 10);
  return { hour, minute, dayOfWeek, dateStr };
}

/** Sleep for `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Call another edge function with the service role key. */
async function callFunction(name: string, body: Record<string, unknown>): Promise<{ ok: boolean; data: unknown }> {
  const res = await fetch(`${FUNCTIONS_URL}/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

/** Log an error to error_log table. */
async function logError(level: string, service: string, message: string, lead_id?: string) {
  await supabase.from('error_log').insert([{
    level,
    service,
    message,
    ...(lead_id ? { lead_id } : {}),
  }]);
}

/** Send a Telegram alert via the send-alert edge function. */
async function sendAlert(level: string, service: string, message: string) {
  await callFunction('send-alert', { level, service, message });
}

/** Build the subject line for a queue item. */
function buildSubject(itemId: string, leadName: string, brand: string): string {
  // Use last hex digit of UUID as a numeric discriminator (0–15 → mod 4 → 0–3)
  const lastHex = itemId.replace(/-/g, '').slice(-1);
  const variant = parseInt(lastHex, 16) % 4;

  const brandDisplay = brand === '1xcasino' ? '1xCasino' : '1xBet';
  const sitename     = leadName || 'your site';

  switch (variant) {
    case 0: return `${brandDisplay} × ${sitename} — partnership`;
    case 1: return `${sitename} × ${brandDisplay} — partnership`;
    case 2: return `Partnership inquiry — ${sitename} × ${brandDisplay}`;
    case 3: return `${brandDisplay} for ${sitename} — quick chat?`;
    default: return `${brandDisplay} × ${sitename} — partnership`;
  }
}

// ── Main handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const stats = { processed: 0, sent: 0, failed: 0, skipped: 0, reason: '' };

  try {
    const now = new Date();

    // ── 1. Check system pause ─────────────────────────────────────────────────
    const { data: gmailUsage, error: usageErr } = await supabase
      .from('api_usage')
      .select('service, paused, system_paused')
      .eq('service', 'gmail_main')
      .single();

    if (usageErr && usageErr.code !== 'PGRST116') {
      throw new Error(`api_usage query failed: ${usageErr.message}`);
    }

    if (gmailUsage && (gmailUsage.system_paused || gmailUsage.paused)) {
      stats.reason = 'system paused';
      return new Response(JSON.stringify(stats), {
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    // ── 2. Working hours check (GMT+3, 09:00–18:00, skip 13:00–14:00) ────────
    const { hour, minute, dayOfWeek, dateStr } = toGMT3(now);

    const beforeWorkStart = hour < 9;
    const afterWorkEnd    = hour >= 18;
    const inLunchBreak    = hour === 13; // 13:00–13:59 → skip

    if (beforeWorkStart || afterWorkEnd || inLunchBreak) {
      let reason = 'outside working hours';
      if (inLunchBreak) reason = 'lunch break (13:00–14:00 GMT+3)';
      else if (beforeWorkStart) reason = 'before working hours (09:00 GMT+3)';
      else reason = 'after working hours (18:00 GMT+3)';

      stats.reason = reason;
      return new Response(JSON.stringify(stats), {
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    // ── 3. Weekend throttle ────────────────────────────────────────────────────
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6; // Sun=0, Sat=6

    if (isWeekend) {
      // Count emails already sent today (GMT+3 day)
      const dayStart = `${dateStr}T00:00:00.000Z`; // Approximate — exact offset handled below
      // Build precise GMT+3 day boundaries in UTC
      const gmt3DayStart = new Date(`${dateStr}T00:00:00+03:00`);
      const gmt3DayEnd   = new Date(`${dateStr}T23:59:59+03:00`);

      const { count: sentTodayCount } = await supabase
        .from('email_log')
        .select('id', { count: 'exact', head: true })
        .gte('sent_at', gmt3DayStart.toISOString())
        .lte('sent_at', gmt3DayEnd.toISOString());

      if ((sentTodayCount ?? 0) >= WEEKEND_DAILY_CAP) {
        stats.reason = `weekend cap reached (${sentTodayCount}/${WEEKEND_DAILY_CAP})`;
        return new Response(JSON.stringify(stats), {
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }
    }

    // ── 4. Fetch pending queue items ──────────────────────────────────────────
    const { data: queueItems, error: queueErr } = await supabase
      .from('send_queue')
      .select('*')
      .eq('status', 'pending')
      .lte('scheduled_at', now.toISOString())
      .order('scheduled_at', { ascending: true })
      .limit(BATCH_SIZE);

    if (queueErr) throw new Error(`send_queue query failed: ${queueErr.message}`);
    if (!queueItems || queueItems.length === 0) {
      stats.reason = 'no pending items';
      return new Response(JSON.stringify(stats), {
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    // Cache for per-account quota counts within this run to avoid redundant queries
    const accountQuotaCache: Record<string, number> = {};

    // ── 5. Process each item ──────────────────────────────────────────────────
    for (const item of queueItems) {
      stats.processed++;

      // ── 5a. Check per-account daily quota ──────────────────────────────────
      const account: string = item.gmail_account; // 'main' or 'lp'
      const usageService    = account === 'lp' ? 'gmail_lp' : 'gmail_main';

      if (!(account in accountQuotaCache)) {
        const gmt3DayStart = new Date(`${dateStr}T00:00:00+03:00`);
        const gmt3DayEnd   = new Date(`${dateStr}T23:59:59+03:00`);

        const { count } = await supabase
          .from('email_log')
          .select('id', { count: 'exact', head: true })
          .eq('gmail_account', account)
          .gte('sent_at', gmt3DayStart.toISOString())
          .lte('sent_at', gmt3DayEnd.toISOString());

        accountQuotaCache[account] = count ?? 0;
      }

      if (accountQuotaCache[account] >= ACCOUNT_DAILY_LIMIT) {
        // Skip this item — quota exhausted for this account
        stats.skipped++;
        continue;
      }

      // ── 5b. Fetch lead ──────────────────────────────────────────────────────
      const { data: lead, error: leadErr } = await supabase
        .from('leads')
        .select('*')
        .eq('id', item.lead_id)
        .single();

      if (leadErr || !lead) {
        const errMsg = leadErr?.message ?? 'lead not found';
        await logError('error', 'process-queue', `Lead ${item.lead_id} not found: ${errMsg}`, item.lead_id);
        await markFailed(item, errMsg);
        stats.failed++;
        continue;
      }

      // ── 5c. Build subject ───────────────────────────────────────────────────
      const subject = buildSubject(item.id, lead.name, item.brand);

      // ── 5d. Generate email body ─────────────────────────────────────────────
      let body = '';
      try {
        const msgResult = await callFunction('generate-message', {
          lead_id: item.lead_id,
          brand: item.brand,
          account,
        });
        if (msgResult.ok) {
          const msgData = msgResult.data as Record<string, unknown>;
          body = (msgData?.message || msgData?.body || '') as string;
        }
      } catch (_) {}

      // Fallback template if generate-message failed
      if (!body) {
        const brandDisplay = item.brand === '1xcasino' ? '1xCasino' : '1xBet';
        const managerName  = account === 'lp' ? 'Andreas' : 'Nick';
        body = `Hi ${lead.name || 'there'},\n\nI came across ${lead.url} and would love to discuss a partnership opportunity with ${brandDisplay}.\n\nWe offer competitive commissions and dedicated support.\n\nWould you be open to a quick chat?\n\nBest regards,\n${managerName}`;
      }

      // ── 5e. Call send-email ─────────────────────────────────────────────────
      let sendResult: { ok: boolean; data: unknown };
      try {
        sendResult = await callFunction('send-email', {
          to:      lead.contact_email,
          subject,
          body,
          account,
        });
      } catch (fetchErr: any) {
        const errMsg = `Network error calling send-email: ${fetchErr.message}`;
        await logError('error', 'process-queue', errMsg, item.lead_id);
        await markFailed(item, errMsg);
        stats.failed++;
        continue;
      }

      // ── 5e. Success path ────────────────────────────────────────────────────
      if (sendResult.ok) {
        const sentAt = new Date().toISOString();

        // Update send_queue
        await supabase
          .from('send_queue')
          .update({ status: 'sent', sent_at: sentAt })
          .eq('id', item.id);

        // Extract gmail_message_id if returned by send-gmail
        const responseData = sendResult.data as Record<string, unknown> | null;
        const gmailMessageId = responseData?.gmail_message_id as string | undefined;

        // Insert into email_log
        await supabase.from('email_log').insert([{
          lead_id:          item.lead_id,
          email:            lead.contact_email,
          brand:            item.brand,
          subject,
          gmail_account:    account,
          sent_at:          sentAt,
          bounced:          false,
          ...(gmailMessageId ? { gmail_message_id: gmailMessageId } : {}),
        }]);

        // Increment api_usage counter
        const { data: currentUsage } = await supabase
          .from('api_usage')
          .select('used')
          .eq('service', usageService)
          .single();

        await supabase
          .from('api_usage')
          .update({
            used:       ((currentUsage?.used ?? 0) as number) + 1,
            updated_at: sentAt,
          })
          .eq('service', usageService);

        // Update lead stage to 'waiting'
        await supabase
          .from('leads')
          .update({ stage: 'waiting' })
          .eq('id', item.lead_id);

        // Update local quota cache
        accountQuotaCache[account]++;

        stats.sent++;
      } else {
        // ── 5f. Error path ──────────────────────────────────────────────────
        const responseData = sendResult.data as Record<string, unknown> | null;
        const errMsg = (responseData?.error as string) ?? 'send-gmail returned non-OK response';

        await logError('error', 'process-queue', `send-email failed for queue item ${item.id}: ${errMsg}`, item.lead_id);
        const wasPersistent = await markFailed(item, errMsg);

        if (wasPersistent) {
          // Retry count was already >= MAX_RETRIES-1 → now skipped
          await sendAlert(
            'warning',
            'process-queue',
            `Queue item ${item.id} (lead ${item.lead_id}) permanently skipped after ${MAX_RETRIES} retries: ${errMsg}`
          );
          stats.skipped++;
        } else {
          stats.failed++;
        }
      }

      // ── 5g. Wait between sends ──────────────────────────────────────────────
      if (stats.processed < queueItems.length) {
        await sleep(SEND_DELAY_MS);
      }
    }

    // Remove generic reason if we actually processed items
    if (stats.reason === '') delete (stats as any).reason;

    return new Response(JSON.stringify(stats), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  } catch (e: any) {
    await logError('critical', 'process-queue', e.message);
    return new Response(
      JSON.stringify({ ...stats, error: e.message }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } }
    );
  }
});

// ── markFailed ────────────────────────────────────────────────────────────────
// Updates send_queue for a failed send. Returns true if the item was permanently
// skipped (retry_count reached MAX_RETRIES), false if it remains 'failed'.
async function markFailed(item: Record<string, unknown>, errMsg: string): Promise<boolean> {
  const currentRetries = (item.retry_count as number) ?? 0;
  const newRetryCount  = currentRetries + 1;
  const permanent      = newRetryCount >= MAX_RETRIES;

  await supabase
    .from('send_queue')
    .update({
      status:      permanent ? 'skipped' : 'failed',
      error:       errMsg,
      retry_count: newRetryCount,
    })
    .eq('id', item.id);

  return permanent;
}
