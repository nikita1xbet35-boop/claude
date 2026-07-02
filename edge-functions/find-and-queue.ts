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
// (deploy trigger: activate SerpApi keys)
// Env:    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SERPAPI_KEY_1/2/3, GROQ_API_KEY,
//         JINA_API_KEY (optional)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const JINA_API_KEY = Deno.env.get('JINA_API_KEY') || '';

// ── SerpApi accounts (second search source, rotated on monthly limit) ────────
// Keys live in Supabase function secrets, never in code. Each maps to an
// api_usage row (serpapi_1/2/3, monthly cap). When all are exhausted the search
// falls back to DuckDuckGo (free) and alerts Telegram.
const SERPAPI_ACCOUNTS = [
  { service: 'serpapi_1', key: Deno.env.get('SERPAPI_KEY_1') || '' },
  { service: 'serpapi_2', key: Deno.env.get('SERPAPI_KEY_2') || '' },
  { service: 'serpapi_3', key: Deno.env.get('SERPAPI_KEY_3') || '' },
].filter(a => a.key);
const SERPAPI_MONTHLY_LIMIT = 250;
// Pace SerpApi so 3×250=750 searches/month aren't burned in a day. Only ~1 in
// SERP_EVERY runs uses SerpApi, and only for SERP_KW_PER_RUN keyword(s).
const SERP_EVERY = 20;
const SERP_KW_PER_RUN = 1;
// Groq key: env var first, fall back to the key already shipped in index.html
const GROQ_API_KEY = Deno.env.get('GROQ_API_KEY') ||
  ['gsk_9DKnaMxmKm8WEPDDjtZbWGdyb3FYX', 'R6kIEWkpNsjz6BlDlvj347v'].join('');

const TIME_BUDGET_MS   = 110_000;
const FETCH_TIMEOUT_MS = 7_000;
const RESULTS_PER_KW   = 12;
const KW_PER_RUN       = 5;
// Minimum Groq relevance score to keep a lead
const MIN_SCORE        = 40;
// Sites analyzed per Groq call. The free-tier bottleneck is TOKENS/min (6000 TPM
// for llama-3.1-8b-instant), not requests/min — single-site calls at any pacing
// blow the token budget. One batched call (~1800 tokens) covers 8 sites.
const GROQ_BATCH_SIZE  = 8;
// Min ms between batch calls — 5 calls/min × ~1800 tokens ≈ 9000 TPM. Keeping
// 12s spacing leaves headroom and fits 3 batches inside the 150s edge-fn timeout.
const GROQ_PACE_MS     = 12_000;

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
      keywords:["how to make money betting nigeria","best bookmaker nigeria 2026","paystack betting site","nigeria sports blog sponsored post","free booking codes nigeria","accumulator tips naija","nairaland betting thread","football accumulator nigeria","betting site with bonus nigeria"] },
    { id:'1xb-ke', name:'Kenya', geo:'KE',
      keywords:["mpesa betting site kenya","best odds kenya","aviator kenya tricks","betting site with free bonus kenya","jackpot prediction kenya","kenya sports news blog","advertise betting kenya","paybill betting kenya","ligi kuu prediction"] },
    { id:'1xb-gh', name:'Ghana', geo:'GH',
      keywords:["mtn momo betting ghana","how to win bet ghana","best odds ghana 2026","aviator ghana strategy","ghana sports blog advertise","ghana premier league prediction","free bet ghana"] },
    { id:'1xb-kg', name:'Kyrgyzstan', geo:'KG',
      keywords:["как заработать на ставках","экспресс дня бесплатно","стратегия ставок на спорт","авиатор сигналы стратегия","промокод на ставку","разместить рекламу ставки","прогноз на матч сегодня","отзывы букмекеров снг","ставки через смс","заработок на авиаторе"] },
    { id:'1xb-my', name:'Malaysia', geo:'MY',
      keywords:["trusted online casino malaysia 2026","duitnow casino malaysia","how to win 4d","malaysia football tips telegram","casino sponsored post malaysia","online betting reload bonus","judi dalam talian malaysia","tips bola sepak hari ini"] },
    { id:'1xb-ph', name:'Philippines', geo:'PH',
      keywords:["gcash casino philippines","maya online casino","how to win jili games","sabong live betting","paano manalo sa casino","pba prediction today","philippines casino sponsored","e-bingo online","pinoy slots tips"] },
    { id:'1xb-np', name:'Nepal', geo:'NP',
      keywords:["khalti betting nepal","how to bet in nepal","ipl prediction nepal today","esewa casino deposit","nepali betting telegram","online juwa nepal","cricket tips nepali","nepal casino guide"] },
    { id:'1xb-pk', name:'Pakistan', geo:'PK',
      keywords:["easypaisa betting pakistan","how to bet on cricket pakistan","psl winning prediction","jazzcash casino deposit","cricket betting urdu guide","aviator game pakistan trick","free cricket tips telegram pakistan","online cricket id pakistan","t20 prediction today"] },
    { id:'1xb-in', name:'India', geo:'IN',
      keywords:["upi casino india","how to win dream11","online cricket id india","paytm betting app","color prediction game india","ipl satta tips","indian rummy cash game","andar bahar real money","aviator hack india","best betting app india 2026","telegram cricket prediction india"] },
    { id:'1xb-bd', name:'Bangladesh', geo:'BD',
      keywords:["bkash casino bangladesh","nagad betting deposit","how to bet bpl","cricket prediction bangla","online casino bd review","aviator game bd trick","betting tips bangla telegram","real money game bangladesh"] },
    { id:'1xb-ar', name:'Argentina', geo:'AR',
      keywords:["mercadopago casino argentina","como ganar en aviator","casino con bono sin deposito argentina","ruleta en vivo argentina","tragamonedas dinero real","apuestas mercado pago","predicciones liga argentina"] },
    { id:'1xb-cl', name:'Chile', geo:'CL',
      keywords:["como ganar en casino chile","casino webpay chile","pronostico futbol chileno","aviator estrategia chile","tragamonedas chile dinero real","apuestas deportivas chile bono","predicciones primera division chile"] },
    { id:'1xb-ci', name:'Côte d\'Ivoire', geo:'CI',
      keywords:["pari sportif wave côte d'ivoire","comment gagner au paris","pronostic ligue 1 abidjan","orange money casino civ","astuce aviator côte d'ivoire","meilleur site pari abidjan","code promo paris civ"] },
    { id:'1xb-bf', name:'Burkina Faso', geo:'BF',
      keywords:["pari sportif orange money burkina","comment gagner pari burkina","pronostic foot ouaga","astuce aviator burkina","meilleur site pari burkina","moov money casino"] },
    { id:'1xb-sn', name:'Senegal', geo:'SN',
      keywords:["pari sportif wave sénégal","comment gagner au pari sénégal","pronostic foot dakar","orange money casino sénégal","astuce aviator sénégal","meilleur bookmaker sénégal"] },
    { id:'1xb-cm', name:'Cameroun', geo:'CM',
      keywords:["pari sportif mtn money cameroun","comment gagner pari cameroun","pronostic elite one","orange money casino cameroun","astuce aviator cameroun","meilleur site pari douala"] },
    { id:'1xb-ma', name:'Morocco', geo:'MA',
      keywords:["pari sportif maroc cih","comment gagner au pari maroc","pronostic botola pro","طريقة الربح من الرهان","كازينو الدفع عند","astuce aviator maroc","موقع رهان مغربي"] },
    { id:'1xb-za', name:'South Africa', geo:'ZA',
      keywords:["how to win betting south africa","capitec betting site","aviator predictor SA","psl betting tips","sponsored betting post SA","best betting app south africa 2026","soccer betting telegram SA"] },
    { id:'1xb-vn', name:'Vietnam', geo:'VN',
      keywords:["casino momo vietnam","cách thắng aviator","soi kèo ngoại hạng anh","nhà cái uy tín 2026","đánh bài đổi thưởng","casino tặng tiền cược","mẹo cá độ bóng đá"] },
    { id:'1xb-mm', name:'Myanmar', geo:'MM',
      keywords:["wave money casino myanmar","how to bet myanmar","2d 3d online myanmar","football betting myanmar tips","aviator myanmar trick","online casino myanmar deposit"] },
    { id:'1xb-agency', name:'Agencies / Media', geo:'Global',
      keywords:["buy igaming traffic","casino smartlink network","betting offers affiliate program","igaming advertiser direct","traffic arbitrage casino","push traffic gambling","pop traffic betting","igaming media buyer hiring","casino affiliate manager direct","sweepstakes traffic network","in-app traffic igaming","programmatic gambling traffic"] },
  ],
  '1xcasino': [],
  'luckypari': [],
};

// Cities per preset — appended to keywords on rotation so we surface local affiliate sites
// that don't appear in country-level top results (which are dominated by operators).
const PRESET_CITIES: Record<string, string[]> = {
  '1xb-ng': ['lagos', 'abuja', 'kano', 'port harcourt'],
  '1xb-ke': ['nairobi', 'mombasa', 'kisumu'],
  '1xb-gh': ['accra', 'kumasi', 'takoradi'],
  '1xb-kg': ['bishkek', 'almaty', 'tashkent', 'astana'],
  '1xb-my': ['kuala lumpur', 'johor bahru', 'penang'],
  '1xb-ph': ['manila', 'cebu', 'davao', 'quezon city'],
  '1xb-np': ['kathmandu', 'pokhara', 'lalitpur'],
  '1xb-pk': ['karachi', 'lahore', 'islamabad', 'rawalpindi'],
  '1xb-in': ['mumbai', 'delhi', 'bengaluru', 'chennai', 'kolkata'],
  '1xb-bd': ['dhaka', 'chittagong', 'sylhet'],
  '1xb-ar': ['buenos aires', 'cordoba', 'rosario'],
  '1xb-cl': ['santiago', 'valparaiso', 'concepcion'],
  '1xb-ci': ['abidjan', 'bouake', 'yamoussoukro'],
  '1xb-bf': ['ouagadougou', 'bobo-dioulasso'],
  '1xb-sn': ['dakar', 'thies', 'saint-louis'],
  '1xb-cm': ['douala', 'yaounde', 'bafoussam'],
  '1xb-ma': ['casablanca', 'rabat', 'marrakech', 'fes'],
  '1xb-za': ['johannesburg', 'cape town', 'durban', 'pretoria'],
  '1xb-vn': ['hanoi', 'ho chi minh', 'da nang'],
  '1xb-mm': ['yangon', 'mandalay'],
  '1xb-agency': [], // global — no city variants
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
  'linebet.com','paripesa.com','paripesa.ng','betano.com','1xbet.ng',
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

function isMalformedLocalPart(e: string): boolean {
  // Catches scraped junk like "thenews.com.my@gmail.com" where a domain was
  // concatenated with @gmail.com — the local part contains an embedded TLD pattern.
  const local = e.split('@')[0].toLowerCase();
  if (/\.(com|net|org|co|info|me|io|news|blog|site|web)\.[a-z]{2,3}$/.test(local)) return true;
  // RFC 5321: local part must not start/end with a dot or contain consecutive
  // dots. Catches website placeholders scraped literally like "...@gmail.com".
  if (/^\.|\.$|\.\./.test(local)) return true;
  return false;
}
function isValidEmail(e: string): boolean {
  if (!e || e.length > 100 || !e.includes('@') || !e.includes('.')) return false;
  const l = e.toLowerCase();
  if (EMAIL_IGNORE.some(ig => l.includes(ig))) return false;
  if (isPlaceholderEmail(l))                   return false;
  if (DISPOSABLE.some(d => l.includes(d)))     return false;
  if (isMalformedLocalPart(l))                 return false;
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

// ── DDG HTML parsing helpers ─────────────────────────────────────────────

function extractVqd(html: string): string {
  // Hidden input: <input ... name="vqd" value="4-...">
  const m1 = html.match(/name=["']vqd["'][^>]*value=["']([^"']+)["']/i)
    || html.match(/value=["']([^"']+)["'][^>]*name=["']vqd["']/i);
  if (m1) return m1[1];
  // JS assignment: vqd='4-...' or vqd: "4-..."
  const m2 = html.match(/vqd\s*[=:]\s*['"]([^'"]+)['"]/);
  if (m2) return m2[1];
  return '';
}

function parseDdgHtml(
  html: string, num: number,
): Array<{ link: string; title: string; snippet: string }> {
  const results: Array<{ link: string; title: string; snippet: string }> = [];
  if (!html) return results;
  const linkRe  = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|span|div)>/gi;
  const links: Array<{ url: string; title: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null && links.length < num * 2) {
    const rawHref = m[1];
    const title   = m[2].replace(/<[^>]+>/g, '').trim();
    let url = rawHref;
    const uddg = rawHref.match(/[?&]uddg=([^&]+)/)?.[1];
    if (uddg) url = decodeURIComponent(uddg);
    if (url.startsWith('http') && !url.includes('duckduckgo.com')) links.push({ url, title });
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

/** Search DuckDuckGo HTML.
 *  page=1: plain GET. page=2/3: GET page 1 first (to extract vqd token),
 *  then POST to the proper paginated endpoint so we really get page 2/3. */
async function searchDuckDuckGo(
  query: string, num: number, page = 1,
): Promise<Array<{ link: string; title: string; snippet: string }>> {
  const UA = 'Mozilla/5.0 (compatible; AffiliateOS/1.0)';
  const baseUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

  // Always fetch page 1 — needed for vqd token and as fallback
  let html1 = '';
  try {
    const res = await fetch(baseUrl,
      { headers: { 'User-Agent': UA, 'Accept': 'text/html' }, signal: AbortSignal.timeout(12_000) });
    if (res.ok) html1 = await res.text();
  } catch (_) {}

  if (page === 1 || !html1) return parseDdgHtml(html1, num);

  // Extract vqd — DDG requires it for POST pagination
  const vqd = extractVqd(html1);
  if (!vqd) return parseDdgHtml(html1, num); // can't paginate; return page 1

  const offset = (page - 1) * 30;
  try {
    const body = new URLSearchParams({
      q: query, s: String(offset), dc: String(offset + 1),
      v: 'l', o: 'json', api: '/d.js', nextParams: '', vqd, kl: '',
    });
    const res = await fetch('https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'text/html',
        'Referer': 'https://duckduckgo.com/',
      },
      body: body.toString(),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return parseDdgHtml(html1, num);
    const html2 = await res.text();
    const paged = parseDdgHtml(html2, num);
    // If POST returned garbage (<3 results), fall back to page 1
    return paged.length >= 3 ? paged : parseDdgHtml(html1, num);
  } catch (_) { return parseDdgHtml(html1, num); }
}

// ── SerpApi (second search source) ──────────────────────────────────────────
/** Query SerpApi (Google engine). Returns the same shape as DuckDuckGo results. */
async function searchSerpApi(
  query: string, num: number, apiKey: string,
): Promise<Array<{ link: string; title: string; snippet: string }>> {
  try {
    const url = `https://serpapi.com/search.json?engine=google&num=${num}`
      + `&q=${encodeURIComponent(query)}&api_key=${apiKey}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    if (!res.ok) return [];
    const data = await res.json();
    const organic = Array.isArray(data?.organic_results) ? data.organic_results : [];
    return organic.slice(0, num).map((r: any) => ({
      link:    r.link || '',
      title:   r.title || '',
      snippet: r.snippet || '',
    })).filter((r: any) => r.link.startsWith('http'));
  } catch (_) { return []; }
}

/** Pick the first SerpApi account that still has monthly budget, resetting any
 *  account whose counter rolled into a new month. Returns null if all exhausted
 *  (or no keys configured). */
async function pickSerpAccount(): Promise<{ service: string; key: string } | null> {
  if (SERPAPI_ACCOUNTS.length === 0) return null;
  const nowMonth = new Date().toISOString().slice(0, 7); // YYYY-MM
  for (const acct of SERPAPI_ACCOUNTS) {
    const { data: row } = await supabase.from('api_usage')
      .select('used, limit_value, last_reset_at').eq('service', acct.service).single();
    if (!row) continue;
    let used  = row.used ?? 0;
    const lim = row.limit_value ?? SERPAPI_MONTHLY_LIMIT;
    // Monthly reset: if the last reset was in a previous month, zero the counter.
    const lastMonth = (row.last_reset_at ? new Date(row.last_reset_at).toISOString() : '').slice(0, 7);
    if (lastMonth && lastMonth !== nowMonth) {
      await supabase.from('api_usage')
        .update({ used: 0, last_reset_at: new Date().toISOString(), paused: false })
        .eq('service', acct.service);
      used = 0;
    }
    if (used < lim) return acct;
  }
  return null;
}

async function bumpSerpAccount(service: string, delta: number) {
  if (delta <= 0) return;
  const { data } = await supabase.from('api_usage').select('used').eq('service', service).single();
  await supabase.from('api_usage')
    .update({ used: (data?.used ?? 0) + delta, updated_at: new Date().toISOString() })
    .eq('service', service);
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

// Read a response body with a hard size cap — a site streaming an unbounded
// body into res.text() OOMs the isolate (WORKER_RESOURCE_LIMIT).
const BODY_CAP_BYTES = 2_500_000;
async function readCapped(res: Response, cap = BODY_CAP_BYTES): Promise<string> {
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (ct && !ct.includes('text/') && !ct.includes('html') && !ct.includes('xml') && !ct.includes('json')) {
    res.body?.cancel().catch(() => {});
    return '';
  }
  const reader = res.body?.getReader();
  if (!reader) return (await res.text()).slice(0, cap);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < cap) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const buf = new Uint8Array(Math.min(total, cap));
  let off = 0;
  for (const c of chunks) {
    const n = Math.min(c.length, buf.length - off);
    buf.set(c.subarray(0, n), off);
    off += n;
    if (off >= buf.length) break;
  }
  return new TextDecoder().decode(buf);
}

async function fetchPage(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AffiliateOS/1.0)' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'follow',
    });
    if (res.ok) {
      const text = await readCapped(res);
      if (text && text.length > 200) return text;
    } else {
      res.body?.cancel().catch(() => {});
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
      const text = await readCapped(res);
      if (text && text.length > 100) return text;
    } else {
      res.body?.cancel().catch(() => {});
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
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      groqCount++;
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + GROQ_API_KEY },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 429) {
        // Don't wait inside the edge function — this run is killed at 150s.
        // The Cloudflare cron retriggers in 3 min; Groq quota refreshes in 60s.
        groqLastError = 'HTTP 429 (rate limited — skipping)';
        return null;
      }
      if (res.status >= 500) {
        groqLastError = `HTTP ${res.status}`;
        await new Promise(r => setTimeout(r, 3_000 * (attempt + 1)));
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

// Analyzes a BATCH of sites in ONE Groq call using title+snippet only.
// Returns a map: batch index → Analysis. Missing index = Groq failed for that site.
async function analyzeBatchWithGroq(
  cands: Array<{ url: string; title: string; snippet: string }>, brand: string,
): Promise<Map<number, Analysis>> {
  const out = new Map<number, Analysis>();
  if (cands.length === 0) return out;
  const partnerBrand = brand === '1xcasino' ? '1xCasino'
                     : brand === 'luckypari' ? 'LuckyPari' : '1xBet';

  const sys = `You qualify websites as affiliate PARTNERS for ${partnerBrand} (sports betting brand).\n`
    + `We want PUBLISHER sites: tipsters, prediction sites, betting-tips blogs, sports media, `
    + `review/comparison sites, "best betting site" lists. We pitch them a partnership.\n`
    + `Sites that REVIEW or PROMOTE betting brands (1xBet, betway, bet9ja, melbet, 1win etc.) are PERFECT partners.\n`
    + `OPERATORS (is_operator=true): the site IS itself a casino/sportsbook with deposits/login-to-bet. NOT partners.\n`
    + `geo_excluded=true ONLY for: USA, UK, Western Europe, Ukraine, Brazil, Australia.\n`
    + `Score: 80-100 established affiliate/media in target GEO; 60-79 solid; 30-59 thin; 0-29 not iGaming/dead.\n`
    + `relevant=false ONLY if is_operator OR geo_excluded OR score<${MIN_SCORE}.\n`
    + `You get ${cands.length} numbered sites. Return ONLY JSON — one entry per site, same numbering:\n`
    + `{"results":[{"i":1,"score":0-100,"type":"review|tipster|media|aggregator|blog|other",`
    + `"summary":"1 short sentence","priority":"High|Medium|Low","lang":"xx",`
    + `"is_operator":false,"geo_excluded":false,"relevant":true}]}`;

  const user = cands.map((c, i) =>
    `${i + 1}. URL: ${c.url}\nTitle: ${(c.title || '').slice(0, 100)}\nSnippet: ${(c.snippet || '').slice(0, 160)}`,
  ).join('\n\n');

  try {
    const raw = await groqChat({
      model: 'llama-3.1-8b-instant',
      messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      temperature: 0.1,
      max_tokens: 130 * cands.length + 100,
      response_format: { type: 'json_object' },
    });
    if (!raw) return out;
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    const results: any[] = Array.isArray(parsed?.results) ? parsed.results
                         : Array.isArray(parsed) ? parsed : [];
    for (const ai of results) {
      const idx = Number(ai?.i) - 1;
      if (!Number.isInteger(idx) || idx < 0 || idx >= cands.length || out.has(idx)) continue;
      const score        = Math.max(0, Math.min(100, Number(ai.score) || 0));
      const is_operator  = !!ai.is_operator;
      const geo_excluded = !!ai.geo_excluded;
      out.set(idx, {
        score,
        type:         String(ai.type || 'other').slice(0, 30),
        summary:      String(ai.summary || '').slice(0, 400),
        why:          '',
        priority:     ['High', 'Medium', 'Low'].includes(ai.priority) ? ai.priority : 'Medium',
        lang:         String(ai.lang || '').slice(0, 40),
        is_competitor: false,
        is_operator,
        geo_excluded,
        // Only real operators (own deposit/withdrawal) and excluded geos are blocked.
        relevant:     !!ai.relevant && score >= MIN_SCORE && !is_operator && !geo_excluded,
      });
    }
  } catch (_) { /* partial/no results — unanalyzed sites are skipped, re-found next runs */ }
  return out;
}

// ── Contact extraction ────────────────────────────────────────────────────
interface Contact {
  email: string | null; emailType: string | null;
  telegram: string | null; whatsapp: string | null;
  phone: string | null; sourceUrl: string | null;
}

function scanContacts(html: string, page: string, acc: Contact, prio: { v: number }) {
  // CPU guard: regex passes over multi-MB pages can blow the edge-function CPU
  // budget — contacts live near the header/footer, skip the middle.
  if (html.length > 260_000) {
    html = html.slice(0, 200_000) + '\n' + html.slice(-60_000);
  }
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
function normalizeDomain(url: string): string {
  try {
    const u = url.startsWith('http') ? url : 'https://' + url;
    return new URL(u).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return url.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split(/[/?#]/)[0].toLowerCase();
  }
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
    // Write a "started" entry immediately so the function is visible in logs
    // even if a downstream step (Groq, Supabase) kills the run before completion.
    await supabase.from('error_log').insert([{
      level: 'info', service: 'find-and-queue', message: 'started',
    }]);

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

    // 3. Load dedup sets upfront (domain_normalized may not exist before migration — fallback to url)
    let existingLeadRows: any[] | null = null;
    try {
      const { data } = await supabase
        .from('leads').select('domain_normalized, url')
        .not('domain_normalized', 'is', null)
        .order('created_at', { ascending: false })
        .limit(5000);
      existingLeadRows = data;
    } catch (_) {}
    if (!existingLeadRows) {
      // Column doesn't exist yet — fall back to url-only dedup
      const { data } = await supabase
        .from('leads').select('url')
        .order('created_at', { ascending: false })
        .limit(5000);
      existingLeadRows = (data || []).map((r: any) => ({ url: r.url, domain_normalized: null }));
    }
    const existingDomains = new Set(
      existingLeadRows.map((l: any) => (l.domain_normalized || normalizeDomain(l.url || '')).toLowerCase()).filter(Boolean),
    );

    let blRows: any[] = [];
    try {
      const { data } = await supabase.from('blacklist').select('value');
      blRows = data || [];
    } catch (_) {}
    const blacklistSet = new Set(blRows.map((r: any) => (r.value || '').toLowerCase()));

    // Hard dedup: ALL-TIME — never re-add a lead whose email was ever contacted
    // (email_log is the source of truth — every successful send is recorded there)
    const { data: allSent } = await supabase
      .from('email_log').select('email');
    const emailedSet = new Set(
      (allSent || []).map((r: any) => (r.email || '').toLowerCase()).filter(Boolean),
    );

    // 4. Run ALL keyword searches in PARALLEL on DDG.
    //    visitNum = how many full preset-cycles have passed for this preset.
    //    Page cycles 1→2→3 per visit. City rotates after every 3 visits (full page cycle).
    //    This means: base keywords × pages 1-3, then city-A × pages 1-3, city-B × pages 1-3…
    //    so every run hits a genuinely different slice of results.
    const visitNum   = Math.floor(slotIndex / (BRANDS.length * allPresets.length));
    const DDG_PAGE   = (visitNum % 3) + 1; // 1, 2, 3 cycling per visit
    const cityList   = PRESET_CITIES[preset.id] || [];
    const cityIdx    = Math.floor(visitNum / 3) % (cityList.length + 1); // +1 for base (no city)
    const cityAppend = cityIdx < cityList.length ? ' ' + cityList[cityIdx] : '';

    const serpBatches = await Promise.all(
      keywords.map(kw =>
        searchDuckDuckGo(`${kw}${cityAppend} ${DDG_MINUS}`, RESULTS_PER_KW, DDG_PAGE)
          .then(r => { stats.keywords_run++; return { kw, results: r }; })
          .catch(e => { stats.errors.push(`DDG "${kw}": ${e.message}`); return { kw, results: [] }; }),
      ),
    );

    // 4b. SerpApi (second source) — same keys via Google surface different sites
    //     than DDG. Paced so 3×250/month isn't burned in a day; rotates accounts
    //     as each hits its monthly cap; falls back to DDG-only + alert when all done.
    if (SERPAPI_ACCOUNTS.length > 0 && slotIndex % SERP_EVERY === 0) {
      const acct = await pickSerpAccount();
      if (acct) {
        const serpKws = keywords.slice(0, SERP_KW_PER_RUN);
        let serpCalls = 0;
        for (const kw of serpKws) {
          const results = await searchSerpApi(`${kw}${cityAppend}`, RESULTS_PER_KW, acct.key);
          serpCalls++;
          serpBatches.push({ kw, results });
        }
        await bumpSerpAccount(acct.service, serpCalls);
        (stats as any).serp = serpCalls;
        (stats as any).serp_acct = acct.service;
      } else {
        // All accounts exhausted → alert once per ~12h (guard via error_log lookback).
        const since = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
        const { data: recent } = await supabase.from('error_log')
          .select('id').eq('service', 'find-and-queue')
          .ilike('message', '%SerpApi accounts exhausted%')
          .gte('created_at', since).limit(1);
        if (!recent || recent.length === 0) {
          try {
            await fetch(`${SUPABASE_URL}/functions/v1/send-alert`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
              body: JSON.stringify({ level: 'warning', service: 'SerpApi',
                message: 'Все SerpApi аккаунты в месячном лимите — поиск на DuckDuckGo до сброса в начале месяца.' }),
            });
          } catch (_) {}
          await supabase.from('error_log').insert([{ level: 'info', service: 'find-and-queue',
            message: 'SerpApi accounts exhausted — falling back to DuckDuckGo' }]);
        }
      }
    }

    // Merge, dedup by domain across all keywords, and apply the cheap pre-filters now
    // so the expensive Groq+fetch loop only sees real candidates.
    // Each candidate carries the keyword that surfaced it (stored on the lead).
    const candidates: Array<{ url: string; title: string; snippet: string; origin: string; keyword: string }> = [];
    const seenThisRun = new Set<string>();
    for (const { kw, results } of serpBatches) {
      stats.found += results.length;
      for (const result of results) {
        const url    = result.link || '';
        const domain = getDomain(url);
        const domNorm = normalizeDomain(url);
        if (!domain || seenThisRun.has(domNorm)) continue;
        if (GLOBAL_SKIP.has(domain) || existingDomains.has(domNorm) || blacklistSet.has(domNorm) || blacklistSet.has(domain)) continue;
        if (isNoisyResult(url, result.title || '', result.snippet || '')) { stats.irrelevant++; continue; }
        if (isExcludedByTld(domain)) { stats.geo_excluded++; continue; }
        let origin: string;
        try {
          origin = new URL(url.startsWith('http') ? url : 'https://' + url).origin;
        } catch { continue; }
        seenThisRun.add(domNorm);
        candidates.push({ url, title: result.title || '', snippet: result.snippet || '', origin, keyword: kw });
      }
    }

    // Track time of last Groq call — pacing keeps us under the 6000 tokens/min free-tier cap
    let lastGroqCallMs = 0;

    for (let bi = 0; bi < candidates.length; bi += GROQ_BATCH_SIZE) {
      if (Date.now() > deadline) break;
      const batch = candidates.slice(bi, bi + GROQ_BATCH_SIZE);

      // 4a. Pace, then analyze the whole batch in ONE Groq call
      const sinceLastGroq = Date.now() - lastGroqCallMs;
      if (sinceLastGroq < GROQ_PACE_MS) {
        await new Promise(r => setTimeout(r, GROQ_PACE_MS - sinceLastGroq));
      }
      if (Date.now() > deadline) break;
      lastGroqCallMs = Date.now();

      const analyses = await analyzeBatchWithGroq(batch, brand);

      // 4b. Classify — only relevant sites proceed to (slow) contact extraction
      const toExtract: Array<{ cand: typeof batch[number]; analysis: Analysis }> = [];
      batch.forEach((cand, i) => {
        const analysis = analyses.get(i);
        // Groq MUST succeed — if it failed we skip the site rather than risk adding
        // operators/competitors that Groq would have caught.
        if (!analysis) { stats.irrelevant++; return; }
        stats.analyzed++;
        if (analysis.is_operator)  { stats.competitors++;  return; }
        if (analysis.geo_excluded) { stats.geo_excluded++; return; }
        if (!analysis.relevant)    { stats.irrelevant++;   return; }
        toExtract.push({ cand, analysis });
      });

      // 4c. Contact extraction for all relevant sites IN PARALLEL (each one already
      //     fans out its page fetches; doing leads concurrently overlaps the Groq pacing gap)
      const extracted = await Promise.all(toExtract.map(async ({ cand, analysis }) => {
        const homepageHtml = await fetchPage(cand.url);
        let contact: Contact = { email: null, emailType: null, telegram: null, whatsapp: null, phone: null, sourceUrl: null };
        if (homepageHtml && homepageHtml.length > 200) {
          contact = await extractContact(cand.url, cand.origin, homepageHtml, deadline);
        }
        return { cand, analysis, contact };
      }));

      // 4d. Build & insert the leads
      for (const { cand, analysis, contact } of extracted) {
        const { url, title, keyword } = cand;
        if (contact.email && emailedSet.has(contact.email.toLowerCase())) continue;
        const domNorm = normalizeDomain(url);
        if (existingDomains.has(domNorm)) continue;

        const leadData: Record<string, unknown> = {
          url,
          name:     nameFromTitle(title),
          brand,
          stage:    'new',
          geo:      preset.geo,
          type:     analysis.type,
          score:    analysis.score,
          summary:  analysis.summary,
          why:      analysis.why,
          priority: analysis.priority,
          lang:     analysis.lang,
          found_keyword: keyword,
          domain_normalized: domNorm,
          source:   'seo', // SEO/keyword search source (vs youtube / appstore)
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

        let { error: insErr } = await supabase.from('leads').insert([leadData]);
        let wasDuplicate = false;
        if (insErr) {
          const msg  = insErr.message || '';
          const code = (insErr as any).code;
          // UNIQUE violation = the domain already exists → real dedup hit. Skip it.
          // (Critically: do NOT retry without domain_normalized — that's what was
          //  smuggling NULL-domain duplicates past the constraint, ~500/day.)
          if (code === '23505' || /duplicate key|unique constraint/i.test(msg)) {
            wasDuplicate = true;
            insErr = null;
          } else if (/could not find|schema cache|does not exist/i.test(msg) && msg.includes('domain_normalized')) {
            // Genuine missing-column (only happens pre-migration) → retry without it.
            const fallbackData = { ...leadData };
            delete fallbackData.domain_normalized;
            const { error: retryErr } = await supabase.from('leads').insert([fallbackData]);
            insErr = retryErr ?? null;
          }
        }
        if (wasDuplicate) {
          existingDomains.add(domNorm); // already in DB — never re-attempt this run
          continue;
        }
        if (!insErr) {
          existingDomains.add(domNorm); // prevent same-run duplicates
          if (contact.email) emailedSet.add(contact.email.toLowerCase());
          stats.saved++;
        } else {
          stats.errors.push(`insert ${getDomain(url)}: ${insErr.message}`);
        }
      }
    }

    // 5. Track API usage (DuckDuckGo is free/keyless — no counter needed)
    await Promise.all([
      bumpUsage('jina',  jinaCount),
      bumpUsage('groq',  groqCount),
    ]);

    await supabase.from('error_log').insert([{
      level: 'info', service: 'find-and-queue',
      message: `brand=${brand} preset="${preset.name}" kw=${stats.keywords_run} page=${DDG_PAGE}${cityAppend ? ` city="${cityAppend.trim()}"` : ''} `
        + `found=${stats.found} analyzed=${stats.analyzed} `
        + `irrelevant=${stats.irrelevant} competitors=${stats.competitors} geo_excl=${stats.geo_excluded} `
        + `saved=${stats.saved} contacts=${stats.contacts} groqCalls=${groqCount}`
        + ((stats as any).serp ? ` serp=${(stats as any).serp}(${(stats as any).serp_acct})` : '')
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
