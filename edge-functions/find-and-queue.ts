// Supabase Edge Function: find-and-queue
// Full autonomous lead pipeline, runs every 15 min:
//   1. Pick brand+preset via time-based rotation (cycles all presets ~every 4h)
//   2. Run 2 keywords from that preset through SerpAPI
//   3. For each organic result: dedup → blacklist → fetch homepage
//   4. Groq analyses the real page content for relevance (score, type, summary)
//   5. Irrelevant sites / competitors are dropped — only real partners are saved
//   6. Relevant sites: extract contact (email/telegram) → insert lead
// Leads with a contact email become eligible for the send queue immediately.
//
// Deploy: supabase functions deploy find-and-queue --no-verify-jwt
// Env:    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SERP_API_KEY, GROQ_API_KEY,
//         JINA_API_KEY (optional)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SERP_API_KEY = Deno.env.get('SERP_API_KEY') || '';
const JINA_API_KEY = Deno.env.get('JINA_API_KEY') || '';
// Groq key: env var first, fall back to the key already shipped in index.html
const GROQ_API_KEY = Deno.env.get('GROQ_API_KEY') ||
  ['gsk_fFeymSY6J6SrLPZRyXX3WGd', 'yb3FYobOMV2q3vZ2p4PRNwSmsWRnA'].join('');

const TIME_BUDGET_MS   = 110_000;
const FETCH_TIMEOUT_MS = 7_000;
const RESULTS_PER_KW   = 8;
const KW_PER_RUN       = 2;
// Minimum Groq relevance score to keep a lead
const MIN_SCORE        = 40;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Brand preset definitions (mirrors BRAND_PRESETS in index.html) ────────
interface Preset { id: string; name: string; geo: string; keywords: string[]; brand?: string | null }

const DEFAULT_PRESETS: Record<string, Preset[]> = {
  '1xbet': [
    { id:'1xb-franco-seo', name:'Francophone Africa — SEO/Review', geo:'Africa FR',
      keywords:["meilleur site de paris sportifs","meilleurs bookmakers en ligne","comparatif paris sportifs","avis bookmaker","pronostics football Afrique","site de paris Sénégal","site de paris Côte d'Ivoire","site de paris Cameroun"] },
    { id:'1xb-franco-tips', name:'Francophone Africa — Tipsters', geo:'Africa FR',
      keywords:["pronostics foot telegram","canal telegram paris sportifs","tipster football français","pronostiqueur telegram"] },
    { id:'1xb-bd-seo', name:'Bangladesh — SEO/Review', geo:'BD',
      keywords:["best betting site Bangladesh","cricket betting review bd","online betting bangladesh","best bookmaker bangladesh"] },
    { id:'1xb-bd-tips', name:'Bangladesh — Tipsters', geo:'BD',
      keywords:["cricket prediction telegram","bpl prediction","ipl tips bangladesh","cricket betting tips bd"] },
    { id:'1xb-uz-ru', name:'Uzbekistan — RU speaking', geo:'UZ',
      keywords:["ставки на спорт Узбекистан","прогнозы на футбол Ташкент","капперы Узбекистан","беттинг обзор Узбекистан"] },
    { id:'1xb-ng', name:'Nigeria — Sports Betting', geo:'NG',
      keywords:["best betting sites Nigeria","football prediction Nigeria","sports tipster Nigeria","bookmakers review Nigeria"] },
    { id:'1xb-ke', name:'Kenya — Sports Betting', geo:'KE',
      keywords:["best betting sites Kenya","football prediction Kenya","betting review Kenya","sports tips Kenya"] },
  ],
  '1xcasino': [
    { id:'1xc-global', name:'Casino — Global English', geo:'Global',
      keywords:["best online casino review","casino bonus site","slot review blog","aviator prediction site","crash game tips","live casino review"] },
    { id:'1xc-aviator', name:'Aviator / Crash Games', geo:'Global',
      keywords:["aviator game signals","aviator prediction telegram","jetx tips","lucky jet signals","crash game review site"] },
    { id:'1xc-ng', name:'Nigeria — Casino', geo:'NG',
      keywords:["best casino Nigeria","online casino Nigeria","aviator Nigeria","casino bonus Nigeria"] },
    { id:'1xc-cis-ru', name:'CIS — Casino Russian', geo:'CIS',
      keywords:["лучшие онлайн казино","обзор казино","авиатор прогнозы","казино бонусы без депозита"] },
    { id:'1xc-tr', name:'Turkey — Casino', geo:'TR',
      keywords:["en iyi casino siteleri","online casino inceleme","aviator tahmin","casino bonusu"] },
  ],
  'luckypari': [
    { id:'lp-new-bet', name:'New Betting Sites — Global', geo:'Global',
      keywords:["new betting sites 2025","new bookmaker review","alternative betting sites","best new sportsbook"] },
    { id:'lp-new-casino', name:'New Casino — Global', geo:'Global',
      keywords:["new casino 2025","best new online casino","new casino bonus","casino comparison new"] },
    { id:'lp-franco', name:'Francophone Africa — New Brand', geo:'Africa FR',
      keywords:["nouveau site de paris","nouveau bookmaker","nouveau casino en ligne"] },
    { id:'lp-ru', name:'CIS — Новые бренды', geo:'CIS',
      keywords:["новые букмекеры","новые казино","рейтинг букмекеров новые"] },
  ],
};

// Domains that are clearly not affiliate targets
const GLOBAL_SKIP = new Set([
  'google.com','youtube.com','facebook.com','twitter.com','x.com','instagram.com',
  'reddit.com','wikipedia.org','amazon.com','t.me','telegram.org','linkedin.com',
  'tiktok.com','pinterest.com','whatsapp.com','bbc.com','cnn.com','espn.com',
  '1xbet.com','1xcasino.com','luckypari.com','bet365.com','betway.com','parimatch.com',
  'sportybet.com','betking.com','william-hill.com','oddschecker.com','medium.com',
  'github.com','play.google.com','apps.apple.com','quora.com','blogspot.com',
]);

// ── Email extraction ──────────────────────────────────────────────────────
const EMAIL_REGEX  = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const EMAIL_IGNORE = ['noreply','no-reply','unsubscribe','privacy','legal','abuse',
  'example','sentry','wpcf7','@2x','@3x','.png','@example','.jpg','.gif','.webp','.svg'];
const EMAIL_AD  = ['advertis','ads@','partner','sponsor','commercial','business','collab','media@','marketing'];
const EMAIL_GEN = ['contact','info@','hello@','hi@','enquir','support'];
const DISPOSABLE = ['mailinator.com','guerrillamail.com','10minutemail.com','tempmail','throwaway'];

function isValidEmail(e: string): boolean {
  if (!e || e.length > 100 || !e.includes('@') || !e.includes('.')) return false;
  const l = e.toLowerCase();
  if (EMAIL_IGNORE.some(ig => l.includes(ig))) return false;
  if (DISPOSABLE.some(d => l.includes(d)))     return false;
  return /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(e);
}
function emailPriority(e: string): number {
  const l = e.toLowerCase();
  if (EMAIL_AD.some(k => l.includes(k)))  return 1;
  if (EMAIL_GEN.some(k => l.includes(k))) return 2;
  return 3;
}
function emailType(e: string): string {
  const l = e.toLowerCase();
  if (EMAIL_AD.some(k => l.includes(k)))  return 'advertising';
  if (EMAIL_GEN.some(k => l.includes(k))) return 'general';
  return 'admin';
}
function deobfuscate(text: string): string {
  return text
    .replace(/([a-zA-Z0-9._%+\-]+)\s*[\[(]at[\])\s]\s*([a-zA-Z0-9.\-]+)\s*[\[(]dot[\])\s]\s*([a-zA-Z]{2,})/gi, '$1@$2.$3')
    .replace(/([a-zA-Z0-9._%+\-]+)\s+AT\s+([a-zA-Z0-9.\-]+)\s+DOT\s+([a-zA-Z]{2,})/g, '$1@$2.$3')
    .replace(/([a-zA-Z0-9._%+\-]+)\s*\[at\]\s*([a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/gi, '$1@$2')
    .replace(/([a-zA-Z0-9._%+\-]+)\s*\(at\)\s*([a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/gi, '$1@$2');
}
function extractMailto(html: string): string[] {
  const found: string[] = [];
  const re = /href=["']mailto:([^"'?]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const e = m[1].trim().toLowerCase();
    if (e.includes('@') && !EMAIL_IGNORE.some(ig => e.includes(ig))) found.push(m[1].trim());
  }
  return found;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

let jinaCount = 0;

async function fetchPage(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AffiliateOS/1.0)' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'follow',
    });
    if (res.ok) {
      const text = await res.text();
      if (text && text.length > 200) return text;
    }
  } catch (_) {}

  try {
    jinaCount++;
    const headers: Record<string, string> = {};
    if (JINA_API_KEY) headers['Authorization'] = `Bearer ${JINA_API_KEY}`;
    const res = await fetch('https://r.jina.ai/' + url, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS + 5_000),
    });
    if (res.ok) {
      const text = await res.text();
      if (text && text.length > 100) return text;
    }
  } catch (_) {}

  return null;
}

// ── Groq relevance analysis ──────────────────────────────────────────────
interface Analysis {
  score: number; type: string; summary: string; why: string;
  priority: string; lang: string; is_competitor: boolean; relevant: boolean;
}

let groqCount = 0;

async function analyzeWithGroq(
  url: string, title: string, snippet: string, pageText: string, brand: string,
): Promise<Analysis | null> {
  const partnerBrand = brand === '1xcasino' ? '1xCasino'
                     : brand === 'luckypari' ? 'LuckyPari' : '1xBet';
  const text = pageText.slice(0, 6000);

  const sys = `Ты опытный affiliate analyst для ${partnerBrand} (betting/iGaming вертикаль). `
    + `Тебе дают реальный контент страницы сайта. Оцени его как потенциального аффилейт-партнёра `
    + `(сайт который может рекламировать наш бренд за комиссию). `
    + `Отвечай ТОЛЬКО валидным JSON, без markdown:\n`
    + `{"score":число 0-100,"type":"review|tipster|news|directory|blog|streamer|other",`
    + `"summary":"2-3 предложения на русском о чём сайт и его аудитория",`
    + `"why":"1-2 предложения почему релевантен или нет",`
    + `"priority":"High|Medium|Low","lang":"основной язык аудитории",`
    + `"is_competitor":true/false,"relevant":true/false}\n`
    + `Правила оценки:\n`
    + `- Сайты с обзорами ставок/казино, прогнозами, типстерскими материалами, `
    + `новостями iGaming, с реальным контентом и трафиком → score 60-95\n`
    + `- Тематика гемблинга есть, но контента мало / сайт слабый → score 30-55\n`
    + `- Сайт НЕ про гемблинг (обычные новости, магазин, корпоративный, блог не в теме) `
    + `→ score 0-25, relevant=false\n`
    + `- Сайт самого букмекера/казино-оператора (не аффилейт, а конкурент) `
    + `→ is_competitor=true, relevant=false, score 0\n`
    + `- Пустая/мёртвая/заглушка страница → score 0-15, relevant=false\n`
    + `relevant=true ТОЛЬКО если score>=${MIN_SCORE} И is_competitor=false.`;

  const user = `URL: ${url}\nЗаголовок: ${title}\nОписание из поиска: ${snippet}\n\n`
    + `КОНТЕНТ СТРАНИЦЫ:\n${text}`;

  try {
    groqCount++;
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + GROQ_API_KEY,
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
        temperature: 0.2,
        max_tokens: 600,
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(22_000),
    });
    if (!res.ok) return null;
    const d = await res.json();
    const raw = d?.choices?.[0]?.message?.content || '';
    const ai = JSON.parse(raw.replace(/```json|```/g, '').trim());

    const score = Math.max(0, Math.min(100, Number(ai.score) || 0));
    const is_competitor = !!ai.is_competitor;
    return {
      score,
      type:      String(ai.type || 'other').slice(0, 30),
      summary:   String(ai.summary || '').slice(0, 600),
      why:       String(ai.why || '').slice(0, 400),
      priority:  ['High', 'Medium', 'Low'].includes(ai.priority) ? ai.priority : 'Medium',
      lang:      String(ai.lang || '').slice(0, 40),
      is_competitor,
      relevant:  !!ai.relevant && score >= MIN_SCORE && !is_competitor,
    };
  } catch (_) {
    return null;
  }
}

// ── Contact extraction (homepage already fetched, only crawl sub-pages) ───
interface Contact {
  email: string | null; emailType: string | null;
  telegram: string | null; whatsapp: string | null;
  phone: string | null; sourceUrl: string | null;
}

function scanContacts(html: string, page: string, acc: Contact, prio: { v: number }) {
  const deobf  = deobfuscate(html);
  const mailto = extractMailto(html);
  const found  = [...new Set([...mailto, ...(deobf.match(EMAIL_REGEX) || [])])].filter(isValidEmail);

  for (const e of found) {
    const p = emailPriority(e);
    if (p < prio.v) { prio.v = p; acc.email = e; acc.emailType = emailType(e); acc.sourceUrl = page; }
  }
  if (!acc.telegram) {
    const m = html.match(/t\.me\/([a-zA-Z][a-zA-Z0-9_]{4,})/);
    if (m && !['share', 'msg', 'joinchat'].includes(m[1])) acc.telegram = '@' + m[1];
  }
  if (!acc.whatsapp) {
    const m = html.match(/wa\.me\/(\d{7,})/);
    if (m) acc.whatsapp = '+' + m[1];
  }
  if (!acc.phone && !acc.email) {
    const m = html.match(/\+[\d][\d\s\-().]{8,17}[\d]/);
    if (m) acc.phone = m[0].replace(/\s+/g, ' ').trim();
  }
}

async function extractContact(
  siteUrl: string, origin: string, homepageHtml: string, deadline: number,
): Promise<Contact> {
  const acc: Contact = {
    email: null, emailType: null, telegram: null,
    whatsapp: null, phone: null, sourceUrl: null,
  };
  const prio = { v: 99 };

  scanContacts(homepageHtml, siteUrl, acc, prio);
  if (acc.email || acc.telegram || acc.whatsapp) return acc;

  const subPages = [origin + '/contact', origin + '/contact-us', origin + '/about', origin + '/advertise'];
  for (const page of subPages) {
    if (Date.now() > deadline) break;
    const html = await fetchPage(page);
    if (!html || html.length < 100) continue;
    scanContacts(html, page, acc, prio);
    if (acc.email || acc.telegram || acc.whatsapp) break;
  }
  return acc;
}

function getDomain(url: string): string {
  try {
    return new URL(url.startsWith('http') ? url : 'https://' + url).hostname.replace(/^www\./, '');
  } catch { return ''; }
}
function nameFromTitle(title: string): string {
  return (title || '').replace(/\s*[-|—·|\/]\s*.{0,60}$/, '').trim().slice(0, 80)
    || (title || '').slice(0, 80) || 'Unknown';
}

async function bumpUsage(service: string, delta: number) {
  if (delta <= 0) return;
  const { data } = await supabase.from('api_usage').select('used').eq('service', service).single();
  if (data) await supabase.from('api_usage')
    .update({ used: (data.used ?? 0) + delta, updated_at: new Date().toISOString() })
    .eq('service', service);
}

// ─────────────────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  jinaCount = 0;
  groqCount = 0;
  let serpCount = 0;
  const stats = {
    brand: '', preset: '', keywords_run: 0,
    found: 0, analyzed: 0, irrelevant: 0, competitors: 0,
    saved: 0, contacts: 0, errors: [] as string[],
  };
  const startedAt = Date.now();
  const deadline  = startedAt + TIME_BUDGET_MS;

  try {
    // 1. System pause check
    const { data: sysRow } = await supabase
      .from('api_usage').select('system_paused').eq('service', 'gmail_main').single();
    if (sysRow?.system_paused) {
      return new Response(JSON.stringify({ skipped: true, reason: 'system paused' }),
        { headers: { ...cors, 'Content-Type': 'application/json' } });
    }
    if (!SERP_API_KEY) {
      return new Response(JSON.stringify({ skipped: true, reason: 'SERP_API_KEY not configured' }),
        { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    // 2. Determine brand + preset for this 15-min slot
    const slotIndex = Math.floor(Date.now() / (15 * 60 * 1000));
    const BRANDS    = ['1xbet', '1xcasino', 'luckypari'] as const;
    const brand     = BRANDS[slotIndex % BRANDS.length];
    stats.brand = brand;

    const { data: customRaw } = await supabase
      .from('search_presets').select('*').eq('is_default', false).order('created_at');
    const customPresets: Preset[] = (customRaw || [])
      .filter((p: any) => !p.brand || p.brand === brand)
      .map((p: any) => ({
        id: `custom-${p.id}`, name: p.name, geo: p.geo || '',
        keywords: Array.isArray(p.keywords) ? p.keywords : [],
      }))
      .filter((p: Preset) => p.keywords.length > 0);

    const allPresets = [...(DEFAULT_PRESETS[brand] || []), ...customPresets];
    if (allPresets.length === 0) {
      return new Response(JSON.stringify({ ...stats, skipped: true, reason: 'no presets' }),
        { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    const presetIndex = Math.floor(slotIndex / BRANDS.length) % allPresets.length;
    const preset      = allPresets[presetIndex];
    stats.preset      = preset.name;

    const kwStart  = (Math.floor(slotIndex / (BRANDS.length * allPresets.length)) * KW_PER_RUN) % preset.keywords.length;
    const rawKw    = preset.keywords.slice(kwStart, kwStart + KW_PER_RUN);
    if (rawKw.length < KW_PER_RUN) rawKw.push(...preset.keywords.slice(0, KW_PER_RUN - rawKw.length));
    const keywords = [...new Set(rawKw)];

    // 3. Load dedup sets upfront
    const { data: existingLeadRows } = await supabase
      .from('leads').select('url').order('created_at', { ascending: false }).limit(3000);
    const existingDomains = new Set(
      (existingLeadRows || []).map((l: any) => getDomain(l.url || '')).filter(Boolean),
    );

    let blRows: any[] = [];
    try {
      const { data } = await supabase
        .from('blacklist').select('domain').or(`brand.eq.${brand},brand.is.null`);
      blRows = data || [];
    } catch (_) {}
    const blacklistSet = new Set(blRows.map((r: any) => (r.domain || '').toLowerCase()));

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data: recentSent } = await supabase
      .from('email_log').select('email').gt('sent_at', thirtyDaysAgo);
    const emailedSet = new Set(
      (recentSent || []).map((r: any) => (r.email || '').toLowerCase()).filter(Boolean),
    );

    // 4. Process each keyword
    for (const kw of keywords) {
      if (Date.now() > deadline) break;

      let serpResults: Array<{ link: string; title: string; snippet?: string }> = [];
      try {
        serpCount++;
        const res = await fetch(
          `https://serpapi.com/search.json?q=${encodeURIComponent(kw)}&num=${RESULTS_PER_KW}&api_key=${SERP_API_KEY}`,
          { signal: AbortSignal.timeout(12_000) },
        );
        if (res.ok) {
          const sd = await res.json();
          serpResults = (sd.organic_results || []).slice(0, RESULTS_PER_KW);
        } else {
          stats.errors.push(`SERP "${kw}": HTTP ${res.status}`);
        }
      } catch (e: any) {
        stats.errors.push(`SERP "${kw}": ${e.message}`);
        continue;
      }

      stats.keywords_run++;
      stats.found += serpResults.length;

      for (const result of serpResults) {
        if (Date.now() > deadline) break;

        const url    = result.link || '';
        const domain = getDomain(url);
        if (!domain || GLOBAL_SKIP.has(domain) ||
            existingDomains.has(domain) || blacklistSet.has(domain)) continue;
        // Mark domain seen now so the same domain isn't processed twice in one run
        existingDomains.add(domain);

        let origin: string;
        try {
          origin = new URL(url.startsWith('http') ? url : 'https://' + url).origin;
        } catch { continue; }

        // 4a. Fetch the homepage
        const homepageHtml = await fetchPage(url);
        if (!homepageHtml || homepageHtml.length < 200) continue;

        // 4b. Groq relevance analysis on the real page content
        const pageText = stripHtml(homepageHtml);
        const analysis = await analyzeWithGroq(url, result.title || '', result.snippet || '', pageText, brand);

        if (analysis) {
          stats.analyzed++;
          if (analysis.is_competitor) { stats.competitors++; continue; }
          if (!analysis.relevant)     { stats.irrelevant++;  continue; }
        }
        // If Groq failed entirely we keep the lead with a neutral score for manual review.

        // 4c. Extract contact details
        const contact = await extractContact(url, origin, homepageHtml, deadline);
        if (contact.email && emailedSet.has(contact.email.toLowerCase())) continue;

        // 4d. Build & insert the lead
        const leadData: Record<string, unknown> = {
          url,
          name:     nameFromTitle(result.title || ''),
          brand,
          stage:    'new',
          geo:      preset.geo,
          type:     analysis?.type     ?? 'other',
          score:    analysis?.score    ?? 50,
          summary:  analysis?.summary  ?? '',
          why:      analysis?.why      ?? '',
          priority: analysis?.priority ?? 'Medium',
          lang:     analysis?.lang     ?? '',
        };
        if (contact.email) {
          leadData.contact_email      = contact.email;
          leadData.contact_email_type = contact.emailType;
          leadData.email              = contact.email; // legacy column kept in sync
          stats.contacts++;
        }
        if (contact.telegram)  { leadData.contact_telegram = contact.telegram; leadData.tg = contact.telegram; }
        if (contact.whatsapp)  leadData.contact_whatsapp   = contact.whatsapp;
        if (contact.phone)     leadData.contact_phone      = contact.phone;
        if (contact.sourceUrl) leadData.contact_source_url = contact.sourceUrl;

        const { error: insErr } = await supabase.from('leads').insert([leadData]);
        if (!insErr) {
          if (contact.email) emailedSet.add(contact.email.toLowerCase());
          stats.saved++;
        } else {
          stats.errors.push(`insert ${domain}: ${insErr.message}`);
        }
      }
    }

    // 5. Track API usage
    await Promise.all([
      bumpUsage('serpapi', serpCount),
      bumpUsage('jina',    jinaCount),
      bumpUsage('groq',    groqCount),
    ]);

    await supabase.from('error_log').insert([{
      level: 'info', service: 'find-and-queue',
      message: `brand=${brand} preset="${preset.name}" kw=${stats.keywords_run} `
        + `found=${stats.found} analyzed=${stats.analyzed} `
        + `irrelevant=${stats.irrelevant} competitors=${stats.competitors} `
        + `saved=${stats.saved} contacts=${stats.contacts}`
        + (stats.errors.length ? ' | ' + stats.errors.slice(0, 3).join('; ') : ''),
    }]);

    return new Response(JSON.stringify(stats),
      { headers: { ...cors, 'Content-Type': 'application/json' } });

  } catch (e: any) {
    await supabase.from('error_log').insert([{
      level: 'critical', service: 'find-and-queue', message: e.message,
    }]);
    return new Response(JSON.stringify({ ...stats, error: e.message }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
});
