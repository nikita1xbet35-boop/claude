// Supabase Edge Function: dfs-harvest
// ════════════════════════════════════════════════════════════════════════════
// Stage 1 of the DataForSEO pipeline: HARVEST.
//
// Turns money into candidate domains as cheaply as possible. Analyses nothing,
// fetches no pages, contacts nobody — that is dfs-qualify's and dfs-enrich's job.
//
// WHY THIS WAS REWRITTEN (v7.1)
// The original method pulled the backlink profiles of competitor bookmakers on
// the reasoning that whoever links to a book is an affiliate. It does not hold
// up. bet9ja.com has 18 115 referring domains and maybe 3-5% are live
// affiliates; the rest are shorteners, scrapers, directories, comment spam,
// forum profiles and one-off news mentions. Our own pilot said the same thing
// in numbers: 30 domains from the intersection reached the qualifier and all 30
// came back no_audience.
//
// A backlink is indirect evidence — "this site once placed a link". There is
// direct evidence available: who is in the top of the SERP for commercial
// queries RIGHT NOW. So the question is inverted. Not "take every link the book
// has and try to filter it", but "here are 200 commercial queries — show me who
// owns this SERP". Junk does not rank for commercial queries at all, which
// moves the filtering to Google's side instead of ours.
//
// THE PIPELINE
//   S. serp_competitors   → who owns the commercial SERP        (PRIMARY INPUT)
//   R. ranked_keywords    → qualify: how many commercial keys in the top 10,
//                           and at what search volume                (FILTER)
//   C. competitors_domain → multiply: peers of every professional found
//   A. backlinks-by-anchor→ secondary volume, filtered on anchor text
//   I/B. intersection + broad referring domains — the v7 method, demoted
//
// Positions without search volume are worthless: a site "ranking for 500 keys"
// with no traffic means either the keys have no volume, the positions are
// really 15-50, or it is a PBN node built not to receive traffic. None of the
// three is a prospect, which is why step R filters on search_volume > 100 API-
// side and the queue sorts on etv rather than on any count of anything.
//
// RUN IT MANUALLY (or weekly), NOT ON THE 3-MINUTE CRON. Every call costs real
// money and the whole point is large, infrequent batches.
//
// Cost model for the backlinks endpoints, confirmed against the live API:
//   $0.024 per request + $0.000036 per row  →  1000 rows = $0.06
// The Labs endpoints (serp_competitors, ranked_keywords, competitors_domain)
// are tariffed differently, so nothing here estimates them from a formula: the
// estimate averages what THIS account was actually charged, read from dfs_usage,
// and says "unknown" until the first real call has happened.
//
// Body params (all optional):
//   { budget_usd: 5,
//     mode: 'pipeline'|'serp'|'ranked'|'similar'|'anchors'|'intersect'|'broad'
//           |'both'|'all',
//     rows_per_call: 1000, estimate_only: false }
//
// Deploy: supabase functions deploy dfs-harvest --no-verify-jwt
// Env:    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DFS_LOGIN, DFS_PASSWORD

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const DFS_LOGIN    = Deno.env.get('DFS_LOGIN') || '';
const DFS_PASSWORD = Deno.env.get('DFS_PASSWORD') || '';

const DFS_BASE = 'https://api.dataforseo.com';

// Stop starting new work here; edge functions get ~150s wall clock.
const DEADLINE_MS = 110_000;
// Below this balance the harvester refuses to start — running the account to
// zero mid-pagination leaves a competitor half-harvested with no way to tell.
const MIN_BALANCE_USD = 0.10;
// Ceiling on what a single invocation may authorise, whatever it was asked for.
// This function is deployed --no-verify-jwt like everything else here, so it is
// callable by anyone holding the anon key, and the realistic accident is a
// fat-fingered budget in the UI (500 instead of 5) emptying the account in one
// call. Raise deliberately if a genuinely larger single run is ever wanted.
const MAX_BUDGET_PER_RUN = 25;
// API-side quality floor. rank <= 15 is overwhelmingly scraper junk, and
// filtering costs nothing.
const MIN_RANK = 15;
// How many competitor books a domain must link to for the intersection phase.
// Two, not three: a three-way intersection is a far smaller set, and the first
// successful run came back with total_count=0 at three targets across every geo.
const INTERSECT_TARGETS = 2;

// ── v7.1 constants ──────────────────────────────────────────────────────────
// relevance is 0-1, how well the domain's profile matches the keyword cluster.
// The filter is not optional: without it the top of every cluster is Wikipedia,
// Facebook and whichever national newspaper happened to rank for one query out
// of two hundred.
const MIN_RELEVANCE = 0.5;
// serp_competitors accepts up to 200 keywords per request; our clusters are
// 5-14 keys, so one cluster is always one call.
const SERP_KEYWORDS_MAX = 200;
// Rows per Labs call. Deliberately not rows_per_call: that parameter is tuned
// for backlinks (1000 rows at $0.000036 each) and the Labs tariff is different.
// 100 competitors per SERP is already past the point where relevance decays.
const SERP_LIMIT    = 100;
const SIMILAR_LIMIT = 50;
// ranked_keywords is per-domain, so an unbounded loop would spend the whole
// budget on qualification and never harvest. These cap a single invocation;
// the budget check caps it again.
const RANKED_PER_RUN  = 25;
const SIMILAR_PER_RUN = 8;
// Top-10 only, and only keys with real volume. Both filters run API-side and
// are free — we pay only for rows that already passed them.
const RANKED_MAX_POSITION  = 11;   // rank_group < 11
const RANKED_MIN_VOLUME    = 100;  // search_volume > 100

// Classification thresholds (v7.1 §2 step 2).
const PRO_MIN_KEYWORDS = 15;
const PRO_MIN_VOLUME   = 10_000;
const SEMI_MIN_KEYWORDS = 5;

// Anchor patterns for the demoted backlinks phase. "Bet9ja promo code" is an
// affiliate link; the company name or a bare URL is a news mention. Filtering
// on anchor happens API-side and is free, so we pay only for rows that already
// look like affiliate placements — the single biggest change to that phase.
const ANCHOR_PATTERNS = [
  '%promo code%', '%bonus code%', '%review%', '%sign up%',
  '%registration%', '%best betting%', '%code promo%', '%avis%',
  '%bonus%', '%offer%', '%comparatif%', '%análise%',
];
// Anchor calls per competitor per run. Without a cap, 18 competitors × 12
// patterns is 216 calls in one invocation.
const ANCHOR_PATTERNS_PER_RUN = 3;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Best-effort await. A Supabase query builder is a thenable WITHOUT .catch, so
 *  `builder.catch(...)` throws TypeError instead of swallowing anything. */
async function quiet(p: PromiseLike<unknown>): Promise<void> {
  try { await p; } catch { /* bookkeeping is best-effort */ }
}

// ── DataForSEO client ───────────────────────────────────────────────────────
const authHeader = () => 'Basic ' + btoa(`${DFS_LOGIN}:${DFS_PASSWORD}`);

interface DfsCall {
  ok: boolean;
  cost: number;
  items: any[];
  totalCount: number;
  statusCode: number;
  error: string;
}

/** One DataForSEO call, with the spend logged whatever happens.
 *
 *  Two status codes matter and they are easy to confuse: the HTTP status, and
 *  DataForSEO's own `status_code` in the body. A task can fail (40xxx) inside a
 *  perfectly successful HTTP 200 — treating 200 as success silently swallows
 *  "insufficient funds" and the harvester looks like it merely found nothing.
 *
 *  Retries 429/5xx with backoff. `cost` is always read off the response, never
 *  estimated, so the dashboard's budget figure is the real one. */
async function dfsCall(endpoint: string, payload: unknown, target = ''): Promise<DfsCall> {
  const out: DfsCall = { ok: false, cost: 0, items: [], totalCount: 0, statusCode: 0, error: '' };

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(1000 * Math.pow(2, attempt)); // 2s, 4s
    try {
      const res = await fetch(DFS_BASE + endpoint, {
        method: 'POST',
        headers: { 'Authorization': authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify([payload]),
        signal: AbortSignal.timeout(60_000),
      });

      if (res.status === 429 || res.status >= 500) {
        out.statusCode = res.status;
        out.error = `HTTP ${res.status}`;
        res.body?.cancel().catch(() => {});
        continue; // transient — retry
      }
      if (!res.ok) {
        out.statusCode = res.status;
        out.error = `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
        break; // auth/bad-request — retrying won't help
      }

      const body = await res.json();
      out.cost = Number(body?.cost) || 0;
      out.statusCode = Number(body?.status_code) || 0;

      const task = body?.tasks?.[0];
      const taskCode = Number(task?.status_code) || 0;
      // 20000 = ok. Anything else is a real failure carried inside HTTP 200.
      if (taskCode && taskCode !== 20000) {
        out.error = `task ${taskCode}: ${String(task?.status_message || '').slice(0, 200)}`;
        out.statusCode = taskCode;
        break;
      }

      const result = task?.result?.[0];
      out.items = Array.isArray(result?.items) ? result.items : [];
      out.totalCount = Number(result?.total_count) || 0;
      out.ok = true;
      break;
    } catch (e: any) {
      out.error = String(e?.message || e).slice(0, 200);
    }
  }

  await quiet(supabase.from('dfs_usage').insert([{
    endpoint,
    target: target || null,
    rows_returned: out.items.length,
    cost_usd: out.cost,
    status_code: out.statusCode || null,
    error_message: out.error || null,
  }]));

  return out;
}

/** Call an endpoint, and let the API itself teach us the payload it accepts.
 *
 *  DataForSEO rejects an unknown parameter with `40501 Invalid Field: 'x'` —
 *  naming the offender. So instead of guessing the schema one deploy at a time,
 *  drop exactly the field it named and retry.
 *
 *  This exists because the brief's request examples do not match the live API,
 *  and that could not be discovered from a sandbox whose network policy blocks
 *  api.dataforseo.com. Two pilot runs burned on it: the first died on
 *  `order_by`, and once that was corrected the second died on
 *  `intersection_mode` — the same guess-and-redeploy loop, one field per round
 *  trip. Rejected tasks are billed at $0, so converging here inside a single run
 *  costs nothing but a few seconds.
 *
 *  Sort and filter clauses are still sent on the first attempt: server-side
 *  filtering is free and keeps the paid row count down. `dropped` tells the
 *  caller which clauses did not survive, so it can apply them client-side. */
const NEVER_DROP = new Set(['target', 'targets', 'limit', 'offset']);
const MAX_FIELD_PEELS = 6;

async function dfsCallTolerant(
  endpoint: string,
  base: Record<string, unknown>,
  extras: Record<string, unknown>,
  target = '',
): Promise<DfsCall & { dropped: string[]; attempts: number }> {
  let payload: Record<string, unknown> = { ...base, ...extras };
  const dropped: string[] = [];
  let cost = 0;
  let last: DfsCall | null = null;
  let attempts = 0;

  for (let attempt = 0; attempt <= MAX_FIELD_PEELS; attempt++) {
    const r = await dfsCall(endpoint, payload, target);
    attempts++;
    cost += r.cost;
    last = r;
    if (r.ok) break;

    const field = r.error.match(/invalid field:\s*'([^']+)'/i)?.[1];
    // Not a field-shape problem (auth, funds, rate limit) — retrying the same
    // request differently will not help.
    if (!field) break;
    // A required field being called invalid means the shape is wrong in a way
    // peeling cannot fix; stop rather than send a request that cannot succeed.
    if (NEVER_DROP.has(field) || !(field in payload)) break;

    const { [field]: _removed, ...rest } = payload;
    payload = rest;
    dropped.push(field);
  }

  return { ...(last as DfsCall), cost, dropped, attempts };
}

/** Account balance. Also the credentials smoke test — a wrong API password
 *  (people paste the dashboard password, which is a different secret) surfaces
 *  here as a 401 rather than as a mysteriously empty harvest. */
async function dfsBalance(): Promise<{ ok: boolean; balance: number; error: string }> {
  try {
    const res = await fetch(DFS_BASE + '/v3/appendix/user_data', {
      headers: { 'Authorization': authHeader() },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const txt = (await res.text()).slice(0, 200);
      return { ok: false, balance: 0, error: `HTTP ${res.status}: ${txt}` };
    }
    const d = await res.json();
    const money = d?.tasks?.[0]?.result?.[0]?.money;
    return { ok: true, balance: Number(money?.balance) || 0, error: '' };
  } catch (e: any) {
    return { ok: false, balance: 0, error: String(e?.message || e).slice(0, 200) };
  }
}

// ── Junk pre-filter (free, before anything is written) ──────────────────────
// Link shorteners and redirectors dominate every backlink profile and are worth
// nothing: bit.ly is the #1 referring domain of most bookmakers.
const SKIP_EXACT = new Set([
  'bit.ly', 't.co', 'tinyurl.com', 'goo.gl', 'linktr.ee', 'ow.ly', 'buff.ly',
  'cutt.ly', 'rb.gy', 'is.gd', 'shorturl.at', 'rebrand.ly', 'lnk.to', 'bit.do',
  'facebook.com', 'twitter.com', 'x.com', 'instagram.com', 'youtube.com',
  'youtu.be', 'reddit.com', 'pinterest.com', 'linkedin.com', 'tiktok.com',
  'medium.com', 'blogspot.com', 'wordpress.com', 'tumblr.com', 'vk.com',
  'wikipedia.org', 'archive.org', 'google.com', 'amazon.com', 'apple.com',
  'quora.com', 'telegram.org', 't.me', 'whatsapp.com', 'disqus.com',
  'livescore.com', 'flashscore.com', 'sofascore.com', 'espn.com', 'bbc.com',
  'cnn.com', 'yahoo.com', 'msn.com', 'github.com', 'issuu.com', 'scribd.com',
]);
// Our own group — a site already pushing these is occupied, not a prospect.
const OUR_BRANDS = ['1xbet', '1xcasino', '1xpartners', 'melbet', 'betwinner',
  'megapari', 'paripesa', '22bet', 'linebet', 'luckypari'];
// Geos we do not sell into. `.fr` is deliberately absent — francophone African
// sites use it heavily and are prime targets.
const SKIP_TLD = ['.uk', '.ua', '.au', '.br', '.us', '.gov', '.edu', '.mil',
  '.ru', '.by', '.kz', '.pl', '.cz', '.nl', '.se', '.no', '.dk', '.fi'];

// ── Machine junk ────────────────────────────────────────────────────────────
// The first real intersection run put pdfbookee.com and subdomainfinder.io at
// the TOP of the queue, above every genuine affiliate. That is not bad luck:
// tooling and scraper sites link out to thousands of domains automatically, so
// they hit two or three bookmakers by construction — the exact signal the
// intersection is supposed to prove. The link graph cannot tell them apart, so
// they have to be named.
//
// Substring match on the bare hostname. Each entry is a machine that generates
// pages ABOUT other sites (SEO/DNS/WHOIS lookups, PDF and APK scrapers, stat
// farms), never a publisher with an audience of its own.
const JUNK_PATTERNS = [
  // SEO / DNS / WHOIS / hosting lookup tools
  'subdomainfinder', 'subdomain-', 'dnsdumpster', 'dnschecker', 'nslookup',
  'whois', 'iptrack', 'ip-track', 'iplocation', 'ip-lookup', 'mxtoolbox',
  'sitechecker', 'urlscan', 'seotool', 'seocheck', 'seoreview', 'seorank',
  'seoaudit', 'backlinkcheck', 'linkchecker', 'similarweb', 'ahrefs',
  'semrush', 'majestic', 'statscrop', 'websiteoutlook', 'siteworth',
  'websitevalue', 'worthofweb', 'trafficestimate', 'rank-checker',
  'rankchecker', 'domaintools', 'domainbigdata', 'expireddomain', 'hostadvice',
  'webhosting', 'cpanel', 'sitespeed', 'pagespeed', 'w3snoop', 'urlrate',
  // Document / file / APK scrapers — pages generated from other people's files
  'pdfbook', 'pdfdrive', 'pdffiller', 'pdfcoffee', 'ebookdownload', 'docplayer',
  'slideshare', 'scribd', 'epubdownload', 'freedownload', 'downloadapk',
  'apkpure', 'apkmirror', 'apkmody', 'apkdone', 'modapk', 'apk-', '-apk.',
  'crackdownload', 'nulled', 'warez', 'torrent',
  // Redirect / shortener farms beyond the named ones
  'shortlink', 'urlshort', 'shorten', 'linkbio', 'link-bio', 'redirect',
  // Scraped-content farms
  'freewebsite', 'webstat', 'sitestat', 'domainstat', 'alexa-rank',
];

/** True when the hostname belongs to a machine rather than a publisher.
 *  Used on both sides of the pipeline — harvest drops these before they are
 *  written, qualify drops any that predate this list. */
function isMachineJunk(domain: string): boolean {
  const stem = domain.split('.')[0];
  return JUNK_PATTERNS.some(p => domain.includes(p))
    // A bare-tool stem like "whois" or "subger" is also caught by the list
    // above; this second test keeps the check honest when the pattern would
    // otherwise straddle a dot ("pdf.bookee.com").
    || JUNK_PATTERNS.some(p => stem.includes(p.replace(/[-.]/g, '')));
}

/** Normalise to a bare registrable-ish hostname. */
function normDomain(raw: string): string {
  let d = String(raw || '').trim().toLowerCase();
  if (!d) return '';
  d = d.replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0];
  return d;
}

function isJunk(domain: string, competitorSet: Set<string>): boolean {
  if (!domain || !domain.includes('.')) return true;
  if (domain.length > 120) return true;
  if (SKIP_EXACT.has(domain)) return true;
  // Subdomains of skipped platforms (foo.blogspot.com, bar.wordpress.com).
  for (const s of SKIP_EXACT) if (domain.endsWith('.' + s)) return true;
  if (SKIP_TLD.some(t => domain.endsWith(t))) return true;
  if (OUR_BRANDS.some(b => domain.includes(b))) return true;
  if (isMachineJunk(domain)) return true;
  // The bookmakers themselves, and their local mirrors (bet9ja.ng for bet9ja.com).
  if (competitorSet.has(domain)) return true;
  for (const c of competitorSet) {
    const stem = c.split('.')[0];
    if (stem.length >= 5 && domain.startsWith(stem + '.')) return true;
  }
  return false;
}

// ── Row shaping ─────────────────────────────────────────────────────────────
interface UpsertRow {
  domain: string; source: string; competitor: string | null;
  dfs_rank: number | null; spam_score: number | null;
  backlinks_count: number | null; referring_pages: number | null;
  anchor: string | null; page_title: string | null; first_seen: string | null;
}

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown, cap: number): string | null => {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, cap) : null;
};

/** Flatten one domain_intersection item into a single row.
 *
 *  This endpoint does NOT put the domain at the top level. It returns one
 *  sub-object per target, keyed by the target's index — "1", "2" — which is
 *  exactly why its sort field had to be written "1.rank" rather than "rank".
 *  Reading `it.domain` therefore found nothing, and every row was silently
 *  skipped: a run reported 100 rows returned, 2905 available, and 0 saved, with
 *  no error anywhere. The API was right the whole time.
 *
 *  The per-target sub-objects describe the SAME referring domain, so the fields
 *  are merged rather than taken from one: best rank, lowest spam score, largest
 *  link counts, earliest first_seen. Falls back to a flat shape in case the
 *  response format changes again. */
// Field names that have been seen to carry a referring domain across the
// backlinks endpoints. Checked in order of preference.
const DOMAIN_KEYS = ['domain', 'domain_from', 'referring_domain', 'target'];

/** Collect every object inside `it` (to a shallow depth) that carries a
 *  domain-like field. Shape-agnostic on purpose: three runs were lost to
 *  guessing where the domain sits, the docs host is blocked by the same egress
 *  policy as the API, and a parser that searches costs nothing extra to run. */
function collectDomainParts(it: any, depth = 0, out: any[] = []): any[] {
  if (!it || typeof it !== 'object' || depth > 3) return out;
  if (Array.isArray(it)) {
    for (const v of it) collectDomainParts(v, depth + 1, out);
    return out;
  }
  if (DOMAIN_KEYS.some(k => typeof it[k] === 'string' && it[k].includes('.'))) out.push(it);
  for (const k of Object.keys(it)) {
    const v = it[k];
    if (v && typeof v === 'object') collectDomainParts(v, depth + 1, out);
  }
  return out;
}

const domainOf = (o: any): string => {
  for (const k of DOMAIN_KEYS) {
    if (typeof o?.[k] === 'string' && o[k].includes('.')) return normDomain(o[k]);
  }
  return '';
};

function flattenIntersectionItem(it: any): {
  domain: string; rank: number | null; spam: number | null;
  backlinks: number | null; referringPages: number | null; firstSeen: string | null;
} | null {
  if (!it || typeof it !== 'object') return null;

  // Prefer the per-target sub-objects under numeric keys ("1", "2") — that is
  // the shape the accepted `1.rank` sort field implies. Fall back to a search so
  // an unexpected layout still yields rows instead of silently dropping all of
  // them, which is precisely how a run reported 100 returned / 2905 available /
  // 0 saved with no error anywhere.
  const numbered = Object.keys(it)
    .filter(k => /^\d+$/.test(k))
    .map(k => it[k])
    .filter(s => s && typeof s === 'object' && domainOf(s));

  const parts = numbered.length ? numbered : collectDomainParts(it);
  if (!parts.length) return null;

  const domain = domainOf(parts[0]);
  if (!domain) return null;

  const pick = (f: (s: any) => number | null, merge: (a: number, b: number) => number) => {
    const vals = parts.map(f).filter((v): v is number => v !== null);
    // reduce((a, b) => merge(a, b)), NOT reduce(merge): reduce hands the callback
    // four arguments, and Math.max(a, b, index, array) coerces the array to NaN.
    // Every metric came back NaN — which JSON renders as null, so it looked like
    // missing data rather than a bug.
    return vals.length ? vals.reduce((a, b) => merge(a, b)) : null;
  };

  const seen = parts.map(s => str(s.first_seen, 40)).filter((v): v is string => !!v).sort();

  return {
    domain,
    rank:           pick(s => num(s.rank), Math.max),
    spam:           pick(s => num(s.backlinks_spam_score), Math.min),
    backlinks:      pick(s => num(s.backlinks), Math.max),
    referringPages: pick(s => num(s.referring_pages), Math.max),
    firstSeen:      seen[0] ?? null,
  };
}

/** Push rows through the bulk upsert RPC. The RPC merges competitors_list and
 *  recomputes intersect_count in one statement — doing it here would be a
 *  read-modify-write per row. */
async function flush(rows: UpsertRow[]): Promise<number> {
  if (!rows.length) return 0;
  let saved = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { data, error } = await supabase.rpc('dfs_upsert_domains', { p_rows: chunk });
    if (error) throw new Error('upsert: ' + error.message);
    saved += Number(data) || 0;
  }
  return saved;
}

/** Rows from the Labs endpoints, which carry SERP-ownership metrics instead of
 *  a competitor and a link count. Separate RPC for a separate shape — see the
 *  note on dfs_upsert_serp_domains in migration 027. */
interface SerpRow {
  domain: string; source: string; keyword_cluster: string | null;
  etv: number | null; median_position: number | null;
  visibility: number | null; relevance: number | null;
  keywords_matched: number | null;
}

async function flushSerp(rows: SerpRow[]): Promise<number> {
  if (!rows.length) return 0;
  let saved = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { data, error } = await supabase.rpc('dfs_upsert_serp_domains', { p_rows: chunk });
    if (error) throw new Error('serp upsert: ' + error.message);
    saved += Number(data) || 0;
  }
  return saved;
}

/** Read a domain-ish field out of a Labs item.
 *
 *  serp_competitors returns `domain`; competitors_domain nests its metrics
 *  under `metrics.organic` and names the field `domain` as well, but neither
 *  shape is documented from here (the docs host is blocked by the same egress
 *  policy as the API), so both are probed rather than assumed. */
function labsDomain(it: any): string {
  for (const k of ['domain', 'target', 'domain_from']) {
    const v = it?.[k];
    if (typeof v === 'string' && v.includes('.')) return normDomain(v);
  }
  return '';
}

/** Pull a metric that may sit at the top level or inside metrics.organic. */
function labsNum(it: any, ...keys: string[]): number | null {
  const organic = it?.metrics?.organic ?? it?.metrics ?? null;
  for (const k of keys) {
    const direct = num(it?.[k]);
    if (direct !== null) return direct;
    if (organic) {
      const nested = num(organic?.[k]);
      if (nested !== null) return nested;
    }
  }
  return null;
}

// ── Main ────────────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const stats = {
    ran: false,
    mode: 'both',
    balance_before: 0,
    balance_after: null as number | null,
    spent: 0,
    calls: 0,
    rows_seen: 0,
    junk_filtered: 0,
    // Items the parser could not read a domain out of. Non-zero here means the
    // response shape moved again — the failure that cost three runs to spot.
    unparsed_items: 0,
    saved: 0,
    // v7.1 phases, reported separately: the whole point of the rework is being
    // able to see which SOURCE produced the domains, not just how many landed.
    serp: [] as Array<{ geo: string; keywords: number; returned: number; kept: number }>,
    serp_saved: 0,
    ranked_checked: 0,
    ranked_professional: 0,
    similar: [] as Array<{ seed: string; returned: number; kept: number }>,
    anchors: [] as Array<{ competitor: string; pattern: string; returned: number; kept: number }>,
    intersections: [] as Array<{ geo: string; targets: string[]; found: number; returned: number; total: number }>,
    broad: [] as Array<{ competitor: string; found: number; offset: number; total: number }>,
    anchors_filled: 0,
    // Which request fields the API refused, per phase. Worth surfacing rather
    // than swallowing: it is the difference between "this endpoint's schema
    // drifted" and "the harvest found nothing", which look identical otherwise.
    dropped_fields: {} as Record<string, string[]>,
    reason: '',
    error: '',
  };

  let sampleLogged = false;

  const dropNote = (phase: string, fields: string[]) => {
    const seen = stats.dropped_fields[phase] || [];
    stats.dropped_fields[phase] = [...new Set([...seen, ...fields])];
  };
  const json = (s: unknown, code = 200) => new Response(JSON.stringify(s),
    { status: code, headers: { ...cors, 'Content-Type': 'application/json' } });

  const startedAt = Date.now();
  const outOfTime = () => Date.now() - startedAt > DEADLINE_MS;

  try {
    if (!DFS_LOGIN || !DFS_PASSWORD) {
      stats.reason = 'DFS_LOGIN / DFS_PASSWORD not configured';
      return json(stats, 400);
    }

    let body: any = {};
    try { body = await req.json(); } catch { /* no body — all defaults */ }

    // `?? 5` rather than `|| 5`: an explicit budget_usd of 0 means "spend
    // nothing", and `||` would turn that into an authorised $5.
    const parsedBudget = Number(body.budget_usd);
    const budget      = Math.min(
      MAX_BUDGET_PER_RUN,
      Math.max(0, Number.isFinite(parsedBudget) ? parsedBudget : 5),
    );
    const mode        = String(body.mode || 'pipeline');
    const rowsPerCall = Math.min(1000, Math.max(10, Number(body.rows_per_call) || 1000));
    stats.mode = mode;

    // Which phases this mode runs. 'pipeline' is the v7.1 default and
    // deliberately excludes the backlinks phases: they are what produced a
    // queue of 30 domains that were all rejected, and re-running them by
    // default would keep paying for that.
    const PHASES: Record<string, string[]> = {
      pipeline:  ['serp', 'ranked', 'similar'],
      serp:      ['serp'],
      ranked:    ['ranked'],
      similar:   ['similar'],
      anchors:   ['anchors'],
      intersect: ['intersect'],
      broad:     ['broad'],
      both:      ['intersect', 'broad'],          // v7 meaning, kept for old callers
      all:       ['serp', 'ranked', 'similar', 'anchors', 'intersect', 'broad'],
    };
    const phases = new Set(PHASES[mode] || PHASES.pipeline);
    const want = (p: string) => phases.has(p);

    // Cost is deterministic, so the UI can be told the price before spending it.
    // The estimate also carries the live balance: the operator needs both
    // numbers in front of them at the moment they press the button, and
    // /v3/appendix/user_data is free.
    const perCall = 0.024 + rowsPerCall * 0.000036;
    if (body.estimate_only) {
      const { data: comps } = await supabase.from('dfs_competitors')
        .select('domain, geo').eq('active', true);
      // Only geos with 2+ books can produce an intersection at all.
      const geoCount = new Map<string, number>();
      for (const c of comps || []) geoCount.set(c.geo, (geoCount.get(c.geo) || 0) + 1);
      const intersectCalls = [...geoCount.values()].filter(n => n >= 2).length;
      const broadCalls = (comps || []).length;

      const { count: clusterCount } = await supabase.from('dfs_keyword_clusters')
        .select('id', { count: 'exact', head: true }).eq('active', true);
      const { count: rankPending } = await supabase.from('dfs_domains')
        .select('id', { count: 'exact', head: true })
        .in('source', ['serp_competitors', 'competitors_domain'])
        .is('rank_checked_at', null);

      // What the Labs endpoints actually cost THIS account. Their tariff is not
      // the backlinks formula and is not documented from here, so the estimate
      // is measured rather than derived — and honestly reports null until the
      // first real call has been billed.
      const labsAvg = async (endpoint: string): Promise<number | null> => {
        const { data } = await supabase.from('dfs_usage')
          .select('cost_usd').eq('endpoint', endpoint).gt('cost_usd', 0)
          .order('created_at', { ascending: false }).limit(50);
        if (!data?.length) return null;
        const sum = data.reduce((s: number, r: any) => s + (Number(r.cost_usd) || 0), 0);
        return sum / data.length;
      };
      const serpAvg    = await labsAvg('/v3/dataforseo_labs/google/serp_competitors/live');
      const rankedAvg  = await labsAvg('/v3/dataforseo_labs/google/ranked_keywords/live');
      const similarAvg = await labsAvg('/v3/dataforseo_labs/google/competitors_domain/live');

      const est = (calls: number, per: number | null) => ({
        calls,
        cost: per === null ? null : Number((calls * per).toFixed(4)),
        cost_known: per !== null,
      });
      const serpCalls    = clusterCount || 0;
      const rankedCalls  = Math.min(rankPending || 0, RANKED_PER_RUN);
      const similarCalls = SIMILAR_PER_RUN;

      const bal = await dfsBalance();
      return json({
        estimate_only: true,
        balance: bal.ok ? bal.balance : null,
        balance_error: bal.ok ? null : bal.error,
        rows_per_call: rowsPerCall,
        cost_per_call: Number(perCall.toFixed(6)),
        // v7.1 primary path
        serp:     est(serpCalls, serpAvg),
        ranked:   est(rankedCalls, rankedAvg),
        similar:  est(similarCalls, similarAvg),
        pipeline: {
          calls: serpCalls + rankedCalls + similarCalls,
          cost: [serpAvg, rankedAvg, similarAvg].every(v => v !== null)
            ? Number((serpCalls * serpAvg! + rankedCalls * rankedAvg!
                    + similarCalls * similarAvg!).toFixed(4))
            : null,
          cost_known: [serpAvg, rankedAvg, similarAvg].every(v => v !== null),
        },
        rank_pending: rankPending || 0,
        // v7 backlinks path, priced by the confirmed formula
        intersect: { calls: intersectCalls, cost: Number((intersectCalls * perCall).toFixed(4)), cost_known: true },
        broad:     { calls: broadCalls,     cost: Number((broadCalls * perCall).toFixed(4)), cost_known: true },
        anchors:   { calls: broadCalls * ANCHOR_PATTERNS_PER_RUN,
                     cost: Number((broadCalls * ANCHOR_PATTERNS_PER_RUN * perCall).toFixed(4)),
                     cost_known: true },
        both:      { calls: intersectCalls + broadCalls,
                     cost: Number(((intersectCalls + broadCalls) * perCall).toFixed(4)), cost_known: true },
        all:       { calls: serpCalls + rankedCalls + similarCalls
                          + intersectCalls + broadCalls * (1 + ANCHOR_PATTERNS_PER_RUN),
                     cost: null, cost_known: false },
      });
    }

    const bal = await dfsBalance();
    if (!bal.ok) { stats.reason = 'balance check failed: ' + bal.error; return json(stats, 502); }
    stats.balance_before = bal.balance;
    if (bal.balance < MIN_BALANCE_USD) {
      stats.reason = `balance $${bal.balance.toFixed(4)} below the $${MIN_BALANCE_USD} floor`;
      return json(stats);
    }
    stats.ran = true;

    // Effective budget: never plan to spend more than the account actually has.
    const cap = Math.min(budget, bal.balance - MIN_BALANCE_USD);
    // The guard takes the price of the NEXT call, because the backlinks formula
    // and the Labs tariff differ by enough that one number for both would
    // either stop the run early or overshoot the budget. Unknown Labs prices
    // are guessed high on purpose: overshooting spends real money, stopping
    // early only costs a run.
    const LABS_COST_GUESS = 0.05;
    const affordable = (estimate = perCall) => stats.spent + estimate <= cap;

    /** Average of what this account was actually billed for an endpoint. */
    const measuredCost = async (endpoint: string): Promise<number> => {
      const { data } = await supabase.from('dfs_usage')
        .select('cost_usd').eq('endpoint', endpoint).gt('cost_usd', 0)
        .order('created_at', { ascending: false }).limit(50);
      if (!data?.length) return LABS_COST_GUESS;
      const sum = data.reduce((s: number, r: any) => s + (Number(r.cost_usd) || 0), 0);
      return Math.max(sum / data.length, 0.001);
    };

    const { data: competitors } = await supabase.from('dfs_competitors')
      .select('id, domain, geo, priority, harvested_offset, total_ref_domains, anchor_cursor')
      .eq('active', true)
      .order('priority', { ascending: true });
    if (!competitors?.length) { stats.reason = 'no active competitors'; return json(stats); }

    const competitorSet = new Set(competitors.map((c: any) => normDomain(c.domain)));

    /** Shared post-processing: filter junk, count, hand to the upsert. */
    const ingest = async (rows: UpsertRow[]): Promise<number> => {
      stats.rows_seen += rows.length;
      const clean = rows.filter(r => {
        if (isJunk(r.domain, competitorSet)) { stats.junk_filtered++; return false; }
        return true;
      });
      const saved = await flush(clean);
      stats.saved += saved;
      return clean.length;
    };

    /** Shared post-processing for the Labs phases. Same junk gate as the
     *  backlinks path — the books themselves, our own group and the machine
     *  sites all rank for commercial queries too. */
    const ingestSerp = async (rows: SerpRow[]): Promise<number> => {
      stats.rows_seen += rows.length;
      const clean = rows.filter(r => {
        if (isJunk(r.domain, competitorSet)) { stats.junk_filtered++; return false; }
        return true;
      });
      const saved = await flushSerp(clean);
      stats.serp_saved += saved;
      stats.saved += saved;
      return clean.length;
    };

    // ── Phase S: serp_competitors — who owns the commercial SERP ──────────
    // The primary input. One cluster of commercial keywords per call; the API
    // answers with the domains that rank across them, their median position,
    // their estimated traffic and how much of the cluster each one covers.
    //
    // relevance > 0.5 is applied server-side and is the load-bearing filter:
    // it is what keeps Wikipedia and the national newspapers out of a list that
    // is supposed to be affiliates.
    if (want('serp')) {
      const serpCost = await measuredCost('/v3/dataforseo_labs/google/serp_competitors/live');
      const { data: clusters } = await supabase.from('dfs_keyword_clusters')
        .select('id, geo, location_code, language_code, keywords')
        .eq('active', true)
        .order('priority', { ascending: true });

      for (const c of clusters || []) {
        if (outOfTime())          { stats.reason = 'deadline during serp'; break; }
        if (!affordable(serpCost)) { stats.reason = 'budget spent during serp'; break; }

        const keywords = (c.keywords || []).slice(0, SERP_KEYWORDS_MAX);
        if (!keywords.length) continue;

        const r = await dfsCallTolerant('/v3/dataforseo_labs/google/serp_competitors/live', {
          keywords,
          location_code: c.location_code,
          language_code: c.language_code,
          limit: SERP_LIMIT,
        }, {
          order_by: ['etv,desc'],
          filters: [['relevance', '>', MIN_RELEVANCE]],
        }, c.geo);
        stats.calls += r.attempts;
        stats.spent += r.cost;
        if (r.dropped.length) dropNote('serp', r.dropped);
        if (!r.ok) { stats.reason = 'serp_competitors failed: ' + r.error; continue; }

        // One raw item, once per run — the only durable record of this
        // endpoint's actual shape, for the same reason the intersection phase
        // keeps one.
        if (!sampleLogged && r.items.length) {
          sampleLogged = true;
          await quiet(supabase.from('error_log').insert([{
            level: 'info', service: 'dfs-harvest',
            message: 'RAW serp_competitors item: ' + JSON.stringify(r.items[0]).slice(0, 1800),
          }]));
        }

        const rows: SerpRow[] = [];
        for (const it of r.items) {
          const domain = labsDomain(it);
          if (!domain) { stats.unparsed_items++; continue; }
          const rel = labsNum(it, 'relevance');
          // The server-side filter may have been peeled off as an invalid
          // field; enforce it here so a dropped clause cannot silently flood
          // the queue with generalists.
          if (rel !== null && rel <= MIN_RELEVANCE) { stats.junk_filtered++; continue; }
          rows.push({
            domain,
            source: 'serp_competitors',
            keyword_cluster: c.geo,
            etv: labsNum(it, 'etv'),
            median_position: labsNum(it, 'median_position', 'avg_position'),
            visibility: labsNum(it, 'visibility'),
            relevance: rel,
            keywords_matched: labsNum(it, 'keywords_count', 'count'),
          });
        }

        const kept = await ingestSerp(rows);
        stats.serp.push({ geo: c.geo, keywords: keywords.length, returned: r.items.length, kept });
        await quiet(supabase.from('dfs_keyword_clusters').update({
          last_run_at: new Date().toISOString(), domains_found: kept,
        }).eq('id', c.id));
        await sleep(300);
      }
    }

    // ── Phase R: ranked_keywords — the qualification filter ───────────────
    // For domains that came out of the SERP phases. Asks the only question
    // that separates a real property from a PBN node: how many commercial
    // keywords does it hold in the top 10, and do those keywords have any
    // search volume at all.
    //
    // Both filters are API-side and free, so a domain ranking for 500 zero-
    // volume keys comes back with an empty result rather than 500 paid rows.
    if (want('ranked')) {
      const rankedCost = await measuredCost('/v3/dataforseo_labs/google/ranked_keywords/live');
      const { data: pending } = await supabase.from('dfs_domains')
        .select('id, domain, keyword_cluster')
        .in('source', ['serp_competitors', 'competitors_domain'])
        .is('rank_checked_at', null)
        .neq('status', 'rejected')
        .order('etv', { ascending: false, nullsFirst: false })
        .limit(RANKED_PER_RUN);

      // Cluster geo → location/language, so a domain is profiled in the market
      // it was found in rather than in a default one.
      const { data: clusterRows } = await supabase.from('dfs_keyword_clusters')
        .select('geo, location_code, language_code');
      const clusterBy = new Map<string, { loc: number; lang: string }>();
      for (const c of clusterRows || []) {
        clusterBy.set(c.geo, { loc: c.location_code, lang: c.language_code });
      }

      for (const d of pending || []) {
        if (outOfTime())              { stats.reason = 'deadline during ranked'; break; }
        if (!affordable(rankedCost))  { stats.reason = 'budget spent during ranked'; break; }

        const cl = clusterBy.get(String(d.keyword_cluster || '')) || { loc: 2566, lang: 'en' };
        const r = await dfsCallTolerant('/v3/dataforseo_labs/google/ranked_keywords/live', {
          target: d.domain,
          location_code: cl.loc,
          language_code: cl.lang,
          limit: 200,
        }, {
          filters: [
            ['ranked_serp_element.serp_item.rank_group', '<', RANKED_MAX_POSITION],
            'and',
            ['keyword_data.keyword_info.search_volume', '>', RANKED_MIN_VOLUME],
          ],
          order_by: ['keyword_data.keyword_info.search_volume,desc'],
        }, d.domain);
        stats.calls += r.attempts;
        stats.spent += r.cost;
        if (r.dropped.length) dropNote('ranked', r.dropped);
        if (!r.ok) { stats.reason = 'ranked_keywords failed: ' + r.error; continue; }

        // If the server-side filters were peeled, apply them here — otherwise
        // a domain with 200 zero-volume keys would score as a professional.
        const filtersDropped = r.dropped.includes('filters');
        let commercial = 0, volume = 0, top3 = 0;
        for (const it of r.items) {
          const pos = num(it?.ranked_serp_element?.serp_item?.rank_group);
          const vol = num(it?.keyword_data?.keyword_info?.search_volume);
          if (filtersDropped) {
            if (pos === null || pos >= RANKED_MAX_POSITION) continue;
            if (vol === null || vol <= RANKED_MIN_VOLUME)   continue;
          }
          commercial++;
          volume += vol ?? 0;
          if (pos !== null && pos <= 3) top3++;
        }

        stats.ranked_checked++;
        if (commercial >= PRO_MIN_KEYWORDS && volume >= PRO_MIN_VOLUME) stats.ranked_professional++;

        await quiet(supabase.from('dfs_domains').update({
          commercial_keywords: commercial,
          total_search_volume: volume,
          top3_keywords: top3,
          rank_checked_at: new Date().toISOString(),
        }).eq('id', d.id));
        await sleep(300);
      }
    }

    // ── Phase C: competitors_domain — multiply what worked ────────────────
    // Every professional found is a seed: the domains competing with it for the
    // same SERP are, by construction, the same kind of business. This is the
    // self-sustaining half of the pipeline — each good find brings several more.
    if (want('similar')) {
      const similarCost = await measuredCost('/v3/dataforseo_labs/google/competitors_domain/live');
      const { data: seeds } = await supabase.from('dfs_domains')
        .select('id, domain, keyword_cluster, commercial_keywords, total_search_volume')
        .gte('commercial_keywords', PRO_MIN_KEYWORDS)
        .gte('total_search_volume', PRO_MIN_VOLUME)
        .is('similar_pulled_at', null)
        .order('total_search_volume', { ascending: false })
        .limit(SIMILAR_PER_RUN);

      const { data: clusterRows2 } = await supabase.from('dfs_keyword_clusters')
        .select('geo, location_code, language_code');
      const clusterBy2 = new Map<string, { loc: number; lang: string }>();
      for (const c of clusterRows2 || []) {
        clusterBy2.set(c.geo, { loc: c.location_code, lang: c.language_code });
      }

      for (const s of seeds || []) {
        if (outOfTime())               { stats.reason = 'deadline during similar'; break; }
        if (!affordable(similarCost))  { stats.reason = 'budget spent during similar'; break; }

        const cl = clusterBy2.get(String(s.keyword_cluster || '')) || { loc: 2566, lang: 'en' };
        const r = await dfsCallTolerant('/v3/dataforseo_labs/google/competitors_domain/live', {
          target: s.domain,
          location_code: cl.loc,
          language_code: cl.lang,
          limit: SIMILAR_LIMIT,
        }, {
          order_by: ['metrics.organic.etv,desc'],
        }, s.domain);
        stats.calls += r.attempts;
        stats.spent += r.cost;
        if (r.dropped.length) dropNote('similar', r.dropped);
        // Mark the seed regardless of outcome: a seed with no peers is an
        // answer, and retrying it every run would pay for that answer twice.
        await quiet(supabase.from('dfs_domains')
          .update({ similar_pulled_at: new Date().toISOString() }).eq('id', s.id));
        if (!r.ok) { stats.reason = 'competitors_domain failed: ' + r.error; continue; }

        const rows: SerpRow[] = [];
        for (const it of r.items) {
          const domain = labsDomain(it);
          if (!domain || domain === s.domain) { if (!domain) stats.unparsed_items++; continue; }
          rows.push({
            domain,
            source: 'competitors_domain',
            keyword_cluster: s.keyword_cluster || null,
            etv: labsNum(it, 'etv'),
            median_position: labsNum(it, 'median_position', 'avg_position'),
            visibility: labsNum(it, 'visibility'),
            relevance: labsNum(it, 'relevance'),
            keywords_matched: labsNum(it, 'count', 'keywords_count'),
          });
        }

        const kept = await ingestSerp(rows);
        stats.similar.push({ seed: s.domain, returned: r.items.length, kept });
        await sleep(300);
      }
    }

    // ── Phase A: intersections ────────────────────────────────────────────
    // The highest-precision signal available. A news site mentions one book
    // once; only an affiliate review site links to three at the same time.
    // Run WITHIN a geo — a Nigeria×Kenya intersection returns near-nothing.
    if (want('intersect')) {
      const byGeo = new Map<string, string[]>();
      for (const c of competitors) {
        const g = c.geo || '—';
        if (!byGeo.has(g)) byGeo.set(g, []);
        byGeo.get(g)!.push(normDomain(c.domain));
      }

      // Pagination state, one row per geo. Without this the call always sent
      // offset: 0 — every run, however many times it was pressed, re-bought the
      // exact same top page by rank. Those rows were already in dfs_domains and
      // already through dfs-qualify, so the upsert just touched existing rows:
      // DataForSEO charged for the call and the queue gained nothing new. That
      // is what a run reporting real spend and zero new domains actually was.
      const { data: intersectState } = await supabase
        .from('dfs_intersect_state').select('geo, harvested_offset, total_count');
      const offsetByGeo = new Map<string, { offset: number; total: number | null }>();
      for (const s of intersectState || []) {
        offsetByGeo.set(s.geo, { offset: Number(s.harvested_offset) || 0, total: s.total_count });
      }

      for (const [geo, domains] of byGeo) {
        if (outOfTime()) { stats.reason = 'deadline during intersections'; break; }
        if (!affordable()) { stats.reason = 'budget spent during intersections'; break; }
        // Intersection needs at least two targets to mean anything.
        if (domains.length < 2) continue;

        const st = offsetByGeo.get(geo) || { offset: 0, total: null };
        // Exhausted: this geo's intersection has already been walked to the end.
        if (st.total != null && st.offset >= st.total) continue;

        // Two targets, not three. A three-way intersection is a much smaller set
        // than a two-way one, and the first successful run returned total_count=0
        // for all three geos at three targets — including Nigeria, where
        // bet9ja + sportybet + betking must have affiliates in common. Linking to
        // two competitor books is already a signal nothing but an affiliate
        // produces, and it keeps the set large enough to be worth paying for.
        const targetList = domains.slice(0, INTERSECT_TARGETS); // priority-ordered
        const targets: Record<string, string> = {};
        targetList.forEach((d, i) => { targets[String(i + 1)] = d; });

        const label = geo + ':' + targetList.join('+');
        const base = {
          targets,
          limit: rowsPerCall,
          offset: st.offset,
          backlinks_status_type: 'live',
        };

        // No server-side `filters` here any more. It was accepted (so the
        // namespaced "1.rank" path is valid) yet the call still returned nothing,
        // which leaves the filter as the prime suspect for silently excluding
        // everything — a filter that matches nothing and a filter on a
        // misunderstood field look identical from outside. The MIN_RANK floor is
        // applied client-side below regardless, so dropping it costs a few
        // paid junk rows, not correctness.
        const r = await dfsCallTolerant('/v3/backlinks/domain_intersection/live', base, {
          order_by: ['1.rank,desc'],
        }, label);
        stats.calls += r.attempts;
        stats.spent += r.cost;
        if (r.dropped.length) dropNote('intersect', r.dropped);

        if (!r.ok) { stats.reason = 'intersection failed: ' + r.error; continue; }

        // Record ONE raw item verbatim, once per run. The docs host is blocked
        // by the same egress policy as the API, so this log line is the only
        // durable record of what this endpoint actually returns — without it the
        // response shape has to be re-guessed from row counts every time, which
        // has already cost three runs.
        if (!sampleLogged && r.items.length) {
          sampleLogged = true;
          await quiet(supabase.from('error_log').insert([{
            level: 'info', service: 'dfs-harvest',
            message: 'RAW intersection item: ' + JSON.stringify(r.items[0]).slice(0, 1800),
          }]));
        }

        // Every domain here links to all targets, so it is emitted once per
        // competitor — the RPC merges them into one row with intersect_count=N.
        const rows: UpsertRow[] = [];
        for (const it of r.items) {
          const flat = flattenIntersectionItem(it);
          if (!flat) { stats.unparsed_items++; continue; }
          // Enforce the rank floor here too: the server-side filter was removed
          // from this call, so nothing else keeps scraper junk out.
          if (flat.rank !== null && flat.rank <= MIN_RANK) { stats.junk_filtered++; continue; }
          for (const comp of targetList) {
            rows.push({
              domain: flat.domain, source: 'intersection', competitor: comp,
              dfs_rank: flat.rank,
              spam_score: flat.spam,
              backlinks_count: flat.backlinks,
              referring_pages: flat.referringPages,
              anchor: null, page_title: null,
              first_seen: flat.firstSeen,
            });
          }
        }
        const kept = await ingest(rows);
        // total_count is what the API says the intersection HOLDS, before our
        // limit and before any client-side filtering. Reporting it separates
        // "the intersection is genuinely empty" from "we filtered it away" —
        // indistinguishable otherwise, and the difference decides whether the
        // targets are wrong or the query is.
        stats.intersections.push({ geo, targets: targetList, found: kept,
                                   returned: r.items.length, total: r.totalCount });

        // Advance by what the API returned, not by the limit requested — same
        // rule as the broad phase: a short page means this geo's intersection
        // ended, and running the offset past it would skip real rows next time.
        await quiet(supabase.from('dfs_intersect_state').upsert({
          geo,
          harvested_offset: st.offset + r.items.length,
          total_count: r.totalCount || st.total,
          last_harvest_at: new Date().toISOString(),
        }, { onConflict: 'geo' }));
        await sleep(300);
      }
    }

    // ── Phase B: broad referring-domain pull ──────────────────────────────
    // Volume. Resumes from harvested_offset so successive runs walk deeper
    // instead of re-buying the same first page.
    if (want('broad')) {
      for (const c of competitors) {
        if (outOfTime()) { stats.reason = 'deadline during broad pull'; break; }
        if (!affordable()) { stats.reason = 'budget spent during broad pull'; break; }

        const domain = normDomain(c.domain);
        const offset = Number(c.harvested_offset) || 0;
        // Exhausted: pagination already passed the profile's size.
        if (c.total_ref_domains && offset >= c.total_ref_domains) continue;

        const r = await dfsCallTolerant('/v3/backlinks/referring_domains/live', {
          target: domain,
          limit: rowsPerCall,
          offset,
          internal_list_limit: 10,
          backlinks_status_type: 'live',
          include_subdomains: true,
          exclude_internal_backlinks: true,
        }, {
          order_by: ['rank,desc'],
          filters: [['rank', '>', MIN_RANK]],
        }, domain);
        stats.calls += r.attempts;
        stats.spent += r.cost;
        if (r.dropped.length) dropNote('broad', r.dropped);
        if (!r.ok) { stats.reason = 'referring_domains failed: ' + r.error; continue; }

        const rows: UpsertRow[] = r.items.map((it: any) => ({
          domain: normDomain(it?.domain || ''),
          source: 'referring_domains',
          competitor: domain,
          dfs_rank: num(it?.rank),
          spam_score: num(it?.backlinks_spam_score),
          backlinks_count: num(it?.backlinks),
          referring_pages: num(it?.referring_pages),
          anchor: null, page_title: null,
          first_seen: str(it?.first_seen, 40),
        })).filter((x: UpsertRow) => x.domain
          // Same reason as the intersection phase: on the fallback path the API
          // applied no rank filter, so enforce the floor here.
          && !(x.dfs_rank !== null && x.dfs_rank <= MIN_RANK));

        const kept = await ingest(rows);
        stats.broad.push({
          competitor: domain, found: kept,
          offset: offset + r.items.length, total: r.totalCount,
        });

        await quiet(supabase.from('dfs_competitors').update({
          // Advance by what the API returned, not by the limit we asked for —
          // a short page means the profile ended and the offset must not run
          // past it or the next run skips real rows.
          harvested_offset: offset + r.items.length,
          total_ref_domains: r.totalCount || c.total_ref_domains,
          last_harvest_at: new Date().toISOString(),
        }).eq('id', c.id));
        await sleep(300);
      }
    }

    // ── Phase A2: backlinks, filtered on ANCHOR TEXT ──────────────────────
    // The v7 version of this phase asked for every dofollow link the book had
    // and sorted by rank. That is how the queue filled with scrapers: rank
    // measures the linking domain's authority, and a high-authority news site
    // linking once is still not an affiliate.
    //
    // The affiliate signal is in the anchor, not the domain. "Bet9ja promo
    // code" is an affiliate placement; the company name or a bare URL is a
    // mention. So each pattern is now its own request with an API-side
    // `anchor like` filter, and filters are free — we pay only for rows that
    // already read as affiliate placements.
    //
    // One pattern per call means 12 calls per competitor, so each competitor
    // keeps a cursor and a run advances it by ANCHOR_PATTERNS_PER_RUN. Without
    // the cursor every run would re-buy '%promo code%' and never reach the rest
    // — the same bug the intersection phase had with offset: 0.
    if (want('anchors')) {
      for (const c of competitors) {
        if (outOfTime()) { stats.reason = 'deadline during anchor pass'; break; }
        if (!affordable()) { stats.reason = 'budget spent during anchor pass'; break; }

        const domain = normDomain(c.domain);
        const cursor = Number(c.anchor_cursor) || 0;
        let used = 0;

        for (let k = 0; k < ANCHOR_PATTERNS_PER_RUN; k++) {
          if (outOfTime() || !affordable()) break;
          const pattern = ANCHOR_PATTERNS[(cursor + k) % ANCHOR_PATTERNS.length];

          const r = await dfsCallTolerant('/v3/backlinks/backlinks/live', {
            target: domain,
            limit: rowsPerCall,
            mode: 'one_per_domain',     // one link per donor — don't pay for dupes
            backlinks_status_type: 'live',
          }, {
            filters: [
              ['dofollow', '=', true],
              'and',
              ['anchor', 'like', pattern],
            ],
            order_by: ['rank,desc'],
          }, `${domain} ${pattern}`);
          stats.calls += r.attempts;
          stats.spent += r.cost;
          used++;
          if (r.dropped.length) dropNote('anchors', r.dropped);
          if (!r.ok) { stats.reason = 'backlinks failed: ' + r.error; continue; }

          // If the API refused the filter clause we are back to paying for
          // unfiltered links, so apply the pattern here rather than let the
          // phase quietly revert to its v7 behaviour.
          const anchorRe = new RegExp(
            pattern.replace(/%/g, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
          const filtersDropped = r.dropped.includes('filters');

          const rows: UpsertRow[] = r.items.map((it: any) => ({
            domain: normDomain(it?.domain_from || ''),
            source: 'anchor_match',
            competitor: domain,
            dfs_rank: num(it?.rank ?? it?.domain_from_rank),
            spam_score: num(it?.backlink_spam_score),
            backlinks_count: null,
            referring_pages: null,
            anchor: str(it?.anchor, 500),
            page_title: str(it?.page_from_title, 500),
            first_seen: str(it?.first_seen, 40),
          })).filter((x: UpsertRow) => x.domain
            && (!filtersDropped || (x.anchor ? anchorRe.test(x.anchor) : false)));

          const withAnchor = rows.filter(x => x.anchor).length;
          const kept = await ingest(rows);
          stats.anchors_filled += withAnchor;
          stats.anchors.push({ competitor: domain, pattern, returned: r.items.length, kept });
          await sleep(300);
        }

        if (used) {
          await quiet(supabase.from('dfs_competitors').update({
            anchor_cursor: (cursor + used) % ANCHOR_PATTERNS.length,
            last_harvest_at: new Date().toISOString(),
          }).eq('id', c.id));
        }
      }
    }

    const after = await dfsBalance();
    if (after.ok) stats.balance_after = after.balance;

    await quiet(supabase.from('error_log').insert([{
      level: 'info', service: 'dfs-harvest',
      message: `mode=${mode} calls=${stats.calls} spent=$${stats.spent.toFixed(4)} `
        + `seen=${stats.rows_seen} junk=${stats.junk_filtered} saved=${stats.saved} `
        + `serp=${stats.serp_saved} ranked=${stats.ranked_checked} `
        + `pro=${stats.ranked_professional} similar=${stats.similar.length} `
        + `anchors=${stats.anchors_filled} balance=$${(stats.balance_after ?? 0).toFixed(4)} `
        + (Object.keys(stats.dropped_fields).length
            ? `dropped=${JSON.stringify(stats.dropped_fields)} ` : '')
        + stats.reason,
    }]));

    return json(stats);
  } catch (e: any) {
    stats.error = String(e?.message || e);
    await quiet(supabase.from('error_log').insert([{
      level: 'critical', service: 'dfs-harvest', message: stats.error,
    }]));
    return json(stats, 500);
  }
});
