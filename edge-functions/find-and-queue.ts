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
  ['gsk_9DKnaMxmKm8WEPDDjtZbWGdyb3FYX', 'R6kIEWkpNsjz6BlDlvj347v'].join('');
const BRAVE_API_KEY = Deno.env.get('BRAVE_API_KEY') || '';
const BING_API_KEY  = Deno.env.get('BING_API_KEY')  || '';

const TIME_BUDGET_MS   = 110_000;
const FETCH_TIMEOUT_MS = 7_000;
const RESULTS_PER_KW   = 12;
const KW_PER_RUN       = 5;
// Minimum Groq relevance score to keep a lead
const MIN_SCORE        = 40;
// Min ms between consecutive Groq calls — paces at ~27 req/min, safely under the 30/min free-tier limit
const GROQ_PACE_MS     = 2200;

// Minus-words appended to every DDG query to cut noise
const DDG_MINUS = '-forum -reddit -wikipedia -score -livescore -results -fixtures -login -apk';

// Pre-filter: drop results whose title/snippet/URL contain these strings (catches what DDG misses)
const RESULT_NOISE_TERMS = ['forum','reddit','wikipedia','livescore','flashscore','sofascore','results','fixtures','how to play','rules of ','login','sign up','download','apk','app store','google play'];
function isNoisyResult(url: string, title: string, snippet: string): boolean {
  const haystack = (url + ' ' + title + ' ' + snippet).toLowerCase();
  return RESULT_NOISE_TERMS.some(t => haystack.includes(t));
}

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Brand preset definitions (mirrors BRAND_PRESETS in index.html) ────────
interface Preset { id: string; name: string; geo: string; keywords: string[]; brand?: string | null }

const DEFAULT_PRESETS: Record<string, Preset[]> = {
  '1xbet': [
    { id:'1xb-ng', name:'Nigeria', geo:'NG',
      keywords:['best betting sites nigeria','top betting sites nigeria','betting sites comparison nigeria','bookmaker review nigeria','best online casino nigeria','new betting sites nigeria','betting bonus nigeria','casino review nigeria',
        'football prediction site nigeria','bet9ja alternatives nigeria','sports betting blog nigeria','nigeria betting tips today','naija betting guide','betting odds comparison nigeria','online gambling nigeria review','soccer prediction nigeria'] },
    { id:'1xb-kg', name:'Kyrgyzstan', geo:'KG',
      keywords:['рейтинг букмекеров кыргызстан','лучшие букмекерские конторы','обзор букмекеров','сравнение букмекеров','лучшие онлайн казино','обзор казино','рейтинг казино','бонусы букмекеров',
        'ставки на спорт обзор','прогнозы матчей кыргызстан','топ казино кыргызстан','букмекер бонус без депозита','спортивные ставки блог','казино бонус кыргызстан','беттинг сайт обзор','азартные игры кыргызстан'] },
    { id:'1xb-my', name:'Malaysia', geo:'MY',
      keywords:['best betting sites malaysia','best online casino malaysia','betting sites comparison malaysia','casino review malaysia','laman judi terbaik malaysia','ulasan kasino malaysia',
        'sportsbook review malaysia','taruhan online malaysia','bonus kasino malaysia','tipster malaysia','football prediction malaysia','judi bola review','kasino dalam talian malaysia','pertaruhan sukan malaysia'] },
    { id:'1xb-ph', name:'Philippines', geo:'PH',
      keywords:['best betting sites philippines','top online casino philippines','betting sites comparison philippines','casino review philippines','best sabong site','pinakamahusay na betting site','online casino review philippines',
        'sports betting review philippines','basketball betting philippines','gcash casino review','philbetting tips','online gambling guide philippines','football prediction philippines','filipino sports betting blog'] },
    { id:'1xb-np', name:'Nepal', geo:'NP',
      keywords:['best betting sites nepal','best cricket betting site nepal','betting sites comparison nepal','online casino review nepal','top betting sites nepal','उत्कृष्ट सट्टा साइट नेपाल',
        'ipl betting nepal','sports betting blog nepal','cricket tips nepal','gambling review nepal','betting guide nepal','nepal cricket prediction site'] },
    { id:'1xb-pk', name:'Pakistan', geo:'PK',
      keywords:['best betting sites pakistan','best cricket betting site pakistan','betting sites comparison pakistan','online casino review pakistan','top betting sites pakistan','بہترین بیٹنگ سائٹ پاکستان',
        'psl betting tips','cricket prediction pakistan','sports betting guide pakistan','online gambling pakistan','betting odds pakistan','pakistan cricket betting blog'] },
    { id:'1xb-ke', name:'Kenya', geo:'KE',
      keywords:['best betting sites kenya','top bookmakers kenya','sports betting kenya review','football prediction kenya','betting tips kenya','online casino kenya','soccer tips kenya',
        'kenya betting comparison','betika alternatives','sportpesa alternatives kenya','best odds kenya','betting bonus kenya','kenya gambling guide'] },
    { id:'1xb-gh', name:'Ghana', geo:'GH',
      keywords:['best betting sites ghana','top bookmakers ghana','sports betting ghana review','football prediction ghana','betting tips ghana','online casino ghana','soccer prediction ghana',
        'ghana betting comparison','betway alternatives ghana','sportybet ghana review','betting bonus ghana','ghana gambling blog','premier league tips ghana'] },
    { id:'1xb-in', name:'India', geo:'IN',
      keywords:['best betting sites india','cricket betting india review','ipl betting tips','betting sites comparison india','online casino india','sports betting blog india',
        'cricket prediction website india','fantasy cricket vs betting india','bet365 alternatives india','best odds india','betting guide india hindi','india betting bonus review'] },
    { id:'1xb-bd', name:'Bangladesh', geo:'BD',
      keywords:['best betting sites bangladesh','cricket betting bangladesh','bpl betting tips','online casino bangladesh','sports betting bangladesh review','betting tips bangladesh',
        'cricket prediction bangladesh','bangladesh gambling guide','online betting blog bangladesh','betting bonus bangladesh','football prediction bangladesh'] },
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
  // Social / general
  'google.com','youtube.com','facebook.com','twitter.com','x.com','instagram.com',
  'reddit.com','wikipedia.org','amazon.com','t.me','telegram.org','linkedin.com',
  'tiktok.com','pinterest.com','whatsapp.com','bbc.com','cnn.com','espn.com',
  'medium.com','github.com','play.google.com','apps.apple.com','quora.com','blogspot.com',
  // Big corporate platforms / portals — NOT affiliates, never contact
  'yandex.ru','yandex.com','maps.yandex.ru','market.yandex.ru','dzen.ru','zen.yandex.ru',
  'mail.ru','vk.com','ok.ru','rambler.ru','avito.ru','gosuslugi.ru','sberbank.ru','tinkoff.ru',
  'wildberries.ru','ozon.ru','2gis.ru','rbc.ru','rt.com','ria.ru','tass.ru','kommersant.ru',
  'apple.com','microsoft.com','samsung.com','huawei.com','xiaomi.com','baidu.com','aliexpress.com',
  'wordpress.com','wordpress.org','wix.com','shopify.com','cloudflare.com','godaddy.com',
  // Our own brands
  '1xbet.com','1xcasino.com','luckypari.com','1xpartners.com',
  // Known sportsbook / casino operators — never contact them as affiliates
  'bet365.com','betway.com','parimatch.com','sportybet.com','betking.com',
  'william-hill.com','williamhill.com','paddypower.com','ladbrokes.com','coral.co.uk',
  'bwin.com','unibet.com','888casino.com','888sport.com','betfair.com','pokerstars.com',
  'draftkings.com','fanduel.com','betonline.com','bovada.lv','mybookie.ag',
  'melbet.com','22bet.com','mostbet.com','pinup.casino','pin-up.casino',
  'bet9ja.com','1win.com','1win.pro','betwinner.com','bk8.com','betwinner.ng',
  'stake.com','mystake.com','rollbit.com','bc.game','cloudbet.com',
  'bitstarz.com','bitcasino.io','mbitcasino.com','rocketpot.io','n1casino.com',
  'casinodays.com','jackpotcity.com','spinaway.com','casumo.com','leovegas.com',
  'betsson.com','nordicbet.com','betsafe.com','rizk.com','dunder.com',
  'marathonbet.com','fonbet.com','winline.ru','ligastavok.ru','bk-leon.ru',
  'oddschecker.com','oddsportal.com','flashscore.com','livescore.com',
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

/** Search DuckDuckGo HTML — free, no key required.
 *  offset: 0 = page 1, 30 = page 2, 60 = page 3, etc. (DDG s= param) */
async function searchDuckDuckGo(
  query: string, num: number, offset = 0,
): Promise<Array<{ link: string; title: string; snippet: string }>> {
  const qs = offset > 0
    ? `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&s=${offset}&dc=${offset + 1}`
    : `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(qs,
    {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AffiliateOS/1.0)', 'Accept': 'text/html' },
      signal: AbortSignal.timeout(12_000),
    },
  );
  if (!res.ok) return [];
  const html = await res.text();

  const results: Array<{ link: string; title: string; snippet: string }> = [];

  // DDG HTML: result links are <a class="result__a" href="/l/?uddg=<encoded>&...">Title</a>
  const linkRe  = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|span|div)>/gi;

  const links: Array<{ url: string; title: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null && links.length < num * 2) {
    const rawHref = m[1];
    const title   = m[2].replace(/<[^>]+>/g, '').trim();
    let url = rawHref;
    // Decode the actual URL from the DDG redirect wrapper
    const uddg = rawHref.match(/[?&]uddg=([^&]+)/)?.[1];
    if (uddg) url = decodeURIComponent(uddg);
    if (url.startsWith('http') && !url.includes('duckduckgo.com')) {
      links.push({ url, title });
    }
  }

  const snippets: string[] = [];
  while ((m = snippRe.exec(html)) !== null) {
    snippets.push(m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
  }

  for (let i = 0; i < Math.min(links.length, num); i++) {
    results.push({ link: links[i].url, title: links[i].title, snippet: snippets[i] || '' });
  }
  return results;
}

/** Search Brave Search API — requires BRAVE_API_KEY env var */
async function searchBrave(
  query: string, num: number, offset = 0,
): Promise<Array<{ link: string; title: string; snippet: string }>> {
  if (!BRAVE_API_KEY) return [];
  try {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${num}&offset=${offset}&result_filter=web`;
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json', 'X-Subscription-Token': BRAVE_API_KEY },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.web?.results || []).map((r: any) => ({
      link: r.url || '', title: r.title || '', snippet: r.description || '',
    }));
  } catch (_) { return []; }
}

/** Search Bing Web Search API — requires BING_API_KEY env var */
async function searchBing(
  query: string, num: number, offset = 0,
): Promise<Array<{ link: string; title: string; snippet: string }>> {
  if (!BING_API_KEY) return [];
  try {
    const url = `https://api.bing.microsoft.com/v7.0/search?q=${encodeURIComponent(query)}&count=${num}&offset=${offset}&mkt=en-US`;
    const res = await fetch(url, {
      headers: { 'Ocp-Apim-Subscription-Key': BING_API_KEY },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.webPages?.value || []).map((r: any) => ({
      link: r.url || '', title: r.name || '', snippet: r.snippet || '',
    }));
  } catch (_) { return []; }
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
let groqLastError = '';

// Groq chat call with retry on 429 (rate limit) / 5xx. Returns parsed JSON content or null.
async function groqChat(body: Record<string, unknown>): Promise<string | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      groqCount++;
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + GROQ_API_KEY },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 429 || res.status >= 500) {
        groqLastError = `HTTP ${res.status}`;
        // Longer backoff on rate-limit — let the per-minute window reset
        await new Promise(r => setTimeout(r, 5000 * (attempt + 1)));
        continue;
      }
      if (!res.ok) {
        groqLastError = `HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`;
        return null;
      }
      const d = await res.json();
      return d?.choices?.[0]?.message?.content || '';
    } catch (e: any) {
      groqLastError = e?.message || 'fetch error';
      await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  return null;
}

// Uses title+snippet only (no page fetch needed) — fast pre-filter before we spend time
// fetching pages. Snippet is usually enough to classify betting affiliate vs operator vs irrelevant.
async function analyzeWithGroq(
  url: string, title: string, snippet: string, brand: string,
): Promise<Analysis | null> {
  const partnerBrand = brand === '1xcasino' ? '1xCasino'
                     : brand === 'luckypari' ? 'LuckyPari' : '1xBet';

  const sys = `You qualify websites as affiliate PARTNERS for ${partnerBrand} (sports betting brand).\n\n`
    + `We want AFFILIATE / PUBLISHER sites: tipsters, prediction sites, betting-tips blogs, `
    + `sports media, review/comparison sites, "best betting site" lists. We pitch them a partnership.\n`
    + `Return ONLY JSON:\n`
    + `{"score":0-100,"type":"review|tipster|media|aggregator|blog|other",`
    + `"summary":"1 sentence","why":"1 sentence — why fits or not",`
    + `"priority":"High|Medium|Low","lang":"language code",`
    + `"is_competitor":false,"relevant":true/false,"geo_excluded":true/false,"is_operator":true/false}\n\n`
    + `Scoring:\n`
    + `- 80-100: large/established affiliate or media site, clear betting/casino content, target GEO\n`
    + `- 60-79: solid affiliate site, partial fit or quality unclear\n`
    + `- 30-59: tangential, thin content, mixed signals\n`
    + `- 0-29: not iGaming, dead, irrelevant\n\n`
    + `IMPORTANT — sites that REVIEW or PROMOTE betting brands (1xBet, betway, bet9ja, melbet, 1win etc.) are PERFECT PARTNERS. Set is_competitor=false always.\n\n`
    + `OPERATORS (is_operator=true): the site IS itself a casino/sportsbook with deposits/withdrawals/login-to-bet (e.g. bet365.com, 1xbet.com). NOT partners.\n`
    + `PARTNERS (is_operator=false): sites that review, compare, predict, rank, or blog about betting. These are targets.\n\n`
    + `Set geo_excluded=true ONLY for: USA, UK, Western Europe, Ukraine, Brazil, Australia.\n`
    + `Set relevant=false ONLY if is_operator OR geo_excluded OR score<${MIN_SCORE}.`;

  const user = `URL: ${url}\nTitle: ${title}\nSnippet: ${snippet}`;

  try {
    // llama-3.1-8b-instant — far higher Groq free-tier rate limits than 70b-versatile,
    // and plenty accurate for a binary "is this a betting affiliate" qualification.
    const raw = await groqChat({
      model: 'llama-3.1-8b-instant',
      messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      temperature: 0.1,
      max_tokens: 300,
      response_format: { type: 'json_object' },
    });
    if (!raw) return null;
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
      // Promoting/mentioning betting brands (incl. 1xBet) is GOOD — is_competitor is NOT a reason to skip.
      // Only real operators (own deposit/withdrawal) and excluded geos are blocked.
      relevant:     !!ai.relevant && score >= MIN_SCORE && !is_operator && !geo_excluded,
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

  // Phase 2: high-value partner/advertise pages — fetched in PARALLEL (was sequential,
  // which could burn 50s+ per lead and starve the rest of the run).
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
  if (Date.now() < deadline) {
    const pages = await Promise.all(phase2.map(p => fetchPage(p).then(h => ({ page: p, html: h }))));
    for (const { page, html } of pages) {
      if (!html || html.length < 100) continue;
      scanContacts(html, page, acc, prio);
    }
    if (prio.v <= 1) return acc; // found advertising/partner email, stop
  }

  // Phase 3: generic contact / about pages (if still no contact at all) — also parallel
  if (!acc.email && !acc.telegram && !acc.whatsapp && Date.now() < deadline) {
    const phase3 = [
      origin + '/contact',
      origin + '/contact-us',
      origin + '/about',
      origin + '/about-us',
      origin + '/business',
      origin + '/collaborate',
    ];
    const pages = await Promise.all(phase3.map(p => fetchPage(p).then(h => ({ page: p, html: h }))));
    for (const { page, html } of pages) {
      if (!html || html.length < 100) continue;
      scanContacts(html, page, acc, prio);
    }
  }

  return acc;
}

function getDomain(url: string): string {
  try {
    return new URL(url.startsWith('http') ? url : 'https://' + url).hostname.replace(/^www\./, '');
  } catch { return ''; }
}
function decodeEntities(s: string): string {
  return s
    .replace(/&#x27;/gi, "'").replace(/&#39;/g, "'").replace(/&apos;/gi, "'")
    .replace(/&quot;/gi, '"').replace(/&#34;/g, '"')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ' '; } })
    .replace(/&#(\d+);/g,           (_, n) => { try { return String.fromCodePoint(parseInt(n, 10)); } catch { return ' '; } })
    .replace(/&amp;/gi, '&');
}
function nameFromTitle(title: string): string {
  const t = decodeEntities(title || '');
  return t.replace(/\s*[-|—·|\/]\s*.{0,60}$/, '').trim().slice(0, 80)
    || t.slice(0, 80) || 'Unknown';
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
  const stats = {
    brand: '', preset: '', keywords_run: 0,
    found: 0, analyzed: 0, irrelevant: 0, competitors: 0, geo_excluded: 0,
    saved: 0, contacts: 0, errors: [] as string[],
  };
  const startedAt = Date.now();
  const deadline  = startedAt + TIME_BUDGET_MS;

  try {
    // find-and-queue never pauses — finding new leads is always valuable

    // 2. Determine brand + preset — slot advances every 3 min (matches the find-and-queue
    //    cron) so each run picks a fresh set of keywords rather than re-searching the same ones.
    const slotIndex = Math.floor(Date.now() / (3 * 60 * 1000));
    // 1xcasino paused — hunt 1xBet affiliates only
    const BRANDS    = ['1xbet'] as const;
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

    // 4. Run ALL keyword searches in PARALLEL across DDG + Brave + Bing.
    //    DDG paginates through pages 1-5 (offset 0/30/60/90/120) to surface
    //    fresh sites beyond the exhausted first page.
    //    Brave & Bing are completely independent indexes — no dedup overlap with DDG.
    const DDG_OFFSET   = (slotIndex % 5) * 30;
    const BRAVE_OFFSET = (slotIndex % 10) * 10; // 10 results/page, cycle 10 pages
    const BING_OFFSET  = (slotIndex % 10) * 10;

    const serpBatches = await Promise.all(
      keywords.flatMap(kw => [
        searchDuckDuckGo(`${kw} ${DDG_MINUS}`, RESULTS_PER_KW, DDG_OFFSET)
          .then(r => { stats.keywords_run++; return r; })
          .catch(e => { stats.errors.push(`DDG "${kw}": ${e.message}`); return []; }),
        searchBrave(`${kw} ${DDG_MINUS}`, 10, BRAVE_OFFSET)
          .catch(() => [] as Array<{ link: string; title: string; snippet: string }>),
        searchBing(`${kw} ${DDG_MINUS}`, 10, BING_OFFSET)
          .catch(() => [] as Array<{ link: string; title: string; snippet: string }>),
      ]),
    );

    // Merge, dedup by domain across all keywords, and apply the cheap pre-filters now
    // so the expensive Groq+fetch loop only sees real candidates.
    const candidates: Array<{ url: string; title: string; snippet: string; origin: string }> = [];
    const seenThisRun = new Set<string>();
    for (const batch of serpBatches) {
      stats.found += batch.length;
      for (const result of batch) {
        const url    = result.link || '';
        const domain = getDomain(url);
        if (!domain || seenThisRun.has(domain)) continue;
        if (GLOBAL_SKIP.has(domain) || existingDomains.has(domain) || blacklistSet.has(domain)) continue;
        if (isNoisyResult(url, result.title || '', result.snippet || '')) { stats.irrelevant++; continue; }
        if (isExcludedByTld(domain)) { stats.geo_excluded++; continue; }
        let origin: string;
        try {
          origin = new URL(url.startsWith('http') ? url : 'https://' + url).origin;
        } catch { continue; }
        seenThisRun.add(domain);
        candidates.push({ url, title: result.title || '', snippet: result.snippet || '', origin });
      }
    }

    // Track time of last Groq call for inter-call pacing (avoids 429 rate-limit)
    let lastGroqCallMs = 0;

    for (const cand of candidates) {
      if (Date.now() > deadline) break;
      const { url, title, snippet, origin } = cand;
      const domain = getDomain(url);

      // 4a. Groq pre-filter using snippet+title ONLY (no page fetch yet — fast & cheap).
      //     Pace calls to ~27/min to stay under the Groq free-tier 30 req/min limit.
      const sinceLastGroq = Date.now() - lastGroqCallMs;
      if (sinceLastGroq < GROQ_PACE_MS) {
        await new Promise(r => setTimeout(r, GROQ_PACE_MS - sinceLastGroq));
      }
      if (Date.now() > deadline) break;
      lastGroqCallMs = Date.now();

      const analysis = await analyzeWithGroq(url, title, snippet, brand);

      // Groq MUST succeed — if it failed we skip the lead rather than risk adding
      // operators/competitors that Groq would have caught.
      if (!analysis) { stats.irrelevant++; continue; }

      stats.analyzed++;
      // Only block real operators (own casino/sportsbook). Sites promoting 1xBet/other brands are partners.
      if (analysis.is_operator)   { stats.competitors++; continue; }
      if (analysis.geo_excluded)  { stats.geo_excluded++; continue; }
      if (!analysis.relevant)     { stats.irrelevant++;   continue; }

      // 4b. Passed Groq — NOW fetch the homepage for contact extraction
      if (Date.now() > deadline) break;
      const homepageHtml = await fetchPage(url);

      // 4c. Extract contact details (multi-phase: homepage → partner pages → contact pages)
      let contact: Contact = { email: null, emailType: null, telegram: null, whatsapp: null, phone: null, sourceUrl: null };
      if (homepageHtml && homepageHtml.length > 200) {
        contact = await extractContact(url, origin, homepageHtml, deadline);
      }
      if (contact.email && emailedSet.has(contact.email.toLowerCase())) continue;

      // 4d. Build & insert the lead
      const leadData: Record<string, unknown> = {
        url,
        name:     nameFromTitle(title),
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

    // 5. Track API usage (DuckDuckGo is free/keyless — no counter needed)
    await Promise.all([
      bumpUsage('jina',  jinaCount),
      bumpUsage('groq',  groqCount),
    ]);

    await supabase.from('error_log').insert([{
      level: 'info', service: 'find-and-queue',
      message: `brand=${brand} preset="${preset.name}" kw=${stats.keywords_run} page=${DDG_OFFSET/30+1} engines=ddg${BRAVE_API_KEY?'+brave':''}${BING_API_KEY?'+bing':''} `
        + `found=${stats.found} analyzed=${stats.analyzed} `
        + `irrelevant=${stats.irrelevant} competitors=${stats.competitors} geo_excl=${stats.geo_excluded} `
        + `saved=${stats.saved} contacts=${stats.contacts} groqCalls=${groqCount}`
        + (groqLastError ? ` groqErr="${groqLastError}"` : '')
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
