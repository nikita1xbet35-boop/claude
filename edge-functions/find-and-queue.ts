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
// (deploy trigger: activate SerpApi + Groq rotation keys)
// Env:    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SERPAPI_KEY_1/2/3,
//         GROQ_API_KEY + GROQ_KEY_2/GROQ_KEY_3 (rotated),
//         JINA_API_KEY (optional)

import { createClient } from 'npm:@supabase/supabase-js@2';

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
// Pace SerpApi so 3×250=750 searches/month aren't burned in a day. v6 fires it on
// two fixed slots per 40 (see the serpFire logic below) ≈ 24 calls/day, and only
// for SERP_KW_PER_RUN keyword(s) each time.
const SERP_KW_PER_RUN = 1;
// Groq keys — rotated per call to multiply the free-tier TPM budget. Key #1 is
// the env var (with the legacy hardcoded fallback); keys #2/#3 come from secrets
// GROQ_KEY_2 / GROQ_KEY_3. On a 429 the call retries on the next key rather than
// skipping analysis, which is what capped how many found sites got saved.
const GROQ_KEYS = [
  Deno.env.get('GROQ_API_KEY') ||
    ['gsk_9DKnaMxmKm8WEPDDjtZbWGdyb3FYX', 'R6kIEWkpNsjz6BlDlvj347v'].join(''),
  Deno.env.get('GROQ_KEY_2') || '',
  Deno.env.get('GROQ_KEY_3') || '',
].filter(Boolean);

const TIME_BUDGET_MS   = 110_000;
const FETCH_TIMEOUT_MS = 7_000;
const RESULTS_PER_KW   = 12;
const KW_PER_RUN       = 5;
// Baseline content-quality floor. Lowered from 40 in v6 because monetisation
// signals (promotes a competitor / has a partnership path) now override it — the
// score alone was rejecting thin-but-warm affiliates.
const MIN_SCORE        = 35;
// Sites analyzed per Groq call. The free-tier bottleneck is TOKENS/min (6000 TPM
// for llama-3.1-8b-instant), not requests/min — single-site calls at any pacing
// blow the token budget. One batched call (~1800 tokens) covers 8 sites.
const GROQ_BATCH_SIZE  = 8;
// Min ms between batch calls — 5 calls/min × ~1800 tokens ≈ 9000 TPM. Keeping
// 12s spacing leaves headroom and fits 3 batches inside the 150s edge-fn timeout.
const GROQ_PACE_MS     = 12_000;

// Minus-words appended to every search query to cut noise.
// Deliberately NOT excluded: prediction, tips, bonus, promo code, review,
// "betting sites" — those phrases mark our targets, not junk.
const DDG_MINUS = '-forum -reddit -wikipedia -score -livescore -results -fixtures -login -apk'
  + ' -stream -streaming -highlights -watch -download'
  + ' -jobs -vacancy -recruitment -salary'
  + ' -quora -facebook -twitter -tiktok -youtube'
  + ' -"terms and conditions" -"privacy policy"'
  + ' -lyrics -movie -song';
// Layer B hunts for ad inventory, so agencies SELLING marketing services are noise.
const LAYER_B_MINUS = ' -"marketing agency" -"seo services" -"web design"';

// Pre-filter: drop results whose title/snippet/URL contain these strings (catches what DDG misses).
// v6.1: added wrong-target categories that were slipping through and getting emailed —
// banks / payment providers, academic & research sites, government, and pure news wires.
// We do NOT want to pitch a partnership to a bank or a university.
const RESULT_NOISE_TERMS = [
  'forum','reddit','wikipedia','livescore','flashscore','sofascore','results','fixtures',
  'how to play','rules of ','login','sign up','download','apk','app store','google play',
  // financial institutions / payment rails — not affiliate partners
  'bank','banque','banco','microfinance','sacco','insurance','loan','mortgage','fintech',
  // academic / research / reference
  'mdpi.com','sciencedirect','researchgate','.edu','cairn.info','ssrn','jstor','academia.edu',
  'journal of','university','université','faculty','thesis','dissertation','scholar',
  // government / NGO / official bodies
  '.gov','.gouv','.go.ke','.go.tz','.go.ug','ministry','commission','regulatory','gazette',
  // law firms
  'law firm','avocat','attorney','lawyer','legal services','solicitor',
];
function domainNoise(url: string): boolean {
  const h = url.toLowerCase();
  return h.endsWith('.gov') || h.includes('.gov.') || h.endsWith('.edu') || h.includes('.edu.')
      || h.includes('.gouv.') || h.includes('.go.ke') || h.includes('.go.tz') || h.includes('.go.ug');
}
function isNoisyResult(url: string, title: string, snippet: string): boolean {
  if (domainNoise(url)) return true;
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

// Africa-focus week — keyword presets narrowed to African GEOs.
const DEFAULT_PRESETS: Record<string, Preset[]> = {
  '1xbet': [
    { id:'1xb-ng', name:'Nigeria', geo:'NG',
      keywords:["opay betting nigeria","how to cash out bet naija","naira betting bonus","super eagles betting preview","moniepoint betting deposit","aviator cash out trick nigeria","npfl betting odds","palmpay betting site","weekend accumulator naija","how to withdraw betting winnings nigeria"] },
    { id:'1xb-ke', name:'Kenya', geo:'KE',
      keywords:["mpesa deposit betting kenya","harambee stars betting","how to win aviator kenya","kplc betting jackpot","mpesa withdrawal betting","kenya premier league odds","safaricom betting deposit","midweek jackpot prediction","aviator cash out kenya","betting bonus kenya today"] },
    { id:'1xb-gh', name:'Ghana', geo:'GH',
      keywords:["mtn momo betting ghana","black stars betting preview","how to win aviator ghana","ghana premier league odds","telecel cash betting","vodafone cash betting ghana","weekend jackpot ghana","betting bonus ghana today","aviator prediction ghana"] },
    { id:'1xb-tz', name:'Tanzania', geo:'TZ',
      keywords:["mpesa tigo betting tanzania","jinsi ya kushinda kubet","tanzania premier league betting","azam fc betting","kamusi ya kubet","aviator tanzania mbinu","tigopesa betting deposit","ligi kuu bara odds"] },
    { id:'1xb-ug', name:'Uganda', geo:'UG',
      keywords:["mtn momo betting uganda","uganda cranes betting","how to win aviator uganda","airtel money betting uganda","upl betting odds","jackpot prediction uganda","betpawa alternative uganda"] },
    { id:'1xb-cm', name:'Cameroun', geo:'CM',
      keywords:["om mobile money paris cameroun","comment gagner aviator cameroun","pronostic elite one","mtn momo paris cameroun","lions indomptables paris","orange money pari cameroun","astuce cash out cameroun"] },
    { id:'1xb-ci', name:'Côte d\'Ivoire', geo:'CI',
      keywords:["wave paris sportif civ","comment retirer gain 1x","pronostic ligue 1 ivoirienne","orange money pari abidjan","elephants paris preview","moov money paris civ","astuce aviator abidjan"] },
    { id:'1xb-sn', name:'Senegal', geo:'SN',
      keywords:["wave paris senegal","comment gagner au pari senegal","lions teranga pari","orange money pari dakar","free money pari senegal","ligue 1 senegalaise cotes","astuce aviator dakar"] },
    { id:'1xb-bf', name:'Burkina Faso', geo:'BF',
      keywords:["orange money pari burkina","comment gagner pari ouaga","etalons pari preview","moov money pari burkina","coupon pari burkina","astuce aviator ouaga"] },
    { id:'1xb-zm', name:'Zambia', geo:'ZM',
      keywords:["airtel money betting zambia","chipolopolo betting","how to win aviator zambia","mtn momo betting zambia","zambia super league odds","jackpot prediction zambia"] },
    { id:'1xb-cd', name:'DR Congo', geo:'CD',
      keywords:["mpesa airtel pari rdc","comment gagner pari kinshasa","leopards pari preview","orange money pari rdc","ligue 1 rdc cotes","astuce aviator kinshasa"] },
    { id:'1xb-et', name:'Ethiopia', geo:'ET',
      keywords:["telebirr betting ethiopia","how to win aviator ethiopia","ethiopia premier league odds","cbe birr betting deposit","jackpot prediction ethiopia","ethiopia betting bonus"] },
    { id:'1xb-mz', name:'Mozambique', geo:'MZ',
      keywords:["mpesa aposta mocambique","como ganhar aviator mocambique","mocambola apostas","emola aposta deposito","palancas apostas","dicas apostas mocambique"] },
    { id:'1xb-ml', name:'Mali', geo:'ML',
      keywords:["orange money pari mali","comment gagner pari bamako","aigles pari preview","moov money pari mali","astuce aviator bamako"] },
    { id:'1xb-agency', name:'Africa / Agencies', geo:'Global',
      keywords:["africa betting traffic revshare","igaming africa media buyer","aviator africa signals","mobile money betting africa","afcon betting preview","african football prediction site","sports betting affiliate africa","casino traffic west africa"] },
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
  '1xb-tz': ['dar es salaam', 'dodoma', 'mwanza'],
  '1xb-ug': ['kampala', 'entebbe', 'gulu'],
  '1xb-cm': ['douala', 'yaounde', 'bafoussam'],
  '1xb-ci': ['abidjan', 'bouake', 'yamoussoukro'],
  '1xb-sn': ['dakar', 'thies', 'saint-louis'],
  '1xb-bf': ['ouagadougou', 'bobo-dioulasso'],
  '1xb-zm': ['lusaka', 'kitwe', 'ndola'],
  '1xb-cd': ['kinshasa', 'lubumbashi', 'goma'],
  '1xb-et': ['addis ababa', 'dire dawa', 'adama'],
  '1xb-mz': ['maputo', 'beira', 'nampula'],
  '1xb-ml': ['bamako', 'sikasso'],
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
// Real browser User-Agents. The old UA — "Mozilla/5.0 (compatible; AffiliateOS/1.0)"
// — is a blatant bot signature; once the request rate spiked, DuckDuckGo flagged it
// and that string makes it trivial to keep flagged. Rotating realistic browser UAs
// (varied per query so it doesn't look like one client) is far less block-prone.
// Eighteen current desktop and mobile UAs. The point is not volume of variety —
// it is that ONE run looks like ONE browser (see makeSession below). Rotating the
// UA per request inside a run is its own tell: a real client does not change
// browser between two searches a few seconds apart.
const BROWSER_UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0',
  'Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.0.0 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; SM-A536B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
];
const ACCEPT_LANGS = [
  'en-US,en;q=0.9',
  'en-GB,en;q=0.9',
  'en-US,en;q=0.9,fr;q=0.8',
  'en-US,en;q=0.8',
];

/** One coherent browser identity for the whole run, plus a per-query vqd cache.
 *
 *  The ban that killed the feed for two days was not caused by request VOLUME —
 *  it was the machine signature: a fixed interval, a constant UA, no session
 *  continuity, and five simultaneous requests. This models a single visitor
 *  instead: same UA and headers throughout, and the vqd token fetched once per
 *  query and reused for that query's pagination. */
interface DdgSession {
  ua: string;
  acceptLang: string;
  vqd: Map<string, string>;
  requests: number;
  emptyResponses: number;
  resultsTotal: number;
}

function makeSession(): DdgSession {
  return {
    ua: BROWSER_UAS[Math.floor(Math.random() * BROWSER_UAS.length)],
    acceptLang: ACCEPT_LANGS[Math.floor(Math.random() * ACCEPT_LANGS.length)],
    vqd: new Map(),
    requests: 0,
    emptyResponses: 0,
    resultsTotal: 0,
  };
}

const ddgHeaders = (s: DdgSession) => ({
  'User-Agent': s.ua,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': s.acceptLang,
  'Accept-Encoding': 'gzip, deflate, br',
  'Referer': 'https://duckduckgo.com/',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'same-origin',
});

/** Random pause between requests. A constant gap is the single most obvious
 *  bot tell there is; jitter costs nothing and removes it. */
const jitter = (minMs = 2000, maxMs = 6000) =>
  new Promise(r => setTimeout(r, minMs + Math.floor(Math.random() * (maxMs - minMs))));

async function searchDuckDuckGo(
  query: string, num: number, page = 1, session?: DdgSession,
): Promise<Array<{ link: string; title: string; snippet: string }>> {
  const s = session || makeSession();
  const baseUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

  // Health is measured per SEARCH, not per HTTP request. Deep pages need an
  // extra round trip purely to mint a vqd token, and that fetch yields no
  // results of its own — counting it would halve the average on every page-2/3
  // run and trip the throttle on perfectly healthy output.
  s.requests++;
  const record = (r: Array<{ link: string; title: string; snippet: string }>) => {
    s.resultsTotal += r.length;
    if (!r.length) s.emptyResponses++;
    return r;
  };

  // Page 1 is needed for the vqd token and as the fallback, but only fetch it
  // when the token for this query is not already in hand.
  let html1 = '';
  let vqd = s.vqd.get(query) || '';
  if (page === 1 || !vqd) {
    try {
      const res = await fetch(baseUrl, {
        headers: ddgHeaders(s),
        signal: AbortSignal.timeout(12_000),
      });
      if (res.ok) html1 = await res.text();
      else res.body?.cancel().catch(() => {});
    } catch (_) { /* fall through to the empty parse */ }

    if (html1 && !vqd) {
      vqd = extractVqd(html1);
      if (vqd) s.vqd.set(query, vqd);
    }
  }

  if (page === 1 || !vqd) return record(parseDdgHtml(html1, num));

  const offset = (page - 1) * 30;
  try {
    const body = new URLSearchParams({
      q: query, s: String(offset), dc: String(offset + 1),
      v: 'l', o: 'json', api: '/d.js', nextParams: '', vqd, kl: '',
    });
    const res = await fetch('https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers: {
        ...ddgHeaders(s),
        'Content-Type': 'application/x-www-form-urlencoded',
        'Sec-Fetch-Site': 'same-origin',
      },
      body: body.toString(),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) {
      res.body?.cancel().catch(() => {});
      return record(parseDdgHtml(html1, num));
    }
    const paged = parseDdgHtml(await res.text(), num);
    // A rejected POST returns a near-empty page — fall back to page 1 rather
    // than reporting the query as barren.
    return record(paged.length >= 3 ? paged : parseDdgHtml(html1, num));
  } catch (_) {
    return record(parseDdgHtml(html1, num));
  }
}

// ── DataForSEO SERP (layers B and C) ───────────────────────────────────────
// Google indexes corporate pages (/advertise, media kits) and exact quoted
// footprints ("affiliate disclosure") far better than DuckDuckGo does, and those
// are precisely what layers B and C hunt. depth:100 also returns eight times
// what a DDG page does, with no IP bans to manage.
//
// OFF BY DEFAULT, and deliberately so. SERP endpoints are priced differently
// from backlinks — live mode costs more than task_post/task_get, and the exact
// figure has to be read off DataForSEO's own docs before anything runs at scale.
// Turning per-search spending on for an account without confirming that price
// first is how a balance disappears in an afternoon. Arm with DFS_SERP_ENABLED=true
// once the tariff is known, and watch dfs_usage for the first few runs.
const DFS_SERP_ENABLED = (Deno.env.get('DFS_SERP_ENABLED') || '').toLowerCase() === 'true';
const DFS_LOGIN    = Deno.env.get('DFS_LOGIN') || '';
const DFS_PASSWORD = Deno.env.get('DFS_PASSWORD') || '';
// Hard per-run cap, so a misconfiguration cannot turn into an unbounded bill.
const DFS_SERP_MAX_PER_RUN = 2;

const DFS_LOCATION: Record<string, number> = {
  NG: 2566, KE: 2404, GH: 2288, TZ: 2834, UG: 2800, CM: 2120, SN: 2686,
  ZM: 2894, ET: 2231, MZ: 2508, ML: 2466, CD: 2180, CI: 2384, BF: 2854,
};

/** Returns null (not []) on failure, so the caller can tell "Google found
 *  nothing" from "the call failed" and fall back to DuckDuckGo instead of
 *  silently losing the keyword for this run. */
async function searchDfsSerp(
  sb: any, query: string, locationCode: number, langCode: string, depth = 100,
): Promise<Array<{ link: string; title: string; snippet: string }> | null> {
  try {
    const res = await fetch('https://api.dataforseo.com/v3/serp/google/organic/live/advanced', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + btoa(`${DFS_LOGIN}:${DFS_PASSWORD}`),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([{
        keyword: query, location_code: locationCode,
        language_code: langCode || 'en', depth,
      }]),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) { res.body?.cancel().catch(() => {}); return null; }
    const body = await res.json();
    const task = body?.tasks?.[0];
    const items = task?.result?.[0]?.items;
    const rows = Array.isArray(items) ? items : [];

    // Cost comes off the response, never estimated — same rule the harvester
    // uses. Wrapped in try/await rather than `.catch()`: a Supabase query builder
    // is a thenable WITHOUT .catch, so `.catch?.(…)` short-circuits to undefined,
    // `then()` is never called, and the request is never actually sent — every
    // SERP call would go unbilled in dfs_usage while really costing money.
    try {
      await sb.from('dfs_usage').insert([{
        endpoint: '/v3/serp/google/organic/live/advanced',
        target: query.slice(0, 200),
        rows_returned: rows.length,
        cost_usd: Number(body?.cost) || 0,
        status_code: Number(task?.status_code) || null,
        error_message: Number(task?.status_code) === 20000
          ? null : String(task?.status_message || '').slice(0, 200),
      }]);
    } catch { /* spend logging must not lose the results we just paid for */ }

    return rows
      .filter((r: any) => r?.type === 'organic' && typeof r?.url === 'string')
      .map((r: any) => ({
        link: r.url,
        title: String(r.title || ''),
        snippet: String(r.description || r.snippet || ''),
      }))
      .filter((r: any) => r.link.startsWith('http'));
  } catch { return null; }
}

// ── Source health / soft-ban detection ─────────────────────────────────────
// DuckDuckGo never says "you are banned"; it just starts returning thin pages.
// The last outage was only noticed days later, from falling lead counts. Tracking
// results-per-request makes the degradation visible while it is still partial,
// and trips a cool-off before the feed reaches zero.
const HEALTHY_AVG = 5;      // normal is ~10-12 results per request

async function isThrottled(sb: any, source: string): Promise<Date | null> {
  try {
    const { data } = await sb.from('source_health')
      .select('throttled, throttle_until')
      .eq('source', source)
      .order('window_start', { ascending: false })
      .limit(1).maybeSingle();
    if (!data?.throttled || !data?.throttle_until) return null;
    const until = new Date(data.throttle_until);
    return until.getTime() > Date.now() ? until : null;
  } catch { return null; }
}

/** Record the run's yield and, if it looks like a soft ban, park the source for
 *  45 minutes. Returns true when a throttle was tripped.
 *
 *  WHAT THIS USED TO DO, AND WHY IT WAS STARVING THE PIPELINE
 *  The old rule was `avg < 5 results/request` → freeze DuckDuckGo for 45
 *  minutes. Ninety minutes of real logs showed what that costs:
 *
 *    10:03:46  degraded 4.0/request  → frozen until 10:48:45
 *    10:12 10:21 10:30 10:39 10:48   → five scheduled runs skipped
 *    10:57:26  ran
 *    10:57:40  degraded 3.0/request  → frozen until 11:42:39
 *    10:58:02  ...and that same run found 9 sites and saved a lead
 *    11:06 11:15 11:24 11:33         → four more skipped
 *
 *  Two searches out of ten scheduled runs. And the run that tripped the second
 *  freeze was layer C — `"affiliate disclosure" betting zambia` and friends.
 *  Exact-phrase footprints return three results on a healthy day; that is what
 *  they are for. Deep pages (3-4) are thin for the same structural reason. The
 *  detector was measuring query narrowness and calling it a ban.
 *
 *  What the real ban actually looked like, from the incident this was built
 *  after: EVERY query returned an empty page, found=0 across the board, for two
 *  days. Empty. Not thin. So that is the signature to react to — and reacting
 *  to it still matters, which is why this is being narrowed rather than removed. */
async function recordHealth(sb: any, source: string, s: DdgSession, layer = 'A'): Promise<boolean> {
  if (!s.requests) return false;
  const avg = s.resultsTotal / s.requests;
  const allEmpty    = s.emptyResponses >= s.requests;
  const mostlyEmpty = s.emptyResponses >= Math.ceil(s.requests * 0.75);

  // A run that returned nothing at all, anywhere, is the ban signature.
  // "Thin but working" is only treated as a ban on layer A, where a broad
  // commercial keyword genuinely should return 10-12 and near-silence means
  // something is wrong with us rather than with the query.
  const dead     = s.requests >= 3 && allEmpty;
  const starving = s.requests >= 3 && layer === 'A' && mostlyEmpty && avg < 2;
  const degraded = dead || starving;
  const until = degraded ? new Date(Date.now() + 45 * 60 * 1000).toISOString() : null;

  try {
    await sb.from('source_health').insert([{
      source,
      requests: s.requests,
      results_total: s.resultsTotal,
      empty_results: s.emptyResponses,
      avg_results: Number(avg.toFixed(2)),
      throttled: degraded,
      throttle_until: until,
    }]);
    if (degraded) {
      await sb.from('error_log').insert([{
        level: 'warning', service: 'find-and-queue',
        message: `${source} ${dead ? 'DEAD' : 'starving'}: ${avg.toFixed(1)} results/request over `
          + `${s.requests} requests (${s.emptyResponses} empty, layer ${layer}) `
          + `— backing off until ${until}`,
      }]);
      await fetch(`${SUPABASE_URL}/functions/v1/send-alert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY,
                   'Authorization': `Bearer ${SUPABASE_KEY}` },
        body: JSON.stringify({
          level: 'warning', service: 'DuckDuckGo',
          message: `Выдача пустая: ${avg.toFixed(1)} результатов на запрос из ${s.requests} `
            + `(${s.emptyResponses} совсем пустых). Пауза 45 минут — это признак бана.`,
        }),
      }).catch(() => {});
    }
  } catch { /* health tracking must never break the run */ }
  return degraded;
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
  // v6 qualification: does this site OWN an audience, does it already monetise
  // traffic, is there a B2B route in, and whose book is it already sending to.
  audience_owner: boolean;
  monetization_signal: boolean;
  monetization_evidence: string;
  has_partnership_path: boolean;
  promotes_competitor: string;
  geo_detected: string;
}

let groqCount = 0;
let groqLastError = '';

// Round-robin cursor across GROQ_KEYS — spreads load so no single key hits its
// per-minute cap. Advances every call and every 429.
let groqKeyIdx = 0;

// Groq chat call with per-key rotation. On 429/5xx/error it retries on the NEXT
// key (no sleep — we can't wait inside a 150s edge function) instead of skipping
// analysis. Returns parsed JSON content, or null only when every key failed.
async function groqChat(body: Record<string, unknown>): Promise<string | null> {
  const n = GROQ_KEYS.length;
  // Two rounds over the keys, with a pause between them. One round was not
  // enough: a run was logged as `found=20 analyzed=0 saved=0 groqCalls=6
  // groqErr="HTTP 429 (key 1)"` — twenty URLs searched for, paid for in DDG
  // rate-limit budget, then discarded because all three keys happened to be
  // over their per-minute cap in the same instant. The keys are shared with
  // the rest of the pipeline, so simultaneous 429s are normal and a second or
  // two later they are fine again. Losing a whole run's material to that is
  // the expensive outcome; a 2s wait is the cheap one.
  for (let round = 0; round < 2; round++) {
    if (round) await new Promise(r => setTimeout(r, 2000));
    for (let i = 0; i < n; i++) {
      const idx = (groqKeyIdx + i) % n;
      try {
        groqCount++;
        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + GROQ_KEYS[idx] },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(20_000),
        });
        if (res.status === 429 || res.status >= 500) {
          // Rate-limited or transient on this key — immediately try the next one.
          groqLastError = `HTTP ${res.status} (key ${idx + 1}, round ${round + 1})`;
          res.body?.cancel().catch(() => {});
          continue;
        }
        if (!res.ok) {
          groqLastError = `HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`;
          return null; // a real error (bad request/auth) — next key won't help
        }
        const d = await res.json();
        groqKeyIdx = (idx + 1) % n; // next call starts on the following key
        return d?.choices?.[0]?.message?.content || '';
      } catch (e: any) {
        groqLastError = e?.message || 'fetch error';
        // try the next key
      }
    }
  }
  // Every key was rate-limited or erroring across both rounds — advance the
  // cursor and skip this batch.
  groqKeyIdx = (groqKeyIdx + 1) % n;
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

  // v6: the model no longer just classifies a site type — it judges PARTNER FITNESS.
  // Owning an audience and already monetising it matter more than polish, because a
  // thin blog handing out a competitor's promo code is a warmer lead than a fat blog
  // with no monetisation at all.
  // NB: the brief asks for a bare JSON array, but Groq's json_object mode rejects a
  // top-level array, so results stay wrapped in {"results":[...]} and are matched by
  // the numeric index rather than by url (the model sometimes rewrites urls).
  const sys = `You are a partner-acquisition analyst for a betting affiliate program (${partnerBrand}).
You evaluate websites as POTENTIAL PARTNERS who could send us betting traffic.

We want: sites that OWN an audience and can promote a bookmaker.
That includes: tipsters, prediction sites, betting review/comparison sites, sports blogs,
sports media, news portals with a sports vertical, content sites that write betting guides,
bonus/promo-code sites, and anyone already promoting a bookmaker.

Writing guides, tutorials or promoting bookmakers is a POSITIVE signal — it proves they own
betting audience and know how to monetise it.

We do NOT want (set audience_owner=false AND relevant=false for ALL of these):
- the bookmakers themselves (operators) AND their official affiliate PROGRAM pages
- banks, microfinance, SACCOs, insurance, loan/mortgage sites, payment providers, fintech
- academic / research / journal / university sites, .edu, papers, theses
- government, regulatory, ministry, NGO and official-body sites (.gov, .gouv, .go.*)
- law firms, attorneys, legal-services sites
- livescore/stats-only services, streaming sites, forums, app-download pages,
  marketplaces, job boards, and any page with no owned audience.
It is a serious error to pitch a partnership to a bank, a law firm, a university,
a government body, or a competitor's own affiliate programme. When unsure whether a
site OWNS a betting audience, answer audience_owner=false.

You get ${cands.length} numbered sites. Return ONLY JSON, one entry per site, same numbering:
{"results":[{
 "i":1,
 "score":0-100,
 "type":"tipster|review|media|blog|aggregator|operator|other",
 "audience_owner":true,
 "monetization_signal":false,
 "monetization_evidence":"",
 "promotes_competitor":"",
 "has_partnership_path":false,
 "is_operator":false,
 "geo_excluded":false,
 "lang":"xx",
 "geo":"",
 "priority":"high|medium|low",
 "summary":"max 15 words",
 "relevant":true
}]}

FIELD RULES:
- audience_owner: owns and publishes to its own audience (NOT a tool/aggregator/operator).
  A site publishing betting tips, predictions, guides or bookmaker reviews for players IS
  audience_owner=true. This is our core target.
  Livescore/stats/odds-feed tools with no editorial content: audience_owner=false.
  News/media portal WITHOUT any sports or betting section: audience_owner=false.
- monetization_signal: affiliate links, promo codes, sponsored posts, "advertise with us",
  media kit, ad banners. monetization_evidence = short phrase, "" if none.
- promotes_competitor: competitor bookmaker name if the site promotes one, "" if none.
- has_partnership_path: partner/advertise/media/press page or B2B contact visible.
- is_operator: the site IS the bookmaker/casino itself or its official mirror.
- geo_excluded: primary audience is US/UK/Western Europe/Ukraine/Brazil/Australia.
- score: content quality + audience depth.

RULES for "relevant":
- relevant=true ONLY IF audience_owner=true AND is_operator=false AND geo_excluded=false.

RULES for "priority":
- high: promotes_competitor is not empty, OR (monetization_signal AND has_partnership_path)
- medium: monetization_signal OR has_partnership_path
- low: neither`;

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
      const audience_owner = ai.audience_owner === undefined ? true : !!ai.audience_owner;
      const monetization_signal  = !!ai.monetization_signal;
      const has_partnership_path = !!ai.has_partnership_path;
      const promotes_competitor  = String(ai.promotes_competitor || '').slice(0, 60).trim();

      // v6 gate. score measures content quality, but a thin site already handing out
      // a competitor's promo code beats a polished blog with no monetisation, so a
      // monetisation signal overrides the quality floor instead of being ranked below it.
      const qualifies =
        score >= MIN_SCORE || promotes_competitor !== '' || has_partnership_path;

      const prioRaw = String(ai.priority || '').toLowerCase();
      out.set(idx, {
        score,
        type:         String(ai.type || 'other').slice(0, 30),
        summary:      String(ai.summary || '').slice(0, 400),
        why:          '',
        priority:     prioRaw === 'high' ? 'High' : prioRaw === 'low' ? 'Low' : 'Medium',
        lang:         String(ai.lang || '').slice(0, 40),
        is_competitor: false,
        is_operator,
        geo_excluded,
        audience_owner,
        monetization_signal,
        monetization_evidence: String(ai.monetization_evidence || '').slice(0, 200),
        has_partnership_path,
        promotes_competitor,
        geo_detected: String(ai.geo || '').slice(0, 40),
        relevant: !!ai.relevant && audience_owner && !is_operator && !geo_excluded && qualifies,
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

// This function is fired on the */3 cron tick, but the heavy search only runs
// every RUN_EVERY_TICKS-th tick (~every 9 min).
//
// HISTORY: this was briefly set to 1 (run every tick) on the theory that more
// frequency = more coverage. It backfired badly. Tripling the request rate to
// DuckDuckGo's HTML endpoint got the shared Supabase egress IP rate-limited:
// within ~2 days every query returned an EMPTY result page (found=0 across the
// board, Groq/SerpApi consumption dropped to zero, lead intake stopped). At the
// proven-good cadence of ~9 min the same searches returned ~1985 results/24h.
// DuckDuckGo scraping punishes burst rate, not total volume — spacing requests
// out yields far MORE than hammering. Do not lower this without a replacement
// search source.
const RUN_EVERY_TICKS = 3;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const tick = Math.floor(Date.now() / (3 * 60 * 1000));

  if (tick % RUN_EVERY_TICKS !== 0) {
    // Something outside this repository invokes this function every three
    // minutes — the cadence is visible in error_log and is accurate to a
    // couple of seconds, but it is not in cron.job and not in any workflow
    // here, so it cannot be edited from the codebase. Two of every three of
    // those invocations are thrown away by the gate above.
    //
    // The brand pipeline has no scheduler of its own for exactly that reason:
    // nothing here can create one. So it rides a discarded tick instead. This
    // costs nothing (the invocation was already paid for and already
    // discarded), needs no new infrastructure, and keeps the two searchers off
    // the same minute — which is what the shared egress IP requires anyway.
    //
    // Awaited rather than fired and forgotten: an edge function's runtime can
    // be torn down the moment it returns a response, which would kill the call
    // mid-flight. This tick had nothing else to do with its time.
    if (tick % RUN_EVERY_TICKS === 1) {
      try {
        const r = await fetch(`${SUPABASE_URL}/functions/v1/brand-search`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY,
                     'Authorization': `Bearer ${SUPABASE_KEY}` },
          // force: this function owns the timing now, so brand-search's own
          // tick gate must not second-guess it.
          body: JSON.stringify({ force: true }),
          signal: AbortSignal.timeout(130_000),
        });
        const out = await r.json().catch(() => ({}));
        return new Response(JSON.stringify({
          skipped: true, reason: 'heavy run throttled — spare tick ran brand-search',
          brand: out,
        }), { headers: { ...cors, 'Content-Type': 'application/json' } });
      } catch (e: any) {
        await quiet(supabase.from('error_log').insert([{
          level: 'warning', service: 'find-and-queue',
          message: 'brand-search hand-off failed: ' + String(e?.message || e).slice(0, 200),
        }]));
      }
    }
    return new Response(JSON.stringify({ skipped: true, reason: 'throttled — heavy run ~every 9 min (DDG rate-limit protection)' }),
      { headers: { ...cors, 'Content-Type': 'application/json' } });
  }

  jinaCount = 0;
  groqCount = 0;
  const stats = {
    brand: '', preset: '', layer: '', keywords_run: 0,
    found: 0, analyzed: 0, irrelevant: 0, competitors: 0, geo_excluded: 0,
    not_audience_owner: 0,
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

    // ── v6: pick the search LAYER for this run ────────────────────────────
    // A single intent vector only ever surfaced audience owners. Layers B and C
    // reach segments layer A structurally cannot see: publishers with ad
    // inventory, and sites already running a competitor's affiliate deal.
    //   0-6 → A (70%) player intent — the core of the base
    //   7-8 → B (20%) publisher / monetisation intent
    //   9   → C (10%) competitor footprints — the warmest, they already get it
    const layerSlot = slotIndex % 10;
    const layer: 'A' | 'B' | 'C' = layerSlot <= 6 ? 'A' : layerSlot <= 8 ? 'B' : 'C';
    stats.layer = layer;

    // Keywords now live in the DB so their yield can be measured and burnt-out
    // ones retired automatically. The hardcoded preset list stays as a fallback
    // for the window before migration 016 lands.
    let poolRows: Array<{ id: number; keyword: string; source_pref?: string; lang?: string }> = [];
    try {
      const { data } = await supabase.from('keywords')
        .select('id, keyword, source_pref, lang')
        .eq('preset', preset.id).eq('layer', layer).eq('active', true)
        .order('id');
      poolRows = data || [];
    } catch (_) { poolRows = []; }

    // Layer A can fall back to the in-code pool; B and C exist only in the DB, so
    // an empty pool there means "nothing to do this tick", not "use layer A keys".
    let keywords: string[];
    let keywordIds = new Map<string, number>();
    // Which search source each keyword prefers, and its language — both only
    // exist for DB-backed pools, so the in-code fallback pool stays on DDG.
    const keywordSource = new Map<string, string>();
    const keywordLang   = new Map<string, string>();
    if (poolRows.length) {
      const cycle   = Math.floor(slotIndex / (BRANDS.length * allPresets.length));
      // Window start advances by KW_PER_RUN, PLUS one extra position per full
      // sweep of the pool. Without that `+ sweeps` the stride and the pool size
      // share a divisor whenever the pool is a multiple of KW_PER_RUN — a pool
      // of 25 with a stride of 5 only ever starts at 0,5,10,15,20, which is
      // harmless while every keyword still lands inside some window, but stops
      // being harmless the moment the pool is not an exact multiple: a pool of
      // 22 would leave positions 20-21 reachable only as the tail of a window
      // and never as its head. Shifting by one each sweep makes every start
      // position eventually reachable for any pool size.
      const sweeps  = Math.floor((cycle * KW_PER_RUN) / poolRows.length);
      const kwStart = (cycle * KW_PER_RUN + sweeps) % poolRows.length;
      const picked: Array<{ id: number; keyword: string }> = [];
      for (let i = 0; i < Math.min(KW_PER_RUN, poolRows.length); i++) {
        picked.push(poolRows[(kwStart + i) % poolRows.length]);
      }
      keywords = [...new Set(picked.map(p => p.keyword))];
      picked.forEach(p => {
        keywordIds.set(p.keyword, p.id);
        if (p.source_pref) keywordSource.set(p.keyword, p.source_pref);
        if (p.lang) keywordLang.set(p.keyword, p.lang);
      });
    } else if (layer === 'A' && preset.keywords.length) {
      const kwStart = (Math.floor(slotIndex / (BRANDS.length * allPresets.length)) * KW_PER_RUN) % preset.keywords.length;
      const rawKw   = preset.keywords.slice(kwStart, kwStart + KW_PER_RUN);
      if (rawKw.length < KW_PER_RUN) rawKw.push(...preset.keywords.slice(0, KW_PER_RUN - rawKw.length));
      keywords = [...new Set(rawKw)];
    } else {
      return new Response(JSON.stringify({ ...stats, skipped: true,
        reason: `no active layer-${layer} keywords for ${preset.id}` }),
        { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

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
    //    Page cycles 2→3→4 per visit. City rotates after every 3 visits (full page cycle).
    //    This means: base keywords × pages 2-4, then city-A × pages 2-4, city-B × pages 2-4…
    //    so every run hits a genuinely different slice of results.
    //
    //    Page 1 is deliberately skipped. Measured over 24h of real runs:
    //      page 1 — 370 results → 3 saved (0.8%)
    //      page 2 — 334 results → 20 saved (6.0%)
    //      page 3 — 305 results → 10 saved (3.3%)
    //    Page one is where every scraper looks first, so by the time we get
    //    there its domains are already in our base and the dedup throws the
    //    whole page away. It was consuming a third of all runs (23 of 55) to
    //    produce three leads.
    const visitNum   = Math.floor(slotIndex / (BRANDS.length * allPresets.length));
    const DDG_PAGE   = (visitNum % 3) + 2; // 2, 3, 4 cycling per visit
    const cityList   = PRESET_CITIES[preset.id] || [];
    const cityIdx    = Math.floor(visitNum / 3) % (cityList.length + 1); // +1 for base (no city)
    const cityAppend = cityIdx < cityList.length ? ' ' + cityList[cityIdx] : '';

    // City padding only makes sense for player intent. Layer B/C keywords are
    // corporate pages and exact-phrase footprints — a city token just breaks them.
    const cityPart = layer === 'A' ? cityAppend : '';
    const minusWords = DDG_MINUS + (layer === 'B' ? LAYER_B_MINUS : '');

    // Five simultaneous requests is a burst, and a burst is what a bot looks
    // like. Concurrency 2 with 2-6s of jitter between launches spreads the same
    // work over the run without reducing it — the goal is to make the CURRENT
    // rate sustainable, not to search less.
    // Honour an active cool-off. Hammering a source that has already started
    // refusing us is exactly how a partial throttle becomes a full ban.
    const throttledUntil = await isThrottled(supabase, 'ddg');
    if (throttledUntil) {
      return new Response(JSON.stringify({
        ...stats, skipped: true,
        reason: `DuckDuckGo backing off until ${throttledUntil.toISOString()}`,
      }), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    const session = makeSession();
    const serpBatches: Array<{ kw: string; results: Array<{ link: string; title: string; snippet: string }> }> = [];
    const DDG_CONCURRENCY = 2;

    // Layer B/C keywords marked source_pref='dataforseo' go to Google instead —
    // but only when explicitly armed and only a couple per run, since each one
    // spends money (see DFS_SERP_ENABLED above).
    const geoCode = String(preset.geo || '').toUpperCase().slice(0, 2);
    const dfsLocation = DFS_LOCATION[geoCode];
    const dfsEligible = DFS_SERP_ENABLED && DFS_LOGIN && DFS_PASSWORD && !!dfsLocation;
    let dfsBudgetLeft = dfsEligible ? DFS_SERP_MAX_PER_RUN : 0;
    (stats as any).dfs_serp = 0;

    const queue = [...keywords];
    const runWorker = async () => {
      while (queue.length) {
        const kw = queue.shift();
        if (!kw) break;

        const wantsDfs = keywordSource.get(kw) === 'dataforseo';
        if (wantsDfs && dfsBudgetLeft > 0) {
          dfsBudgetLeft--;
          // No minus-words and no city padding: those are DDG operators, and
          // layer B/C keys are already exact phrases aimed at Google.
          const r = await searchDfsSerp(
            supabase, kw, dfsLocation, keywordLang.get(kw) || 'en');
          if (r) {
            stats.keywords_run++;
            (stats as any).dfs_serp++;
            serpBatches.push({ kw, results: r });
            continue;
          }
          // null = the call failed. Fall through to DDG rather than dropping the
          // keyword for this run.
          stats.errors.push(`DFS SERP "${kw}": failed, falling back to DDG`);
        }

        await jitter();
        try {
          const r = await searchDuckDuckGo(
            `${kw}${cityPart} ${minusWords}`, RESULTS_PER_KW, DDG_PAGE, session);
          stats.keywords_run++;
          serpBatches.push({ kw, results: r });
        } catch (e: any) {
          stats.errors.push(`DDG "${kw}": ${e?.message || e}`);
          serpBatches.push({ kw, results: [] });
        }
      }
    };
    await Promise.all(Array.from({ length: DDG_CONCURRENCY }, runWorker));

    const ddgDegraded = await recordHealth(supabase, 'ddg', session, layer);
    (stats as any).ddg_avg = session.requests
      ? Number((session.resultsTotal / session.requests).toFixed(2)) : null;
    (stats as any).ddg_degraded = ddgDegraded;

    // 4b. SerpApi (second source) — same keys via Google surface different sites
    //     than DDG. Paced so 3×250/month isn't burned in a day; rotates accounts
    //     as each hits its monthly cap; falls back to DDG-only + alert when all done.
    // v6: spend the scarce SerpApi quota on layers B and C only. Google indexes
    // corporate pages (/advertise, media kits) and exact quoted footprints far
    // better than DDG, while layer A is served fine by DDG — paying Google for it
    // was the wasteful part.
    //
    // The old pacing `slotIndex % 20 === 0` cannot be reused here: that instant
    // always lands on layer A (slot%10===0), so combined with the B/C-only gate it
    // would have fired SerpApi NEVER. Instead pick two fixed slots per 40 — one on
    // a layer-C slot (slot%10===9) and one on a layer-B slot (slot%10===8) — which
    // is ~24 calls/day, matching the 3×250/month budget (pickSerpAccount still
    // hard-caps per account, so this only controls spread, not the ceiling).
    const serpSlot = slotIndex % 40;
    const serpFire = serpSlot === 9   /* layer C */ || serpSlot === 28 /* layer B */;
    if (SERPAPI_ACCOUNTS.length > 0 && serpFire) {
      const acct = await pickSerpAccount();
      if (acct) {
        const serpKws = keywords.slice(0, SERP_KW_PER_RUN);
        let serpCalls = 0;
        for (const kw of serpKws) {
          const results = await searchSerpApi(`${kw}${cityPart}`, RESULTS_PER_KW, acct.key);
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

    // 4c. SerpApi as a working co-source while DuckDuckGo is rate-limited. DDG
    // keeps returning near-empty pages for our datacenter IP, so when a run comes
    // back thin (< 5 results) we pull the run's primary keyword through SerpApi
    // (reliable Google) regardless of layer. Bounded by a daily cap kept in
    // app_state so the monthly SerpApi budget isn't drained all at once, and by
    // pickSerpAccount's per-account monthly hard cap. The daily cap is
    // env-tunable (SERP_DAILY_CAP) so it can be raised without a deploy once the
    // real quota is known. Default 60/day:
    //   • free 3×250 = 750/month  -> ~12 days of coverage (front-loaded, fine
    //     while DDG recovers), and pickSerpAccount stops at the monthly cap anyway.
    //   • paid plan -> set SERP_DAILY_CAP to plan_monthly / days_in_month.
    const ddgTotal = serpBatches.reduce((s, b) => s + b.results.length, 0);
    if (ddgTotal < 5 && SERPAPI_ACCOUNTS.length > 0 && !(stats as any).serp) {
      const DAILY_SERP_CAP = parseInt(Deno.env.get('SERP_DAILY_CAP') || '60', 10) || 60;
      const today = new Date().toISOString().slice(0, 10);
      const { data: sd } = await supabase.from('app_state').select('value').eq('key', 'serp_daily').maybeSingle();
      const [sdDay, sdCntRaw] = String(sd?.value || '').split(':');
      const usedToday = sdDay === today ? (parseInt(sdCntRaw, 10) || 0) : 0;
      if (usedToday < DAILY_SERP_CAP) {
        const acct = await pickSerpAccount();
        if (acct) {
          let serpCalls = 0;
          for (const kw of keywords.slice(0, SERP_KW_PER_RUN)) {
            const results = await searchSerpApi(`${kw}${cityPart}`, RESULTS_PER_KW, acct.key);
            serpBatches.push({ kw, results });
            serpCalls++;
          }
          await bumpSerpAccount(acct.service, serpCalls);
          await supabase.from('app_state').upsert(
            { key: 'serp_daily', value: `${today}:${usedToday + serpCalls}`, updated_at: new Date().toISOString() },
            { onConflict: 'key' },
          );
          (stats as any).serp_fallback = serpCalls;
          (stats as any).serp_acct = acct.service;
        }
      }
    }

    // Merge, dedup by domain across all keywords, and apply the cheap pre-filters now
    // so the expensive Groq+fetch loop only sees real candidates.
    // Each candidate carries the keyword that surfaced it (stored on the lead).
    const candidates: Array<{ url: string; title: string; snippet: string; origin: string; keyword: string }> = [];
    const seenThisRun = new Set<string>();
    // Per-keyword yield for this run, flushed to the keywords table at the end.
    const kwStats = new Map<string, { urls: number; leads: number; hot: number }>();
    keywords.forEach(k => kwStats.set(k, { urls: 0, leads: 0, hot: 0 }));
    for (const { kw, results } of serpBatches) {
      stats.found += results.length;
      const ks = kwStats.get(kw);
      if (ks) ks.urls += results.length;
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
        if (analysis.is_operator)     { stats.competitors++;        return; }
        if (analysis.geo_excluded)    { stats.geo_excluded++;       return; }
        if (!analysis.audience_owner) { stats.not_audience_owner++; return; }
        if (!analysis.relevant)       { stats.irrelevant++;         return; }
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
          // v6 provenance — which layer/keyword/page produced this lead, so yield
          // can be attributed instead of guessed at.
          search_layer:   layer,
          source_keyword: keyword,
          source_page:    DDG_PAGE,
          // v6 qualification, carried into scoring
          audience_owner:        analysis.audience_owner,
          monetization_signal:   analysis.monetization_signal,
          monetization_evidence: analysis.monetization_evidence || null,
          has_partnership_path:  analysis.has_partnership_path,
          ...(analysis.promotes_competitor ? { competitor_book: analysis.promotes_competitor } : {}),
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
          const ks = kwStats.get(keyword);
          if (ks) {
            ks.leads++;
            // "hot" mirrors the fit_score >= 70 band: already monetising, or a
            // strong site with a way in. score-leads recomputes the real number.
            if (analysis.promotes_competitor || (analysis.monetization_signal && analysis.has_partnership_path)) ks.hot++;
          }
        } else {
          stats.errors.push(`insert ${getDomain(url)}: ${insErr.message}`);
        }
      }
    }

    // ── v6: write back per-keyword yield ──────────────────────────────────
    // Without this the pool burns out silently and you only notice from falling
    // output weeks later, which is exactly what happened to the v5 keywords.
    for (const [kw, s] of kwStats) {
      const id = keywordIds.get(kw);
      if (!id) continue;
      const { data: cur } = await supabase.from('keywords')
        .select('runs, urls_found, leads_created, hot_leads').eq('id', id).maybeSingle();
      if (!cur) continue;
      await supabase.from('keywords').update({
        runs:          (cur.runs ?? 0) + 1,
        urls_found:    (cur.urls_found ?? 0) + s.urls,
        leads_created: (cur.leads_created ?? 0) + s.leads,
        hot_leads:     (cur.hot_leads ?? 0) + s.hot,
        last_run_at:   new Date().toISOString(),
      }).eq('id', id);
    }

    // 5. Track API usage (DuckDuckGo is free/keyless — no counter needed)
    await Promise.all([
      bumpUsage('jina',  jinaCount),
      bumpUsage('groq',  groqCount),
    ]);

    await supabase.from('error_log').insert([{
      level: 'info', service: 'find-and-queue',
      message: `brand=${brand} layer=${layer} preset="${preset.name}" kw=${stats.keywords_run} page=${DDG_PAGE}${cityPart ? ` city="${cityPart.trim()}"` : ''} `
        + `found=${stats.found} analyzed=${stats.analyzed} `
        + `irrelevant=${stats.irrelevant} not_owner=${stats.not_audience_owner} competitors=${stats.competitors} geo_excl=${stats.geo_excluded} `
        + `saved=${stats.saved} contacts=${stats.contacts} groqCalls=${groqCount}`
        + ((stats as any).serp ? ` serp=${(stats as any).serp}(${(stats as any).serp_acct})` : '')
        + ((stats as any).serp_fallback ? ` serpFallback=${(stats as any).serp_fallback}(${(stats as any).serp_acct})` : '')
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
