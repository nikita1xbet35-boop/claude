import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL  = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const FUNCTIONS_URL = SUPABASE_URL + '/functions/v1';

const ACCOUNT_DAILY_LIMIT = 300;
const BATCH_SIZE          = 10;
const MAX_RETRIES         = 3;
const WEEKEND_DAILY_CAP   = 200;
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
  UG: 'Uganda', ZM: 'Zambia', CD: 'DR Congo', ET: 'Ethiopia', MZ: 'Mozambique', ML: 'Mali',
  // fallbacks for other stored geo values
  'Africa FR': 'West Africa', 'CIS': 'the region', 'Global': 'the region',
};

function geoName(geoCode: string): string {
  if (!geoCode) return 'the region';
  return GEO_NAMES[geoCode.trim().toUpperCase()] || GEO_NAMES[geoCode.trim()] || geoCode;
}

/** Build the outreach email body from a fixed template. No Groq needed.
 *  Soft intro — references the site name and (when known) its GEO. */
function buildEmailBody(lead: Record<string, unknown>, _brand: string): string {
  const name      = cleanSiteName(lead.name as string, lead.url as string || '');
  const geoRaw    = geoName((lead.geo as string) || '');
  const hasGeo    = !!geoRaw && geoRaw !== 'the region' && geoRaw !== 'your market';
  const geoClause = hasGeo ? ` in ${geoRaw}` : '';
  const source    = ((lead.source as string) || 'seo').toLowerCase();

  // ── YouTube channel owner (source=youtube) — prepared, source not yet launched
  if (source === 'youtube') {
    return `Hi, I came across your channel ${name}${geoClause} — you've built a real, engaged audience, `
      + `and that's worth more than most programs pay creators for it. I'm Nick from 1xPartners. `
      + `You're already sending this audience somewhere; I can make it pay you more: clean RevShare on 1xBet, `
      + `no admin fee, no hidden cuts, terms built around your actual numbers, plus creator-friendly promo codes and assets. `
      + `You deal with me directly, not a support desk. Want me to send a short proposal? Or ping me on Telegram: @aff_manager_xbet`;
  }

  // ── App developer (source=appstore) — Africa-focus week template
  if (source === 'appstore') {
    const geoWordApp = hasGeo ? geoRaw : 'your market';
    return `Hi, I came by your app ${name} — strong work in ${geoWordApp}. `
      + `I'm Nick from 1xPartners. 1xBet is the #1 betting brand across Africa, fully licensed in your market, `
      + `and right now I've got an exclusive RevShare deal (up to 40%) for partners here. `
      + `Clean share, no admin fee, weekly payouts, deep links and API integration, and you deal with me directly. `
      + `Want me to send the offer?`;
  }

  // ── SEO site owner (default) — Africa-focus week template
  const geoWord = hasGeo ? geoRaw : 'your market';
  return `Hi, I came by ${name} — strong work in ${geoWord}. `
    + `I'm Nick from 1xPartners. 1xBet is the #1 betting brand across Africa, fully licensed in your market, `
    + `and right now I've got an exclusive RevShare deal (up to 40%) for partners here. `
    + `Clean share, no admin fee, weekly payouts, and you deal with me directly. Want me to send the offer?`;
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

/** Derive a clean brand-ish name from the domain.
 *  "gooners-guide.com" → "Gooners Guide", "betpro9.net" → "Betpro9". */
function nameFromDomain(leadUrl: string): string {
  try {
    const raw = leadUrl.startsWith('http') ? leadUrl : 'https://' + leadUrl;
    const h   = new URL(raw).hostname.replace(/^www\./, '');
    return h.split('.')[0]
      .replace(/[-_]/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase())
      .trim();
  } catch (_) { return ''; }
}

/** A title is only usable as a name if it reads like a short brand,
 *  not a full SEO sentence. Reject commas, leftover prepositions,
 *  long phrases and obvious listicle wording. */
function looksLikeCleanBrand(s: string): boolean {
  if (!s || s.length < 3) return false;
  if (s.includes(',')) return false;                       // "casinos in , grand"
  if (/\b(in|for|the|best|top|new|newest|latest|sites?|review|guide|list|bonus|grand|opening)\b/i.test(s)) return false;
  if (s.trim().split(/\s+/).length > 3) return false;      // too wordy to be a brand
  return true;
}

/**
 * Pick the site name to greet. Domain is the reliable identifier, so we
 * prefer it; the SEO page title is only used when it's a clean short brand.
 */
function cleanSiteName(leadName: string, leadUrl: string): string {
  const domain = nameFromDomain(leadUrl);

  // Try the page title, but only accept it if it reads like a brand.
  if (leadName) {
    const ascii = toAsciiSafe(decodeEntities(leadName));
    const cleaned = ascii
      .replace(/\([^)]*\d{4}[^)]*\)/g, '')
      .replace(/\b(19|20)\d{2}\b/g, '')
      .replace(/[-|:,–].*$/, '')                            // drop everything after first separator
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (looksLikeCleanBrand(cleaned)) return cleaned;
  }

  return domain || 'your site';
}

// ── Brand pipeline copy ─────────────────────────────────────────────────────
// A separate letter, and the reason the brand queue shipped paused rather than
// borrowing this file's default. The main pipeline opens with "strong work in
// Nigeria" — a compliment about a market. That is the wrong thing to say to
// someone intercepting "mostbet apk": what they own is a POSITION, and the
// letter has to name it or it reads as a mailshot.
//
// Two variables, both taken from the find itself: the domain, and the query it
// was ranking for when we found it. Everything else is fixed copy.
//
// Uzbekistan gets Uzbek — it is the confirmed market for this traffic and the
// one where the partner is least likely to be working in English. Everyone
// else gets the English original.

/** The query this lead was found on. brand-search always records it, but a
 *  lead promoted before that, or by another path, may not have one — and
 *  "you're ranking for undefined" is worse than any fallback. The brand name
 *  is the honest substitute: it is what the query was about. */
function brandKeywordOf(lead: Record<string, unknown>): string {
  const kw = String(lead.found_keyword || '').trim();
  if (kw) return kw;
  return String(lead.brand_found || '').trim();
}

/** The site as the recipient knows it — the bare domain. "I came by
 *  kenyanbets.co.ke" is a sentence a human writes; "I came by Kenyanbets"
 *  is one a mail merge writes. */
function brandSiteOf(lead: Record<string, unknown>): string {
  const d = String(lead.domain_normalized || '').trim();
  if (d) return d;
  try {
    const raw = String(lead.url || '');
    return new URL(raw.startsWith('http') ? raw : 'https://' + raw).hostname.replace(/^www\./, '');
  } catch { return String(lead.name || 'your site'); }
}

function buildBrandEmail(lead: Record<string, unknown>): { subject: string; body: string } | null {
  const site    = brandSiteOf(lead);
  const keyword = brandKeywordOf(lead);
  // Without a query there is no letter worth sending here — the whole opening
  // is built on naming it. Better to skip the lead than to mangle the copy.
  if (!site || !keyword) return null;

  const uz = String(lead.geo || '').trim().toUpperCase() === 'UZ';

  // Subject picked by lead id, not at random: a retry must not arrive under a
  // different subject line than the attempt before it.
  //
  // Subjects use an ASCII hyphen where the brief writes an em dash: headers go
  // through toAsciiSafe, which deletes the dash outright and leaves
  // "site.com a partnership worth 5 minutes". The body keeps the em dashes —
  // it is sent as UTF-8 base64 and arrives exactly as written.
  const idx = Math.abs(Number(lead.id) || 0) % 3;

  if (uz) {
    const subjects = [
      `${site} haqida qisqa savol`,
      `${keyword} bo'yicha o'rningizni ko'rdim`,
      `${site} - 5 daqiqaga arziydigan hamkorlik`,
    ];
    const body =
      `Salom, ${site} saytingizga kirdim — ${keyword} bo'yicha yaxshi o'rinda turibsiz, zo'r ish. `
      + `Bu o'rinni ushlab turish oson emas.\n\n`
      + `Men Nikman, 1xBet'da hamkorlik yo'nalishida ishlayman. Biz shunday brend-trafik yuboradigan `
      + `odamlar bilan ishlaymiz va shartlar odatda ikkala tomon uchun ham qulay chiqadi — toza RevShare, `
      + `admin to'lovisiz, haftalik to'lovlar.\n\n`
      + `Hozir sizga hech narsa sotmoqchi emasman — shunchaki raqamlarni eshitishga qiziqasizmi, `
      + `bilmoqchiman. Ikki daqiqa vaqt oladi.\n\n`
      + `Telegram: @aff_manager_xbet`;
    return { subject: toAsciiSafe(subjects[idx]), body };
  }

  const subjects = [
    `Quick one about ${site}`,
    `Saw your ranking for ${keyword}`,
    `${site} - a partnership worth 5 minutes`,
  ];
  const body =
    `Hey, I came by ${site} — you're ranking for ${keyword}, solid work. That's not easy to hold.\n\n`
    + `I'm Nick, I work with 1xBet on the partnerships side. We work with people who send us `
    + `brand-intent traffic like this, and the terms tend to work out well for both sides — `
    + `clean RevShare, no admin fee, weekly payouts.\n\n`
    + `Not trying to sell you anything right now — just curious if you're open to hearing the numbers. `
    + `Takes two minutes.\n\n`
    + `Telegram: @aff_manager_xbet`;
  return { subject: toAsciiSafe(subjects[idx]), body };
}

function buildSubject(leadName: string, leadUrl: string, _brand: string, leadGeo?: string): string {
  const geo  = geoName(leadGeo || '');
  const hasGeo = !!geo && geo !== 'the region' && geo !== 'your market';
  const geoWord = hasGeo ? geo : 'your market';
  const SUBJECTS = [
    `Exclusive 1xBet deal for ${geoWord}`,
    `Your ${geoWord} traffic — up to 40%`,
    `#1 in Africa, licensed in ${geoWord}`,
  ];
  return SUBJECTS[Math.floor(Math.random() * SUBJECTS.length)];
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

  const stats = { processed: 0, sent: 0, failed: 0, skipped: 0, reason: '',
                  blocked_pipelines: [] as string[] };

  try {
    const now = new Date();

    // Pause logic removed entirely — system is self-healing.
    // Individual failures mark items as failed/skipped; system keeps running.

    // 2. Round the clock. The 08:00-20:00 GMT+3 window used to live here.
    //
    // It was never protecting much: the recipients are in Nigeria (GMT+1),
    // Bangladesh (+6), Uzbekistan (+5) and a dozen other zones, so a Moscow
    // business-hours window lands somewhere arbitrary for almost all of them.
    // Meanwhile it squeezed the whole day's volume into twelve hours, which is
    // the opposite of what reputation wants — a steady trickle across 24 hours
    // looks less like a campaign than the same count fired in half a day.
    //
    // What actually rations sending stays exactly where it was: the per-account
    // daily quota, the per-pipeline daily ceiling, and the 30-90s random gap
    // between messages. Those are the real limits; this was a calendar.
    const { dateStr } = toGMT3(now);

    // 3. Sends run 7/7 — no weekend throttle. The per-account daily quota
    //    (ACCOUNT_DAILY_LIMIT) still applies every day.
    const gmt3DayStart = new Date(`${dateStr}T00:00:00+03:00`);
    const gmt3DayEnd   = new Date(`${dateStr}T23:59:59+03:00`);

    // 4. Per-pipeline ceilings. The queue is shared, the budgets are not: the
    //    DataForSEO funnel has its own daily limit and its own pause switch, and
    //    enforcing them HERE (at the moment of sending) is what actually caps
    //    spend — the queue filler's own arithmetic can be outrun by a manual
    //    enqueue or a second filler run.
    //
    //    Blocked pipelines are excluded from the QUERY rather than skipped in the
    //    loop. The queue is read oldest-first with a hard BATCH_SIZE, so a paused
    //    pipeline whose items happen to be the oldest would fill the entire
    //    window every run and starve the other pipeline indefinitely — pausing
    //    one funnel would silently stop the other.
    const { data: limitRows } = await supabase.from('pipeline_limits')
      .select('pipeline, daily_limit, paused');
    const limits = new Map<string, { limit: number; paused: boolean }>();
    for (const r of limitRows || []) {
      limits.set(String(r.pipeline), {
        limit: Number(r.daily_limit) || 0,
        paused: !!r.paused,
      });
    }
    const pipelineSentToday: Record<string, number> = {};
    const blocked: string[] = [];
    for (const [p, cfg] of limits) {
      const { count } = await supabase.from('email_log')
        .select('id', { count: 'exact', head: true })
        .eq('pipeline', p)
        .gte('sent_at', gmt3DayStart.toISOString())
        .lte('sent_at', gmt3DayEnd.toISOString());
      pipelineSentToday[p] = count ?? 0;
      if (cfg.paused || (cfg.limit > 0 && (count ?? 0) >= cfg.limit)) blocked.push(p);
    }
    stats.blocked_pipelines = blocked;

    // 4b. Fetch pending + retryable-failed queue items due now.
    //     'failed' items (retry_count < MAX_RETRIES) are included so they get
    //     a second chance after transient errors (e.g. wrong credentials fixed).
    let queueQuery = supabase
      .from('send_queue')
      .select('*')
      .in('status', ['pending', 'failed'])
      .lt('retry_count', MAX_RETRIES)
      .lte('scheduled_at', now.toISOString());
    if (blocked.length) {
      // Legacy rows can carry a NULL pipeline; those are 'search' by default and
      // must survive the filter, which a bare not-in would drop.
      queueQuery = queueQuery.or(
        `pipeline.is.null,pipeline.not.in.(${blocked.map(p => `"${p}"`).join(',')})`,
      );
    }
    const { data: queueItems, error: queueErr } = await queueQuery
      .order('scheduled_at', { ascending: true })
      .limit(BATCH_SIZE);

    if (queueErr) throw new Error(`send_queue query failed: ${queueErr.message}`);
    if (!queueItems || queueItems.length === 0) {
      stats.reason = blocked.length
        ? `no pending items (blocked: ${blocked.join(', ')})`
        : 'no pending items';
      return new Response(JSON.stringify(stats), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    const accountQuotaCache: Record<string, number> = {};

    // 5. Process each item
    for (const item of queueItems) {
      stats.processed++;

      const pipeline = (item.pipeline as string) || 'search';
      const pl = limits.get(pipeline);
      // Re-check per item: the in-run tally advances as this loop sends, so a
      // pipeline can reach its ceiling partway through a batch.
      if (pl && pl.limit > 0 && (pipelineSentToday[pipeline] ?? 0) >= pl.limit) {
        stats.skipped++;
        continue;   // ceiling hit; the row waits for tomorrow
      }

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
      // Placeholder/junk domains that never accept mail → guaranteed bounces.
      const JUNK_DOMAINS_PQ = new Set([
        'email.com','mydomain.com','yourdomain.com','domain.com','company.com',
        'yoursite.com','mysite.com','website.com','example.com','test.com',
      ]);
      // Betting operators — competitors, not affiliates. Never contact.
      const COMPETITOR_DOMAINS_PQ = new Set([
        'linebet.com','paripesa.com','1xbet.com','melbet.com','22bet.com','mostbet.com',
        'betwinner.com','1win.com','parimatch.com','sportybet.com','bet9ja.com','stake.com',
      ]);
      const emailLower = (lead.contact_email || '').toLowerCase();
      const atIdx = emailLower.indexOf('@');
      const emailLocal = atIdx > -1 ? emailLower.slice(0, atIdx) : '';
      const emailDomain = atIdx > -1 ? emailLower.slice(atIdx + 1) : '';
      // Malformed: domain used as local part (e.g. site.com.ng@gmail.com)
      const isMalformedPattern = /\.(com|net|org|co|info|me|io|news|blog|site|web)\.[a-z]{2,3}$/.test(emailLocal);
      // RFC 5321: local part must not start/end with dot, have consecutive dots, exceed 64 chars,
      // or contain chars outside the allowed set. Gmail returns 553-5.1.3 on all of these.
      const isRfc5321Invalid = !emailLocal || !emailDomain
        || emailLocal.length > 64
        || emailLocal.startsWith('.') || emailLocal.endsWith('.')
        || /\.{2,}/.test(emailLocal)
        || !/^[\w!#$%&'*+\-/=?^`{|}~.]+$/i.test(emailLocal)
        || !emailDomain.includes('.');
      const isMalformed   = isMalformedPattern || isRfc5321Invalid;
      const isPlaceholder = EMAIL_PLACEHOLDERS_PQ.some(p => emailLower.includes(p))
                         || PLACEHOLDER_LOCAL_PQ.has(emailLocal)
                         || JUNK_DOMAINS_PQ.has(emailDomain)
                         || isMalformed;
      const isCorpDomain  = CORP_EMAIL_DOMAINS_PQ.has(emailDomain) || COMPETITOR_DOMAINS_PQ.has(emailDomain);

      if (!lead.contact_email || isPlaceholder || isCorpDomain) {
        const reason = isCorpDomain ? `corporate/competitor domain (not an affiliate): ${lead.contact_email}`
          : isPlaceholder ? `placeholder/malformed email: ${lead.contact_email}` : 'no contact email';
        await supabase.from('send_queue')
          .update({ status: 'skipped', error: reason })
          .eq('id', item.id);
        if (isCorpDomain) {
          await supabase.from('leads').update({ stage: 'excluded' }).eq('id', lead.id);
        } else if (isPlaceholder) {
          // Null out bad email so generate-queue stops re-queuing this lead
          await supabase.from('leads')
            .update({ contact_email: null, contact_email_type: 'not_found' })
            .eq('id', lead.id);
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

      let subject = buildSubject(lead.name, lead.url || '', item.brand, lead.geo as string);
      let body    = buildEmailBody(lead, item.brand);
      let inReplyTo: string | undefined;

      // Brand-traffic leads get their own letter. Checked on the queue row
      // first because that is what routing and the daily ceiling key on; the
      // lead is the fallback for rows written before pipeline was stamped.
      const pipelineOf = String(item.pipeline || lead.pipeline || 'search');
      if (pipelineOf === 'brand') {
        const t = buildBrandEmail(lead);
        if (!t) {
          await markFailed(item, 'brand lead has no keyword to write about', true);
          stats.skipped++;
          continue;
        }
        subject = t.subject;
        body    = t.body;
      }

      // ── Follow-up steps (P0.3) ────────────────────────────────────────────
      // A queue row carrying step_no >= 2 is a sequence touch, not a cold email:
      // it must use that step's own copy and thread onto the original message,
      // otherwise the recipient gets the opening pitch a second time as a fresh
      // conversation.
      if (item.step_no && item.step_no >= 2 && item.sequence_id) {
        const { data: step } = await supabase.from('sequence_steps')
          .select('subject_variant, body_template, template_key')
          .eq('sequence_id', item.sequence_id).eq('step_no', item.step_no).maybeSingle();

        if (step?.body_template) {
          const geoName = GEO_NAMES[String(lead.geo || '').toUpperCase()] || String(lead.geo || 'your market');
          const site    = (lead.name as string) || nameFromDomain(String(lead.url || '')) || 'your site';
          const contact = lead.contact_name ? ' ' + String(lead.contact_name).split(' ')[0] : '';
          body = String(step.body_template)
            .replace(/\{contact\}/g, contact)
            .replace(/\{geo\}/g, geoName)
            .replace(/\{site\}/g, site);
          if (step.subject_variant) subject = toAsciiSafe(String(step.subject_variant));
        }

        // Thread onto the first message we sent this lead.
        const { data: firstSend } = await supabase.from('email_log')
          .select('gmail_message_id')
          .eq('lead_id', item.lead_id).not('gmail_message_id', 'is', null)
          .order('sent_at', { ascending: true }).limit(1).maybeSingle();
        if (firstSend?.gmail_message_id) inReplyTo = firstSend.gmail_message_id as string;
      }

      // Send
      let sendResult: { ok: boolean; data: unknown };
      try {
        sendResult = await callFunction('send-email', {
          to: lead.contact_email, subject, body, account,
          ...(inReplyTo ? { in_reply_to: inReplyTo } : {}),
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
          source:        (lead.source as string) || 'seo',
          // Carried from the queue row so each funnel's daily ceiling and reply
          // stats are computed over its own sends only.
          pipeline:      (item.pipeline as string) || 'search',
          ...(gmailMessageId ? { gmail_message_id: gmailMessageId } : {}),
          // P1.4 — which variant/step produced this send, so reply rate can later
          // be reported per variant x geo x step.
          ...(item.variant_key ? { variant_key: item.variant_key } : {}),
          ...(item.step_no ? { sequence_step: item.step_no } : {}),
        }]);

        // Keep the in-run tally honest: BATCH_SIZE items can be processed in one
        // pass, and without this the ceiling would only be re-read next run.
        pipelineSentToday[pipeline] = (pipelineSentToday[pipeline] ?? 0) + 1;

        const { data: cur } = await supabase.from('api_usage')
          .select('used').eq('service', usageService).single();
        await supabase.from('api_usage')
          .update({ used: ((cur?.used ?? 0) as number) + 1, updated_at: sentAt })
          .eq('service', usageService);

        await supabase.from('leads').update({ stage: 'waiting' }).eq('id', item.lead_id);

        // §4.4 ТЗ (Block 1/2): record the touch now that the send actually
        // happened. fn_capture_contact (called before this lead reached
        // send_queue) already reserved ownership; this is what makes
        // total_touches/max_touches and the rotation gap check (min_gap_after,
        // read from contact_touches) mean anything in practice. Best-effort —
        // a failure here must not turn a successful send into a failed run.
        if (lead.brand_id) {
          try {
            let domain = '';
            try { domain = new URL(String(lead.url || '')).hostname.toLowerCase().replace(/^www\./, ''); } catch {}
            await supabase.rpc('fn_record_touch_by_contact', {
              p_email: lead.contact_email, p_domain: domain, p_brand_id: lead.brand_id,
              p_pipeline: (item.pipeline as string) || 'search', p_channel: 'email', p_outcome: 'sent',
            });
          } catch (_) { /* best-effort — see comment above */ }
        }

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
          // Auto-blacklist bounced domain (non-consumer providers only)
          if (isPermanentSmtp && lead.contact_email) {
            try {
              const bounceEmail = (lead.contact_email as string).toLowerCase();
              const bounceDomain = bounceEmail.split('@')[1];
              if (bounceDomain && !['gmail.com','yahoo.com','hotmail.com','outlook.com'].includes(bounceDomain)) {
                await supabase.from('blacklist').upsert(
                  [{ value: bounceDomain, type: 'email_domain', reason: 'bounced', auto_added: true, added_at: new Date().toISOString() }],
                  { onConflict: 'value', ignoreDuplicates: true },
                );
              }
            } catch (_) {}
          }
        } else {
          stats.failed++;
        }
      }

      if (stats.processed < queueItems.length) await sleep(SEND_DELAY_MS);
    }

    if (stats.reason === '') delete (stats as any).reason;

    const summaryParts = [`sent=${stats.sent}`, `failed=${stats.failed}`, `skipped=${stats.skipped}`];
    if (stats.reason) summaryParts.push(`reason=${stats.reason}`);
    await logError('info', 'process-queue', summaryParts.join(' '));

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
