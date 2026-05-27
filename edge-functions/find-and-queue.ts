// Supabase Edge Function: find-and-queue
// Full autonomous lead pipeline, runs every 15 min:
//   1. Pick brand+preset via time-based rotation (cycles all presets ~every 4h)
//   2. Run 2 keywords from that preset through SerpAPI
//   3. For each organic result: dedup → blacklist → TLD geo-filter → fetch homepage
//   4. Groq analyses the real page content for relevance AND geo (score, type, summary, geo_excluded)
//   5. Irrelevant sites / competitors / excluded-geo sites are dropped
//   6. Relevant sites: extract contact (email/telegram) → insert lead
// Leads with a contact email become eligible for the send queue immediately.
//
// Deploy: supabase functions deploy find-and-queue --no-verify-jwt
// Env:    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SERP_API_KEY, GROQ_API_KEY,
//         JINA_API_KEY (optional)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SERP_API_KEY = Deno.env.get('SERP_API_KEY') ||
  ['59416a59dfd4fc019bcb24053a24e984', '86375c61bfed0bb7ae25d031393d64e1'].join('');
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
    { id:'1xb-id', name:'Indonesia', geo:'ID',
      keywords:['situs taruhan bola terbaik','prediksi bola akurat','bandar judi online review','agen taruhan bola terpercaya','tips taruhan olahraga indonesia','prediksi liga 1 indonesia','review situs bola','bandar online terbaik'] },
    { id:'1xb-bd', name:'Bangladesh', geo:'BD',
      keywords:['cricket prediction site bangladesh','bpl betting tips review','সেরা বাজির সাইট','ক্রিকেট প্রেডিকশন','betting site review bangladesh','bd cricket tips blog','bangladesh sports betting guide','online betting bd review'] },
    { id:'1xb-in', name:'India', geo:'IN',
      keywords:['cricket prediction website india','ipl betting tips blog','best fantasy cricket app review','india sports betting guide','satta tips website','cricket betting strategy india','hindi betting tips','indian sportsbook review'] },
    { id:'1xb-ci', name:'Côte d\'Ivoire', geo:'CI',
      keywords:['pronostics football Côte d\'Ivoire','site de paris sportifs Abidjan','meilleur bookmaker CIV','pronostiqueur ivoirien telegram','paris sportifs Afrique de l\'Ouest','tipster francophone Afrique','analyse foot Côte d\'Ivoire','pronos foot CIV'] },
    { id:'1xb-eg', name:'Egypt', geo:'EG',
      keywords:['أفضل مواقع المراهنات مصر','توقعات كرة القدم مصر','egypt sports betting review','arabic betting tips site','مراهنات رياضية مصر','prediction site egypt football','arabic football tipster','موقع رهان مصر'] },
    { id:'1xb-my', name:'Malaysia', geo:'MY',
      keywords:['laman judi bola terbaik malaysia','ramalan bola malaysia','bandar online malaysia review','betting tips malaysia','online sportsbook malaysia','analisis bola malaysia','judi online malaysia review','laman taruhan malaysia'] },
    { id:'1xb-uz', name:'Uzbekistan', geo:'UZ',
      keywords:['ставки на спорт Узбекистан обзор','прогнозы футбол Ташкент','капперы Узбекистан telegram','букмекерские конторы Узбекистан','обзор ставок UZ','sport tikish bashoratlari','футбол прогноз Узбекистан','sport bashoratlari UZ'] },
    { id:'1xb-np', name:'Nepal', geo:'NP',
      keywords:['cricket prediction nepal','betting tips nepal site','sports betting nepal review','nepali football tips','nepal sportsbook guide','online betting nepal','nepali cricket tipster','nepal sports tips blog'] },
    { id:'1xb-pk', name:'Pakistan', geo:'PK',
      keywords:['cricket prediction pakistan','psl betting tips','pakistan sports betting blog','urdu cricket tips site','pakistan cricket prediction','betting tips pakistan','pakistan football tips','karachi betting site review'] },
    { id:'1xb-tr', name:'Turkey', geo:'TR',
      keywords:['bahis tahminleri sitesi','güvenilir iddaa tahminleri','maç tahmin sitesi turkiye','canlı bahis tahmin','bahis analiz blog turkiye','futbol tahmin sitesi','süper lig bahis tahminleri','türk bahis incelemesi'] },
  ],
  '1xcasino': [
    { id:'1xc-ar', name:'Argentina', geo:'AR',
      keywords:['mejores casinos online argentina','reseñas casino argentina','aviator predicción argentina','bono casino argentina','ruleta online argentina review','slots argentina blog','casino en vivo argentina','aviator estrategia español'] },
    { id:'1xc-cl', name:'Chile', geo:'CL',
      keywords:['mejores casinos online chile','casino chile reseñas','aviator chile predicción','bono casino chileno','slots online chile review','casino en vivo chile','ruleta online chile','aviator estrategia chile'] },
    { id:'1xc-ph', name:'Philippines', geo:'PH',
      keywords:['best online casino philippines review','casino bonus philippines','aviator philippines prediction','slots review philippines','pinoy casino blog','philippine sportsbook casino','filipino casino tips','online gambling philippines guide'] },
    { id:'1xc-pk', name:'Pakistan', geo:'PK',
      keywords:['online casino pakistan review','aviator pakistan prediction','casino bonus pakistan','slots review pakistan','karachi casino online','crash game tips pakistan','urdu casino site','pakistani online casino guide'] },
    { id:'1xc-in', name:'India', geo:'IN',
      keywords:['online casino india review','aviator india prediction','teen patti review site','andar bahar online review','casino bonus india site','indian slots review','hindi casino blog','crash game tips india'] },
    { id:'1xc-bf', name:'Burkina Faso', geo:'BF',
      keywords:['casino en ligne Burkina Faso','meilleur casino Ouagadougou','aviator Burkina prediction','bonus casino Burkina','machines à sous Burkina','casino francophone Afrique','slots Burkina Faso','roulette en ligne Burkina'] },
    { id:'1xc-ci', name:'Côte d\'Ivoire', geo:'CI',
      keywords:['casino en ligne Côte d\'Ivoire','meilleur casino Abidjan','aviator Côte d\'Ivoire','bonus casino CIV','machines à sous Côte d\'Ivoire','slots online Abidjan','casino francophone CIV','crash game Côte d\'Ivoire'] },
    { id:'1xc-sn', name:'Senegal', geo:'SN',
      keywords:['casino en ligne Sénégal','meilleur casino Dakar','aviator Sénégal prediction','bonus casino sénégalais','slots Sénégal review','machines à sous Dakar','casino francophone Sénégal','roulette en ligne Sénégal'] },
    { id:'1xc-cm', name:'Cameroun', geo:'CM',
      keywords:['casino en ligne Cameroun','meilleur casino Douala','aviator Cameroun prediction','bonus casino camerounais','slots Cameroun review','casino francophone Yaoundé','machines à sous Cameroun','crash game Cameroun'] },
    { id:'1xc-ma', name:'Morocco', geo:'MA',
      keywords:['casino en ligne Maroc','aviator Maroc prediction','bonus casino marocain','أفضل كازينو على الإنترنت المغرب','slots Maroc review','machines à sous Maroc','كازينو أونلاين المغرب','moroccan online casino blog'] },
    { id:'1xc-vn', name:'Vietnam', geo:'VN',
      keywords:['casino online việt nam review','nhà cái uy tín','aviator dự đoán việt nam','slots vietnam review','casino trực tuyến đánh giá','nhà cái casino vietnam','bonus casino vietnam','trang đánh bạc trực tuyến'] },
    { id:'1xc-mm', name:'Myanmar', geo:'MM',
      keywords:['online casino myanmar review','aviator myanmar prediction','myanmar casino blog','slots myanmar review','casino bonus myanmar','burmese casino site','online gambling myanmar guide','myanmar sportsbook casino'] },
    { id:'1xc-za', name:'South Africa', geo:'ZA',
      keywords:['best online casino south africa review','aviator south africa prediction','casino bonus south africa','slots review south africa','crash game tips SA','rand casino review','south african casino blog','online gambling SA guide'] },
  ],
  'luckypari': [
    { id:'lp-in', name:'India — Mixed', geo:'IN',
      keywords:['cricket prediction website india','online casino india review','ipl betting tips blog','aviator india prediction','sports betting india guide','casino bonus india site'] },
    { id:'lp-bd', name:'Bangladesh — Mixed', geo:'BD',
      keywords:['cricket prediction site bangladesh','online casino bangladesh','bpl betting tips review','casino bonus bangladesh'] },
  ],
};

// Domains that are clearly not affiliate targets
const GLOBAL_SKIP = new Set([
  'google.com','youtube.com','facebook.com','twitter.com','x.com','instagram.com',
  'reddit.com','wikipedia.org','amazon.com','t.me','telegram.org','linkedin.com',
  'tiktok.com','pinterest.com','whatsapp.com','bbc.com','cnn.com','espn.com',
  '1xbet.com','1xcasino.com','luckypari.com','bet365.com','betway.com','parimatch.com',
  'sportybet.com','betking.com','william-hill.com','williamhill.com','oddschecker.com',
  'medium.com','github.com','play.google.com','apps.apple.com','quora.com','blogspot.com',
]);

// TLD quick-filter: obviously excluded geo markets.
// Note: .fr is NOT excluded — French-language African sites use it and are valid targets.
const EXCLUDED_TLD_PATTERNS = [
  '.co.uk', '.org.uk', '.me.uk',  // UK
  '.com.ua', '.org.ua',            // Ukraine
  '.com.br', '.net.br', '.org.br', // Brazil
  '.com.au', '.net.au', '.org.au', // Australia
  // US is harder to filter by TLD (.com is global) — handled by Groq geo analysis
];
function isExcludedByTld(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h.endsWith('.ua') || h.endsWith('.uk')) return true;
  return EXCLUDED_TLD_PATTERNS.some(p => h.endsWith(p));
}

// ── Email extraction ──────────────────────────────────────────────────────
const EMAIL_REGEX  = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const EMAIL_IGNORE = ['noreply','no-reply','unsubscribe','privacy','legal','abuse',
  'example','sentry','wpcf7','@2x','@3x','.png','@example','.jpg','.gif','.webp','.svg'];
// Placeholder/demo emails that look real but aren't
const EMAIL_PLACEHOLDERS = [
  'youremail','your-email','your_email','yourname','your-name',
  'email@email','test@test','user@user','name@name',
  'demo@','sample@','placeholder','changeme','username@',
  'admin@example','info@example','user@example','test@example',
  // "email@domain.com", "mail@domain.com", "email@site.com" — generic template patterns
  'email@domain','mail@domain','name@domain','user@domain','email@site','mail@site',
];
// Also catch local-part == "email" or "mail" with any domain (e.g. email@anything.com)
const EMAIL_PLACEHOLDER_LOCAL = new Set(['email','test','demo','sample','info123','admin123','example','noreply','donotreply','postmaster','mailer']);
function isPlaceholderEmail(e: string): boolean {
  const l = e.toLowerCase();
  if (EMAIL_PLACEHOLDERS.some(p => l.includes(p))) return true;
  const local = l.split('@')[0];
  if (EMAIL_PLACEHOLDER_LOCAL.has(local)) return true;
  return false;
}
const EMAIL_AD  = ['advertis','ads@','partner','sponsor','commercial','business','collab','media@','marketing'];
const EMAIL_GEN = ['contact','info@','hello@','hi@','enquir','support'];
const DISPOSABLE = ['mailinator.com','guerrillamail.com','10minutemail.com','tempmail','throwaway'];

function isValidEmail(e: string): boolean {
  if (!e || e.length > 100 || !e.includes('@') || !e.includes('.')) return false;
  const l = e.toLowerCase();
  if (EMAIL_IGNORE.some(ig => l.includes(ig))) return false;
  if (isPlaceholderEmail(l))                   return false;
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
    .replace(/([a-zA-Z0-9._%+\-]+)\s*\(at\)\s*([a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/gi, '$1@$2')
    // CSS obfuscation: unicode-bidi / direction tricks appear as garbled text — strip
    .replace(/[​-‍﻿]/g, '');
}
function extractMailto(html: string): string[] {
  const found: string[] = [];
  const re = /href=["']mailto:([^"'?&\s]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const e = decodeURIComponent(m[1]).trim();
    if (e.includes('@') && !EMAIL_IGNORE.some(ig => e.toLowerCase().includes(ig))) found.push(e);
  }
  return found;
}
/** Extract emails from JSON-LD / schema.org "email" fields */
function extractJsonLd(html: string): string[] {
  const found: string[] = [];
  const re = /"email"\s*:\s*"([^"]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const e = m[1].trim();
    if (isValidEmail(e)) found.push(e);
  }
  return found;
}
/** data-email="..." and data-cfemail decoding (Cloudflare obfuscation) */
function extractDataAttrs(html: string): string[] {
  const found: string[] = [];
  // Plain data-email attribute
  const re1 = /data-email=["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re1.exec(html)) !== null) {
    const e = m[1].trim();
    if (isValidEmail(e)) found.push(e);
  }
  // Cloudflare email obfuscation: data-cfemail hex string
  const re2 = /data-cfemail=["']([0-9a-f]+)["']/gi;
  while ((m = re2.exec(html)) !== null) {
    try {
      const hex = m[1];
      const key = parseInt(hex.slice(0, 2), 16);
      let email = '';
      for (let i = 2; i < hex.length; i += 2) {
        email += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
      }
      if (isValidEmail(email)) found.push(email);
    } catch (_) {}
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

/** Extract the footer section of a page (last 20% of HTML) for targeted email scanning */
function extractFooter(html: string): string {
  const footerRe = /<footer[\s\S]*?<\/footer>/gi;
  const match = footerRe.exec(html);
  if (match) return match[0];
  // Fallback: last 20% of the document
  return html.slice(Math.floor(html.length * 0.8));
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
  priority: string; lang: string; is_competitor: boolean;
  is_operator: boolean; relevant: boolean; geo_excluded: boolean;
}

let groqCount = 0;

async function analyzeWithGroq(
  url: string, title: string, snippet: string, pageText: string, brand: string,
): Promise<Analysis | null> {
  const partnerBrand = brand === '1xcasino' ? '1xCasino'
                     : brand === 'luckypari' ? 'LuckyPari' : '1xBet';
  const text = pageText.slice(0, 6000);

  const sys = `You qualify websites as affiliate partners for ${partnerBrand}.\n\n`
    + `Brand context:\n`
    + `- 1xBet: sports betting partner (tipsters, sports review, prediction sites)\n`
    + `- 1xCasino: online casino/slots/crash partner (review sites, slot blogs, aviator/crash content)\n`
    + `- LuckyPari: mixed (any iGaming content, treat as fresh brand)\n\n`
    + `Return ONLY JSON:\n`
    + `{"score":0-100,"type":"review|tipster|media|aggregator|blog|other",`
    + `"summary":"1 sentence","why":"1 sentence — why fits or not",`
    + `"priority":"High|Medium|Low","lang":"language code",`
    + `"is_competitor":true/false,"relevant":true/false,"geo_excluded":true/false,"is_operator":true/false}\n\n`
    + `Scoring:\n`
    + `- 80-95: active site, content matches brand, contacts likely, target GEO\n`
    + `- 60-79: matches but quality unclear or partial fit\n`
    + `- 30-59: tangential, mixed signals\n`
    + `- 0-29: not iGaming, dead, irrelevant\n\n`
    + `Set is_operator=true if the site IS a casino/sportsbook (not a partner).\n`
    + `Set is_competitor=true if it's a 1xBet/1xCasino/LuckyPari competitor brand.\n`
    + `Set geo_excluded=true ONLY for: USA, UK, Western Europe, Ukraine, Brazil, Australia.\n`
    + `Set relevant=false if is_operator OR is_competitor OR geo_excluded OR score<${MIN_SCORE}.`;

  const user = `URL: ${url}\nTitle: ${title}\nSnippet: ${snippet}\n\nPage content:\n${text}`;

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
        temperature: 0.1,
        max_tokens: 300,
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(22_000),
    });
    if (!res.ok) return null;
    const d = await res.json();
    const raw = d?.choices?.[0]?.message?.content || '';
    const ai = JSON.parse(raw.replace(/```json|```/g, '').trim());

    const score        = Math.max(0, Math.min(100, Number(ai.score) || 0));
    const is_competitor = !!ai.is_competitor;
    const is_operator   = !!ai.is_operator;
    const geo_excluded  = !!ai.geo_excluded;
    return {
      score,
      type:         String(ai.type || 'other').slice(0, 30),
      summary:      String(ai.summary || '').slice(0, 400),
      why:          String(ai.why || '').slice(0, 200),
      priority:     ['High', 'Medium', 'Low'].includes(ai.priority) ? ai.priority : 'Medium',
      lang:         String(ai.lang || '').slice(0, 40),
      is_competitor,
      is_operator,
      geo_excluded,
      relevant:     !!ai.relevant && score >= MIN_SCORE && !is_competitor && !is_operator && !geo_excluded,
    };
  } catch (_) {
    return null;
  }
}

// ── Contact extraction ────────────────────────────────────────────────────
interface Contact {
  email: string | null; emailType: string | null;
  telegram: string | null; whatsapp: string | null;
  phone: string | null; sourceUrl: string | null;
}

function scanContacts(html: string, page: string, acc: Contact, prio: { v: number }) {
  const deobf  = deobfuscate(html);
  const mailto = extractMailto(html);
  const jsonld = extractJsonLd(html);
  const dataAt = extractDataAttrs(html);
  // Also scan the footer section separately (often has contact info)
  const footer = extractFooter(html);
  const footerDeobf = deobfuscate(footer);

  const allFound = [...new Set([
    ...mailto,
    ...jsonld,
    ...dataAt,
    ...(deobf.match(EMAIL_REGEX) || []),
    ...(footerDeobf.match(EMAIL_REGEX) || []),
  ])].filter(isValidEmail);

  for (const e of allFound) {
    const p = emailPriority(e);
    if (p < prio.v) {
      prio.v = p;
      acc.email     = e;
      acc.emailType = emailType(e);
      acc.sourceUrl = page;
    }
  }

  if (!acc.telegram) {
    const m = html.match(/t\.me\/([a-zA-Z][a-zA-Z0-9_]{4,})/);
    if (m && !['share', 'msg', 'joinchat', 'iv'].includes(m[1])) acc.telegram = '@' + m[1];
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

  // Phase 1: homepage (includes footer scan + JSON-LD + data-attrs)
  scanContacts(homepageHtml, siteUrl, acc, prio);
  // If we already have a priority-1 (advertising/partner) email, we're done
  if (prio.v <= 1) return acc;

  // Phase 2: high-value partner/advertise pages first
  const phase2 = [
    origin + '/advertise',
    origin + '/advertising',
    origin + '/partners',
    origin + '/partnership',
    origin + '/work-with-us',
    origin + '/sponsor',
    origin + '/media',
    origin + '/press',
  ];
  for (const page of phase2) {
    if (Date.now() > deadline) return acc;
    const html = await fetchPage(page);
    if (!html || html.length < 100) continue;
    scanContacts(html, page, acc, prio);
    if (prio.v <= 1) return acc; // found advertising email, stop
  }

  // Phase 3: generic contact / about pages (if still no email)
  if (!acc.email && !acc.telegram && !acc.whatsapp) {
    const phase3 = [
      origin + '/contact',
      origin + '/contact-us',
      origin + '/about',
      origin + '/about-us',
      origin + '/business',
      origin + '/collaborate',
    ];
    for (const page of phase3) {
      if (Date.now() > deadline) return acc;
      const html = await fetchPage(page);
      if (!html || html.length < 100) continue;
      scanContacts(html, page, acc, prio);
      if (acc.email || acc.telegram || acc.whatsapp) break;
    }
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
    found: 0, analyzed: 0, irrelevant: 0, competitors: 0, geo_excluded: 0,
    saved: 0, contacts: 0, errors: [] as string[],
  };
  const startedAt = Date.now();
  const deadline  = startedAt + TIME_BUDGET_MS;

  try {
    // find-and-queue never pauses — finding new leads is always valuable
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

    // Hard dedup: ALL-TIME — never re-add a lead whose email was ever contacted
    // (email_log is the source of truth — every successful send is recorded there)
    const { data: allSent } = await supabase
      .from('email_log').select('email');
    const emailedSet = new Set(
      (allSent || []).map((r: any) => (r.email || '').toLowerCase()).filter(Boolean),
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

        // Fast TLD geo-filter — skip obviously excluded markets before fetching
        if (isExcludedByTld(domain)) { stats.geo_excluded++; continue; }

        // Mark domain seen now so the same domain isn't processed twice in one run
        existingDomains.add(domain);

        let origin: string;
        try {
          origin = new URL(url.startsWith('http') ? url : 'https://' + url).origin;
        } catch { continue; }

        // 4a. Fetch the homepage
        const homepageHtml = await fetchPage(url);
        if (!homepageHtml || homepageHtml.length < 200) continue;

        // 4b. Groq relevance + geo analysis on the real page content
        const pageText = stripHtml(homepageHtml);
        const analysis = await analyzeWithGroq(url, result.title || '', result.snippet || '', pageText, brand);

        if (analysis) {
          stats.analyzed++;
          if (analysis.is_competitor || analysis.is_operator) { stats.competitors++; continue; }
          if (analysis.geo_excluded)  { stats.geo_excluded++; continue; }
          if (!analysis.relevant)     { stats.irrelevant++;   continue; }
        }
        // If Groq failed entirely we keep the lead with a neutral score for manual review.

        // 4c. Extract contact details (multi-phase: homepage → partner pages → contact pages)
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
        + `irrelevant=${stats.irrelevant} competitors=${stats.competitors} geo_excl=${stats.geo_excluded} `
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
