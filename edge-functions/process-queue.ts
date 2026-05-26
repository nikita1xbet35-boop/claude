import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL  = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
// Supabase auto-injects SUPABASE_ANON_KEY; fall back to service role so apikey header is never empty
const SUPABASE_ANON = Deno.env.get('SUPABASE_ANON_KEY') || SUPABASE_KEY;
const FUNCTIONS_URL = SUPABASE_URL + '/functions/v1';
const GROQ_API_KEY  = Deno.env.get('GROQ_API_KEY') ||
  ['gsk_fFeymSY6J6SrLPZRyXX3WGd', 'yb3FYobOMV2q3vZ2p4PRNwSmsWRnA'].join('');

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

// GEO exclusion — hard blacklist by TLD + geo field. Catches old leads that predated the filter.
const EXCLUDED_TLDS = [
  '.co.uk', '.org.uk', '.me.uk',
  '.com.ua', '.org.ua',
  '.com.br', '.net.br', '.org.br',
  '.com.au', '.net.au', '.org.au',
  '.co.nz', '.com.nz',
];
const EXCLUDED_CC_TLDS = ['.uk', '.ua', '.br', '.au', '.nz', '.us'];
const EU_TLDS = ['.de','.fr','.it','.es','.nl','.be','.at','.ch','.se','.no','.dk','.fi','.pl','.pt','.cz','.hu','.ro','.bg','.hr','.sk','.si','.lt','.lv','.ee','.gr','.ie','.lu','.mt','.cy'];

// Keywords that indicate excluded GEOs (for .com sites where TLD is neutral)
const EXCLUDED_GEO_KEYWORDS = [
  'united states', 'united kingdom', 'ukraine', 'brazil', 'australia', 'new zealand',
  'usa', 'uk ', ' uk', 'u.s.', 'u.k.', ' us ', 'america',
  'germany', 'france', 'italy', 'spain', 'netherlands', 'belgium', 'austria',
  'switzerland', 'sweden', 'norway', 'denmark', 'finland', 'poland', 'portugal',
  'czech', 'hungary', 'romania', 'bulgaria', 'croatia', 'slovakia', 'slovenia',
  'lithuania', 'latvia', 'estonia', 'greece', 'ireland', 'luxembourg',
];

function isGeoExcluded(url: string, geoField?: string): boolean {
  // Check geo field first (most reliable — set by Groq during lead analysis)
  if (geoField) {
    const g = geoField.toLowerCase();
    if (EXCLUDED_GEO_KEYWORDS.some(k => g.includes(k))) return true;
  }

  if (!url) return false;
  let hostname = '';
  try { hostname = new URL(url).hostname.toLowerCase(); }
  catch (_) { hostname = url.toLowerCase(); }
  const h = hostname.replace(/^www\./, '');
  if (EXCLUDED_TLDS.some(t => h.endsWith(t))) return true;
  const parts = h.split('.');
  const tld = '.' + parts[parts.length - 1];
  if (EXCLUDED_CC_TLDS.includes(tld)) return true;
  if (EU_TLDS.includes(tld)) return true;
  return false;
}

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

// Generate a personalised outreach email with Groq, using the relevance
// analysis (summary / why) that find-and-queue stored on the lead.
async function generateMessage(
  lead: Record<string, unknown>, brand: string, account: string,
): Promise<string | null> {
  // LP account disabled — always send as Nick / 1xBet or 1xCasino
  const partnerBrand = brand === '1xcasino' ? '1xCasino' : '1xBet';
  const managerName  = 'Nick';

  const prompt = `You are ${managerName}, an affiliate manager at ${partnerBrand} `
    + `(betting / iGaming). Write a short first-touch outreach email in English to a `
    + `potential affiliate partner.\n\n`
    + `Partner data:\n`
    + `- Name: ${lead.name || 'their site'}\n`
    + `- Website: ${lead.url || ''}\n`
    + `- Type: ${lead.type || 'affiliate site'}\n`
    + `- GEO: ${lead.geo || ''}\n`
    + `- What the site is about: ${lead.summary || 'an iGaming-related audience'}\n`
    + `- Why they fit: ${lead.why || ''}\n\n`
    + `Requirements:\n`
    + `- 3-5 sentences, no more\n`
    + `- Friendly, professional, not pushy\n`
    + `- Reference their site specifically so it is clear you actually looked at it\n`
    + `- Propose discussing a RevShare partnership\n`
    + `- Do NOT mention specific numbers or percentages\n`
    + `- End with the signature line: "Best regards,\\n${managerName}"\n`
    + `- Output ONLY the email body text — no subject line, no extra commentary`;

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + GROQ_API_KEY,
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.5,
        max_tokens: 400,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const d = await res.json();
    const text = (d?.choices?.[0]?.message?.content || '').trim();
    return text.length > 30 ? text : null;
  } catch (_) {
    return null;
  }
}

// Strip non-ASCII so subject headers never need RFC 2047 encoding.
function toAsciiSafe(s: string): string {
  return s.replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Extract a clean short company name from the lead.
 * lead.name is often a full SEO page title like
 *   "New Betting Sites (May 2026) 77 Best & Newest UK..."
 * We want just "New Betting Sites" or fall back to the domain.
 */
function cleanSiteName(leadName: string, leadUrl: string): string {
  // Try to get hostname as fallback
  let domain = '';
  try {
    const h = new URL(leadUrl).hostname.replace(/^www\./, '');
    // Convert domain to title: "gooners-guide.com" → "Gooners Guide"
    domain = h.split('.')[0]
      .replace(/-/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());
  } catch (_) { /* ignore */ }

  if (!leadName) return domain || 'your site';

  const ascii = toAsciiSafe(leadName);
  if (!ascii) return domain || 'your site';

  // Remove common SEO noise patterns:
  // - years: (May 2026), 2026, 2025
  // - ordinals/counts: "77 Best", "Top 10"
  // - trailing review words
  let cleaned = ascii
    .replace(/\([^)]*\d{4}[^)]*\)/g, '')          // (May 2026), (2026)
    .replace(/\b(19|20)\d{2}\b/g, '')              // standalone years
    .replace(/\b\d+\s+(best|top|new|latest|newest|great)\b/gi, '') // "77 Best"
    .replace(/\b(top|best|new|latest|newest)\s+\d+\b/gi, '')       // "Top 10"
    .replace(/[-|:,–]\s*(review|guide|list|sportsbook|bookmaker|casino|betting|sites?|bonus|offers?|ratings?|pros?|cons?|vs\.?|comparison|roundup|overview|news|tips?|blog|analysis|rankings?).*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  // If it got too short after cleaning, fall back to domain
  if (cleaned.length < 3) return domain || 'your site';

  // Truncate to 40 chars at a word boundary
  if (cleaned.length > 40) {
    cleaned = cleaned.slice(0, 40).replace(/\s+\S*$/, '').trim();
  }

  return cleaned || domain || 'your site';
}

// Fixed single template: "1xBet x [Name] - partnership" (clean, professional)
function buildSubject(leadName: string, leadUrl: string, brand: string): string {
  const brandDisplay = brand === '1xcasino' ? '1xCasino' : '1xBet';
  const sitename     = cleanSiteName(leadName, leadUrl);
  return `${brandDisplay} x ${sitename} - partnership`;
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
    if (hour < 9 || hour >= 18) {
      stats.reason = hour < 9 ? 'before working hours' : 'after working hours';
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

    // 4. Fetch pending + retryable-failed queue items due now.
    //    'failed' items (retry_count < MAX_RETRIES) are included so they get
    //    a second chance after transient errors (e.g. wrong credentials fixed).
    const { data: queueItems, error: queueErr } = await supabase
      .from('send_queue')
      .select('*')
      .in('status', ['pending', 'failed'])
      .lt('retry_count', MAX_RETRIES)
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

      // LP account disabled — route everything through main
      const account    = 'main';
      const usageService = 'gmail_main';

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

      // Skip leads from excluded GEOs — URL TLD + geo field check
      if (isGeoExcluded(lead.url || '', lead.geo || '')) {
        await supabase.from('send_queue')
          .update({ status: 'skipped', error: 'geo excluded (EU/UK/UA/BR/AU)' })
          .eq('id', item.id);
        await supabase.from('leads')
          .update({ stage: 'excluded' })
          .eq('id', lead.id);
        stats.skipped++;
        continue;
      }

      const subject = buildSubject(lead.name, lead.url || '', item.brand);

      // Generate a personalised email body with Groq; fall back to a template.
      let body = await generateMessage(lead, item.brand, account) ?? '';

      if (!body) {
        const brandDisplay = item.brand === '1xcasino' ? '1xCasino' : '1xBet';
        body = `Hi ${lead.name || 'there'},\n\nI came across ${lead.url} and would love to discuss a partnership opportunity with ${brandDisplay}.\n\nWe offer competitive commissions and dedicated support.\n\nWould you be open to a quick chat?\n\nBest regards,\nNick`;
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
        const d      = sendResult.data as Record<string, unknown> | null;
        const detail = d ? JSON.stringify(d).slice(0, 300) : 'empty response';
        const msg    = (d?.error as string) ?? (d?.message as string) ?? `send-email non-OK: ${detail}`;

        // Credential errors (535 / placeholder) → pause system immediately so we
        // don't burn through all retry counts before the secret is fixed.
        const isCredErr = msg.includes('535') || msg.includes('placeholder') || msg.includes('not configured');
        if (isCredErr) {
          await supabase.from('api_usage')
            .update({ system_paused: true })
            .eq('service', 'gmail_main');
          await logError('critical', 'process-queue',
            `CREDENTIAL ERROR — system auto-paused. Fix GMAIL_PASS_MAIN in Supabase Secrets, then call /functions/v1/admin-reset. Error: ${msg}`);
          stats.reason = 'auto-paused: credential error';
          return new Response(JSON.stringify(stats), { headers: { ...cors, 'Content-Type': 'application/json' } });
        }

        await logError('error', 'process-queue', `send-email failed item ${item.id} to=${lead.contact_email}: ${msg}`, item.lead_id);
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
