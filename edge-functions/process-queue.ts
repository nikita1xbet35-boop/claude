import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL  = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SUPABASE_ANON = Deno.env.get('SUPABASE_ANON_KEY') || '';
const FUNCTIONS_URL = SUPABASE_URL + '/functions/v1';

const ACCOUNT_DAILY_LIMIT = 100;
const BATCH_SIZE          = 5;
const MAX_RETRIES         = 3;
const WEEKEND_DAILY_CAP   = 30;
const SEND_DELAY_MS       = 500;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function toGMT3(date: Date) {
  const gmt3 = new Date(date.getTime() + 3 * 60 * 60 * 1000);
  return {
    hour:      gmt3.getUTCHours(),
    minute:    gmt3.getUTCMinutes(),
    dayOfWeek: gmt3.getUTCDay(),
    dateStr:   gmt3.toISOString().slice(0, 10),
  };
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function callFunction(name: string, body: Record<string, unknown>) {
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

async function logError(level: string, service: string, message: string, lead_id?: string) {
  await supabase.from('error_log').insert([{
    level, service, message,
    ...(lead_id ? { lead_id } : {}),
  }]);
}

async function sendAlert(level: string, service: string, message: string) {
  await callFunction('send-alert', { level, service, message });
}

// send_queue.id is BIGSERIAL (integer) — use modulo directly for subject variant
function buildSubject(itemId: number, leadName: string, brand: string): string {
  const variant      = itemId % 4;
  const brandDisplay = brand === '1xcasino' ? '1xCasino' : '1xBet';
  const sitename     = leadName || 'your site';
  switch (variant) {
    case 0:  return `${brandDisplay} × ${sitename} — partnership`;
    case 1:  return `${sitename} × ${brandDisplay} — partnership`;
    case 2:  return `Partnership inquiry — ${sitename} × ${brandDisplay}`;
    default: return `${brandDisplay} for ${sitename} — quick chat?`;
  }
}

async function markFailed(item: Record<string, unknown>, errMsg: string): Promise<boolean> {
  const newRetryCount = ((item.retry_count as number) ?? 0) + 1;
  const permanent     = newRetryCount >= MAX_RETRIES;
  await supabase.from('send_queue').update({
    status:      permanent ? 'skipped' : 'failed',
    error:       errMsg,
    retry_count: newRetryCount,
  }).eq('id', item.id);
  return permanent;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const stats = { processed: 0, sent: 0, failed: 0, skipped: 0, reason: '' };

  try {
    const now = new Date();

    // 1. System pause check
    const { data: gmailUsage, error: usageErr } = await supabase
      .from('api_usage')
      .select('paused, system_paused')
      .eq('service', 'gmail_main')
      .single();

    if (usageErr && usageErr.code !== 'PGRST116') {
      throw new Error(`api_usage query failed: ${usageErr.message}`);
    }
    if (gmailUsage?.system_paused || gmailUsage?.paused) {
      stats.reason = 'system paused';
      return new Response(JSON.stringify(stats), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    // 2. Working hours: 09:00–18:00 GMT+3, skip 13:00–14:00
    const { hour, dayOfWeek, dateStr } = toGMT3(now);
    if (hour < 9 || hour >= 18 || hour === 13) {
      stats.reason = hour === 13 ? 'lunch break' : hour < 9 ? 'before working hours' : 'after working hours';
      return new Response(JSON.stringify(stats), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    // 3. Weekend throttle
    const isWeekend    = dayOfWeek === 0 || dayOfWeek === 6;
    const gmt3DayStart = new Date(`${dateStr}T00:00:00+03:00`);
    const gmt3DayEnd   = new Date(`${dateStr}T23:59:59+03:00`);

    if (isWeekend) {
      const { count: sentToday } = await supabase
        .from('email_log')
        .select('id', { count: 'exact', head: true })
        .gte('sent_at', gmt3DayStart.toISOString())
        .lte('sent_at', gmt3DayEnd.toISOString());

      if ((sentToday ?? 0) >= WEEKEND_DAILY_CAP) {
        stats.reason = `weekend cap reached (${sentToday}/${WEEKEND_DAILY_CAP})`;
        return new Response(JSON.stringify(stats), { headers: { ...cors, 'Content-Type': 'application/json' } });
      }
    }

    // 4. Fetch pending queue items due now
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
      return new Response(JSON.stringify(stats), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    const accountQuotaCache: Record<string, number> = {};

    // 5. Process each item
    for (const item of queueItems) {
      stats.processed++;

      const account    = item.gmail_account as string;
      const usageService = account === 'lp' ? 'gmail_lp' : 'gmail_main';

      // Per-account daily quota
      if (!(account in accountQuotaCache)) {
        const { count } = await supabase
          .from('email_log')
          .select('id', { count: 'exact', head: true })
          .eq('gmail_account', account)
          .gte('sent_at', gmt3DayStart.toISOString())
          .lte('sent_at', gmt3DayEnd.toISOString());
        accountQuotaCache[account] = count ?? 0;
      }

      if (accountQuotaCache[account] >= ACCOUNT_DAILY_LIMIT) {
        stats.skipped++;
        continue;
      }

      // Fetch lead
      const { data: lead, error: leadErr } = await supabase
        .from('leads').select('*').eq('id', item.lead_id).single();

      if (leadErr || !lead) {
        const msg = leadErr?.message ?? 'lead not found';
        await logError('error', 'process-queue', `Lead ${item.lead_id} not found: ${msg}`, item.lead_id);
        await markFailed(item, msg);
        stats.failed++;
        continue;
      }

      if (!lead.contact_email) {
        await supabase.from('send_queue')
          .update({ status: 'skipped', error: 'no contact email' })
          .eq('id', item.id);
        stats.skipped++;
        continue;
      }

      const subject = buildSubject(item.id as number, lead.name, item.brand);

      // Generate email body (with fallback)
      let body = '';
      try {
        const msgResult = await callFunction('generate-message', {
          lead_id: item.lead_id, brand: item.brand, account,
        });
        if (msgResult.ok) {
          const d = msgResult.data as Record<string, unknown>;
          body = ((d?.message || d?.body || '') as string);
        }
      } catch (_) {}

      if (!body) {
        const brandDisplay = item.brand === '1xcasino' ? '1xCasino' : '1xBet';
        const managerName  = account === 'lp' ? 'Andreas' : 'Nick';
        body = `Hi ${lead.name || 'there'},\n\nI came across ${lead.url} and would love to discuss a partnership opportunity with ${brandDisplay}.\n\nWe offer competitive commissions and dedicated support.\n\nWould you be open to a quick chat?\n\nBest regards,\n${managerName}`;
      }

      // Send
      let sendResult: { ok: boolean; data: unknown };
      try {
        sendResult = await callFunction('send-email', {
          to: lead.contact_email, subject, body, account,
        });
      } catch (e: any) {
        const msg = `Network error calling send-email: ${e.message}`;
        await logError('error', 'process-queue', msg, item.lead_id);
        await markFailed(item, msg);
        stats.failed++;
        continue;
      }

      if (sendResult.ok) {
        const sentAt = new Date().toISOString();
        const responseData = sendResult.data as Record<string, unknown> | null;
        const gmailMessageId = responseData?.gmail_message_id as string | undefined;

        await supabase.from('send_queue')
          .update({ status: 'sent', sent_at: sentAt }).eq('id', item.id);

        await supabase.from('email_log').insert([{
          lead_id:       item.lead_id,
          email:         lead.contact_email,
          brand:         item.brand,
          subject,
          gmail_account: account,
          sent_at:       sentAt,
          bounced:       false,
          ...(gmailMessageId ? { gmail_message_id: gmailMessageId } : {}),
        }]);

        const { data: cur } = await supabase.from('api_usage')
          .select('used').eq('service', usageService).single();
        await supabase.from('api_usage')
          .update({ used: ((cur?.used ?? 0) as number) + 1, updated_at: sentAt })
          .eq('service', usageService);

        await supabase.from('leads').update({ stage: 'waiting' }).eq('id', item.lead_id);

        accountQuotaCache[account]++;
        stats.sent++;
      } else {
        const d   = sendResult.data as Record<string, unknown> | null;
        const msg = (d?.error as string) ?? 'send-email returned non-OK';
        await logError('error', 'process-queue', `send-email failed for item ${item.id}: ${msg}`, item.lead_id);
        const permanent = await markFailed(item, msg);
        if (permanent) {
          await sendAlert('warning', 'process-queue',
            `Item ${item.id} skipped after ${MAX_RETRIES} retries: ${msg}`);
          stats.skipped++;
        } else {
          stats.failed++;
        }
      }

      if (stats.processed < queueItems.length) await sleep(SEND_DELAY_MS);
    }

    if (stats.reason === '') delete (stats as any).reason;

    return new Response(JSON.stringify(stats), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    });

  } catch (e: any) {
    await logError('critical', 'process-queue', e.message);
    return new Response(
      JSON.stringify({ ...stats, error: e.message }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } },
    );
  }
});
