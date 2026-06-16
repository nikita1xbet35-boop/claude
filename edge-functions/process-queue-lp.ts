// Supabase Edge Function: process-queue-lp
// LuckyPari outreach — reads lp_outreach table, sends via Gmail (send-email, account='lp').
// Completely separate from the 1xBet pipeline: own daily quota, own template, own log.
// Uses the dedicated LuckyPari Gmail (nick.adflow@gmail.com via GMAIL_USER_LP/GMAIL_PASS_LP).
//
// Working hours: 08:00–20:00 GMT+3 (12h window)
// Daily cap: 100 emails/day, spread across all 12h via hourly limit (≤10/hour)
//
// Deploy: supabase functions deploy process-queue-lp --no-verify-jwt

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL  = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const FUNCTIONS_URL = SUPABASE_URL + '/functions/v1';

// 100/day over 12 working hours → ~8-9/hour. Cron fires every 7 min (~9x/hour)
// and we send ONE per tick, so messages go out ~7 min apart with no bursts.
const DAILY_LIMIT   = 100;
const HOURLY_LIMIT  = 9;
const BATCH_SIZE    = 1;
const MAX_RETRIES   = 3;
const SEND_DELAY_MS = 1500;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function toGMT3(date: Date) {
  const gmt3 = new Date(date.getTime() + 3 * 60 * 60 * 1000);
  return {
    hour:    gmt3.getUTCHours(),
    dateStr: gmt3.toISOString().slice(0, 10),
  };
}

async function callFunction(name: string, body: Record<string, unknown>) {
  const res = await fetch(`${FUNCTIONS_URL}/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

// GEO code → country name
const GEO_NAMES: Record<string, string> = {
  NG: 'Nigeria', KE: 'Kenya', GH: 'Ghana', PH: 'Philippines',
  IN: 'India', PK: 'Pakistan', BD: 'Bangladesh', NP: 'Nepal',
  MY: 'Malaysia', ID: 'Indonesia', VN: 'Vietnam', MM: 'Myanmar',
  AR: 'Argentina', CL: 'Chile', MA: 'Morocco', SN: 'Senegal',
  CI: "Côte d'Ivoire", BF: 'Burkina Faso', CM: 'Cameroun',
  ZA: 'South Africa', EG: 'Egypt', UZ: 'Uzbekistan', KG: 'Kyrgyzstan',
  TZ: 'Tanzania', TH: 'Thailand',
  Global: 'the region', 'Africa FR': 'West Africa', Francophone: 'West Africa',
  'Francophone Africa': 'West Africa', Bangladesh: 'Bangladesh', France: 'France',
};
function geoName(geo: string): string {
  if (!geo) return 'your market';
  const g = geo.trim();
  return GEO_NAMES[g] || GEO_NAMES[g.toUpperCase()] || g;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x27;/gi, "'").replace(/&#39;/g, "'").replace(/&apos;/gi, "'")
    .replace(/&quot;/gi, '"').replace(/&#34;/g, '"')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&');
}
function toAsciiSafe(s: string): string {
  return s.replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim();
}

function cleanSiteName(leadName: string, leadUrl: string): string {
  let domain = '';
  try {
    const h = new URL(leadUrl).hostname.replace(/^www\./, '');
    domain = h.split('.')[0].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  } catch (_) { /* ignore */ }

  if (!leadName) return domain || 'your site';
  const ascii = toAsciiSafe(decodeEntities(leadName));
  if (!ascii) return domain || 'your site';

  let cleaned = ascii
    .replace(/\([^)]*\d{4}[^)]*\)/g, '')
    .replace(/\b(19|20)\d{2}\b/g, '')
    .replace(/\b\d+\s+(best|top|new|latest)\b/gi, '')
    .replace(/[-|:,–]\s*(review|guide|list|sportsbook|bookmaker|casino|betting|sites?|bonus|offers?|ratings?|vs\.?|comparison|roundup|overview|news|tips?|blog|analysis|rankings?).*$/i, '')
    .replace(/\s{2,}/g, ' ').trim();

  if (cleaned.length < 3) return domain || 'your site';
  if (cleaned.length > 40) cleaned = cleaned.slice(0, 40).replace(/\s+\S*$/, '').trim();
  return cleaned || domain || 'your site';
}

function buildSubject(siteName: string, url: string): string {
  const name = cleanSiteName(siteName, url);
  return `Lucky Pari × ${name} — partnership`;
}

function buildBody(siteName: string, url: string, geo: string): string {
  const name = cleanSiteName(siteName, url);
  const place = geoName(geo);
  return `Hi, I had a look at ${name} and really like what you're doing in ${place}.\n\n`
    + `I'm Nick from Lucky Pari Partners — the official affiliate program for Lucky Pari, `
    + `a licensed betting and casino brand with real traction in your market.\n\n`
    + `We offer clean RevShare, fast approval, and you'd be working directly with me — `
    + `no account managers, no waiting. I put together a short proposal for you.\n\n`
    + `Want me to send it over? You can also reach me straight on Telegram: @af_luckypari`;
}

const PLACEHOLDER_LOCAL = new Set([
  'email','test','demo','sample','example','noreply','donotreply','postmaster','mailer','name','user','mail',
]);
function isBadEmail(email: string): boolean {
  if (!email || !email.includes('@')) return true;
  const local = email.split('@')[0].toLowerCase();
  if (PLACEHOLDER_LOCAL.has(local)) return true;
  // malformed domain-as-local-part (e.g. site.com.ng@gmail.com)
  if (/\.(com|net|org|co|info|me|io)\.[a-z]{2,3}$/.test(local)) return true;
  return false;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const stats = { processed: 0, sent: 0, failed: 0, skipped: 0, reason: '' };

  try {
    const now = new Date();
    const { hour, dateStr } = toGMT3(now);

    // Working hours 08:00–20:00 GMT+3
    if (hour < 8 || hour >= 20) {
      stats.reason = hour < 8 ? 'before working hours' : 'after working hours';
      return new Response(JSON.stringify(stats), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    const gmt3DayStart = new Date(`${dateStr}T00:00:00+03:00`);
    const gmt3DayEnd   = new Date(`${dateStr}T23:59:59+03:00`);

    // Daily cap check
    const { count: sentToday } = await supabase
      .from('lp_outreach')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'sent')
      .gte('sent_at', gmt3DayStart.toISOString())
      .lte('sent_at', gmt3DayEnd.toISOString());

    if ((sentToday ?? 0) >= DAILY_LIMIT) {
      stats.reason = `daily cap reached (${sentToday}/${DAILY_LIMIT})`;
      return new Response(JSON.stringify(stats), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    // Hourly cap — spread 50/day evenly across 12 working hours (max 5/hour)
    // hourStart is the UTC timestamp of the start of the current GMT+3 hour
    const gmt3HourStartUtc = new Date(new Date(`${dateStr}T${String(hour).padStart(2,'0')}:00:00+03:00`).toISOString());
    const { count: sentThisHour } = await supabase
      .from('lp_outreach')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'sent')
      .gte('sent_at', gmt3HourStartUtc.toISOString());

    if ((sentThisHour ?? 0) >= HOURLY_LIMIT) {
      stats.reason = `hourly cap reached (${sentThisHour}/${HOURLY_LIMIT})`;
      return new Response(JSON.stringify(stats), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    // Limit batch so we don't blow the hourly cap in a single tick
    const canSend = Math.min(BATCH_SIZE, HOURLY_LIMIT - (sentThisHour ?? 0));

    // Fetch pending / retryable items
    const { data: items, error: fetchErr } = await supabase
      .from('lp_outreach')
      .select('*')
      .in('status', ['pending', 'failed'])
      .lt('retry_count', MAX_RETRIES)
      .lte('scheduled_at', now.toISOString())
      .order('scheduled_at', { ascending: true })
      .limit(canSend);

    if (fetchErr) throw new Error(`lp_outreach query failed: ${fetchErr.message}`);
    if (!items || items.length === 0) {
      stats.reason = 'no pending items';
      return new Response(JSON.stringify(stats), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    for (const item of items) {
      stats.processed++;

      // Email sanity check
      if (isBadEmail(item.email)) {
        await supabase.from('lp_outreach').update({ status: 'skipped', error: 'bad email' }).eq('id', item.id);
        stats.skipped++;
        continue;
      }

      // Dedup — never send twice to the same address from LuckyPari itself.
      // NOTE: cross-brand dedup (email_log) is intentionally NOT applied here.
      // The LP base overlaps almost entirely with addresses 1xBet already mailed,
      // and LuckyPari is a separate brand/offer, so we DO contact them again.
      const { count: lpSent } = await supabase
        .from('lp_outreach').select('id', { count: 'exact', head: true })
        .eq('email', item.email).eq('status', 'sent');
      if ((lpSent ?? 0) > 0) {
        await supabase.from('lp_outreach')
          .update({ status: 'skipped', error: 'duplicate: already sent by LP' }).eq('id', item.id);
        stats.skipped++;
        continue;
      }

      const subject = buildSubject(item.site_name || '', item.url || '');
      const body    = buildBody(item.site_name || '', item.url || '', item.geo || '');

      let result: { ok: boolean; data: Record<string, unknown> };
      try {
        result = await callFunction('send-email', { to: item.email, subject, body, account: 'lp' }) as typeof result;
      } catch (e: any) {
        const msg = `Network error: ${e.message}`;
        const newRetry = (item.retry_count ?? 0) + 1;
        const permanent = newRetry >= MAX_RETRIES;
        await supabase.from('lp_outreach').update({
          status: permanent ? 'skipped' : 'failed', error: msg, retry_count: newRetry,
        }).eq('id', item.id);
        stats.failed++;
        continue;
      }

      if (result.ok) {
        const sentAt = new Date().toISOString();
        await supabase.from('lp_outreach')
          .update({ status: 'sent', sent_at: sentAt, error: null }).eq('id', item.id);

        // Also log to shared email_log so cross-brand dedup works
        await supabase.from('email_log').insert([{
          lead_id:       null,
          email:         item.email,
          brand:         'luckypari',
          subject,
          gmail_account: 'gmail_lp',
          sent_at:       sentAt,
          bounced:       false,
        }]);

        stats.sent++;
      } else {
        const d   = result.data;
        const msg = (d?.error as string) ?? JSON.stringify(d).slice(0, 200);
        const newRetry = (item.retry_count ?? 0) + 1;
        // 5xx SMTP = permanent reject (invalid address, mailbox full, etc.)
        const isPermanent = /got 5[5-9]\d|SMTP.*55[0-9]|550|551|552|553/.test(msg) || newRetry >= MAX_RETRIES;
        await supabase.from('lp_outreach').update({
          status:      isPermanent ? 'skipped' : 'failed',
          error:       msg,
          retry_count: isPermanent ? MAX_RETRIES : newRetry,
        }).eq('id', item.id);
        if (isPermanent) { stats.skipped++; } else { stats.failed++; }
      }

      if (stats.processed < items.length) await sleep(SEND_DELAY_MS);
    }

    if (stats.reason === '') delete (stats as any).reason;
    await supabase.from('error_log').insert([{
      level: 'info', service: 'process-queue-lp',
      message: `sent=${stats.sent} failed=${stats.failed} skipped=${stats.skipped} today=${(sentToday ?? 0) + stats.sent}`,
    }]);

    return new Response(JSON.stringify(stats), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    });

  } catch (e: any) {
    await supabase.from('error_log').insert([{ level: 'critical', service: 'process-queue-lp', message: e.message }]);
    return new Response(
      JSON.stringify({ ...stats, error: e.message }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } },
    );
  }
});
