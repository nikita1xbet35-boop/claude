import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL  = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const FUNCTIONS_URL = SUPABASE_URL + '/functions/v1';

const ACCOUNT_DAILY_LIMIT = 200;
const BATCH_SIZE          = 10;
const MAX_RETRIES         = 3;
const WEEKEND_DAILY_CAP   = 100;
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
      'apikey': SUPABASE_KEY,
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

// GEO code → country name for email templates
const GEO_NAMES: Record<string, string> = {
  ID: 'Indonesia', BD: 'Bangladesh', IN: 'India', CI: "Côte d'Ivoire",
  EG: 'Egypt', MY: 'Malaysia', UZ: 'Uzbekistan', NP: 'Nepal',
  PK: 'Pakistan', TR: 'Turkey', AR: 'Argentina', CL: 'Chile',
  PH: 'Philippines', BF: 'Burkina Faso', SN: 'Senegal', CM: 'Cameroun',
  MA: 'Morocco', VN: 'Vietnam', MM: 'Myanmar', ZA: 'South Africa',
  NG: 'Nigeria', KE: 'Kenya', GH: 'Ghana', TZ: 'Tanzania', KG: 'Kyrgyzstan',
  // fallbacks for other stored geo values
  'Africa FR': 'West Africa', 'CIS': 'the region', 'Global': 'the region',
};

function geoName(geoCode: string): string {
  if (!geoCode) return 'the region';
  return GEO_NAMES[geoCode.trim().toUpperCase()] || GEO_NAMES[geoCode.trim()] || geoCode;
}

/** Build the outreach email body from a fixed template. No Groq needed.
 *  Soft intro — references the site name and its GEO. */
function buildEmailBody(lead: Record<string, unknown>, _brand: string): string {
  const siteName = cleanSiteName(lead.name as string, lead.url as string || '');
  const geo      = geoName((lead.geo as string) || '');

  return `Hi, I had a look at ${siteName} and really like what you're doing in ${geo}. `
    + `I'm Nick from 1xPartners. 1xBet is one of the most recognized, licensed brands across your markets, `
    + `and it earns partners solid recurring income. Clean RevShare, no admin fee, individual terms, `
    + `and you'd run directly with me. I put together a short proposal — want me to send it over?`;
}

// Decode HTML entities so site names never show raw "&amp;" / "&#x27;" etc.
// (DuckDuckGo/page titles arrive HTML-encoded — this is the "binary code" artifact.)
function decodeEntities(s: string): string {
  return s
    .replace(/&#x27;/gi, "'").replace(/&#39;/g, "'").replace(/&apos;/gi, "'")
    .replace(/&quot;/gi, '"').replace(/&#34;/g, '"')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ' '; } })
    .replace(/&#(\d+);/g,           (_, n) => { try { return String.fromCodePoint(parseInt(n, 10)); } catch { return ' '; } })
    .replace(/&amp;/gi, '&'); // must be last so "&amp;lt;" → "&lt;" → "<" never happens prematurely
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

  const ascii = toAsciiSafe(decodeEntities(leadName));
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

// Subject exactly as per template: "1xBet × [Сайт] — partnership"
function buildSubject(leadName: string, leadUrl: string, brand: string): string {
  const brandDisplay = brand === '1xcasino' ? '1xCasino' : '1xBet';
  const sitename     = cleanSiteName(leadName, leadUrl);
  return `${brandDisplay} × ${sitename} — partnership`;
}

async function markFailed(item: Record<string, unknown>, errMsg: string, forceSkip = false): Promise<boolean> {
  // 5xx SMTP errors (550/551/552/553) are permanent rejections — retrying wastes
  // 6 minutes per item and blocks valid emails behind it in the queue.
  const newRetryCount = forceSkip ? MAX_RETRIES : ((item.retry_count as number) ?? 0) + 1;
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

    // Pause logic removed entirely — system is self-healing.
    // Individual failures mark items as failed/skipped; system keeps running.

    // 2. Working hours: 08:00–20:00 GMT+3
    const { hour, dayOfWeek, dateStr } = toGMT3(now);
    if (hour < 8 || hour >= 20) {
      stats.reason = hour < 8 ? 'before working hours' : 'after working hours';
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

      // Unified 1xPartners campaign — every lead (regardless of which brand-search
      // found it) is a valid affiliate target. All sends go through the main account
      // with the brand-neutral template, so no brand is skipped anymore.

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

      const EMAIL_PLACEHOLDERS_PQ = [
        'youremail','your-email','your_email','yourname','your-name',
        'email@email','test@test','user@user','demo@','sample@','placeholder','changeme',
        'admin@example','info@example','user@example','test@example',
        'email@domain','mail@domain','name@domain','user@domain','email@site','mail@site',
      ];
      const PLACEHOLDER_LOCAL_PQ = new Set(['email','test','demo','sample','example','noreply','donotreply','postmaster','mailer']);
      // Big corporate / portal email domains — NOT affiliates (e.g. support@maps.yandex.ru)
      // NOTE: gmail/googlemail/outlook/hotmail are CONSUMER providers, not corporate —
      // small affiliate site owners (our core targets) use them as their main contact.
      const CORP_EMAIL_DOMAINS_PQ = new Set([
        'yandex.ru','yandex.com','maps.yandex.ru','ya.ru','mail.ru','vk.com','ok.ru','rambler.ru',
        'avito.ru','gosuslugi.ru','sberbank.ru','tinkoff.ru','wildberries.ru','ozon.ru','2gis.ru',
        'rbc.ru','rt.com','ria.ru','tass.ru','google.com','apple.com',
        'microsoft.com','samsung.com','huawei.com','xiaomi.com',
        'baidu.com','aliexpress.com','wordpress.com','wix.com','shopify.com','cloudflare.com',
      ]);
      const emailLower = (lead.contact_email || '').toLowerCase();
      const emailLocal = emailLower.split('@')[0];
      const emailDomain = emailLower.split('@')[1] || '';
      const isPlaceholder = EMAIL_PLACEHOLDERS_PQ.some(p => emailLower.includes(p))
                         || PLACEHOLDER_LOCAL_PQ.has(emailLocal);
      const isCorpDomain = CORP_EMAIL_DOMAINS_PQ.has(emailDomain);

      if (!lead.contact_email || isPlaceholder || isCorpDomain) {
        const reason = isCorpDomain ? `corporate domain (not an affiliate): ${lead.contact_email}`
          : isPlaceholder ? `placeholder email: ${lead.contact_email}` : 'no contact email';
        await supabase.from('send_queue')
          .update({ status: 'skipped', error: reason })
          .eq('id', item.id);
        if (isCorpDomain) {
          await supabase.from('leads').update({ stage: 'excluded' }).eq('id', lead.id);
        }
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

      // ── HARD DEDUP — last-mile guard ────────────────────────────────────
      // Check ALL-TIME email_log: if we ever sent to this address, skip it.
      // This catches anything that slipped through generate-queue's filter.
      const { count: prevSentCount } = await supabase
        .from('email_log')
        .select('id', { count: 'exact', head: true })
        .eq('email', lead.contact_email);
      if ((prevSentCount ?? 0) > 0) {
        await supabase.from('send_queue')
          .update({ status: 'skipped', error: 'duplicate: already in email_log' })
          .eq('id', item.id);
        await supabase.from('leads')
          .update({ stage: 'waiting' })
          .eq('id', lead.id);
        stats.skipped++;
        continue;
      }

      const subject = buildSubject(lead.name, lead.url || '', item.brand);
      const body    = buildEmailBody(lead, item.brand);

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

        // No auto-pause anymore — that just made the system get stuck.
        // Just mark this item as failed; if credentials are broken,
        // a few items get skipped but the system keeps trying.
        await logError('error', 'process-queue', `send-email failed item ${item.id} to=${lead.contact_email}: ${msg}`, item.lead_id);
        // 55x SMTP = permanent rejection (invalid address, mailbox unavailable, etc.)
        const isPermanentSmtp = /got 5[5-9]\d/.test(msg);
        const permanent = await markFailed(item, msg, isPermanentSmtp);
        if (permanent) {
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
