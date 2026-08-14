// Supabase Edge Function: brand-search
// ════════════════════════════════════════════════════════════════════════════
// Stage 1 of the BRAND pipeline (v8): find sites intercepting brand traffic.
//
// WHY THIS WORKS
// Someone searching "mostbet apk" or "bet9ja app download" has already picked a
// brand. They are not comparing bookmakers, they are going to install one — the
// intent is maximal and nobody needs warming up. A partner in Uzbekistan does
// 35 000 FTD a month on APK traffic alone.
//
// And the search results are self-filtering. Position 1 on a brand query is
// almost always the operator itself; positions 2-50 are almost exclusively
// affiliates intercepting that traffic. News sites, blogs and stats services do
// not rank there — they have no reason to. So the SERP for a competitor's brand
// queries IS a ready-made list of brand-traffic partners, and the filtering is
// done by Google rather than by us. That is the opposite of the main keyword
// pipeline, where page one is picked clean and the noise ratio is brutal.
//
// SELECTION RULE
// Write to everyone EXCEPT official operator domains. Affiliates pushing
// Melbet / 22bet / BetWinner / Megapari / Paripesa / Linebet are TARGETS, not
// exclusions — formally separate brands, and we offer such a partner 1xBet on
// the strength of the product's higher LTV.
//
// The block is an EXPLICIT LIST (official_domains), never a heuristic. This is
// not a stylistic preference: 1win.fyi is an affiliate and 1win.com is the
// operator, and the brand name occupies the second-level domain identically in
// both. Any pattern match either lets operators through or throws away the best
// targets in the module.
//
// DUCKDUCKGO BUDGET — READ BEFORE RAISING ANY CONSTANT HERE
// This function shares one egress IP with find-and-queue. Tripling the request
// rate to DDG once already killed the whole feed for two days: every query
// started returning an empty page and lead intake stopped. So this runs on a
// tick that find-and-queue never uses, keeps its own volume small, and honours
// the SAME source_health throttle — when DDG starts degrading, both back off
// together, because the thing being protected is the shared IP, not either
// function's own quota.
//
// Deploy: supabase functions deploy brand-search --no-verify-jwt
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GROQ_API_KEY (+GROQ_KEY_2/3),
//      BRAND_KW_PER_RUN (optional), BRAND_PAGES (optional)

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const GROQ_KEYS = [
  Deno.env.get('GROQ_API_KEY') || '',
  Deno.env.get('GROQ_KEY_2')   || '',
  Deno.env.get('GROQ_KEY_3')   || '',
].filter(Boolean);

const TIME_BUDGET_MS = 110_000;
// Keywords per run and pages per keyword. Deliberately small — see the
// DuckDuckGo budget note above. 2 × 2 is ~4 requests per run, and at one run
// per 9 minutes that is ~27 requests/hour on top of find-and-queue's ~47.
// The ban happened at roughly three times the combined figure, so there is
// headroom, but not enough to raise these without watching source_health after.
const KW_PER_RUN = Math.max(1, Math.min(6, parseInt(Deno.env.get('BRAND_KW_PER_RUN') || '2', 10) || 2));
const PAGES      = Math.max(1, Math.min(3, parseInt(Deno.env.get('BRAND_PAGES') || '2', 10) || 2));
const RESULTS_PER_PAGE = 15;
// Brand SERPs are clean, so a thin page with a referral link is still worth
// having. 25, not the main pipeline's 35.
const MIN_SCORE   = 25;
const GROQ_BATCH  = 8;
// 15s, not 12s. With max_tokens now sized to the batch a request reserves
// ~2100 tokens, so four per minute sits under the 6000/minute free tier with
// room for the other functions sharing these keys (find-and-queue, dfs-qualify,
// draft-tg-message all draw on the same three).
const GROQ_PACE_MS = 15_000;

// Runs every 3rd tick like find-and-queue, but on a DIFFERENT residue so the
// two never hit DuckDuckGo in the same minute. find-and-queue uses 0.
const TICK_RESIDUE = 1;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function quiet(p: PromiseLike<unknown>): Promise<void> {
  try { await p; } catch { /* bookkeeping is best-effort */ }
}

// ── Domain helpers ──────────────────────────────────────────────────────────
function getDomain(url: string): string {
  try {
    return new URL(url.startsWith('http') ? url : 'https://' + url).hostname.toLowerCase();
  } catch { return ''; }
}
function normalizeDomain(url: string): string {
  return getDomain(url).replace(/^www\./, '');
}

// TLDs we never sell into, plus institutional zones.
const SKIP_TLD = ['.gov', '.edu', '.mil', '.ru', '.by', '.ua'];
// Platforms that rank for anything and are never a partner.
const GLOBAL_SKIP = new Set([
  'google.com', 'youtube.com', 'facebook.com', 'twitter.com', 'x.com',
  'instagram.com', 'reddit.com', 'wikipedia.org', 'amazon.com', 't.me',
  'telegram.org', 'linkedin.com', 'tiktok.com', 'pinterest.com', 'quora.com',
  'play.google.com', 'apps.apple.com', 'apkpure.com', 'apkmirror.com',
  'apkcombo.com', 'uptodown.com', 'softonic.com', 'medium.com', 'github.com',
  'blogspot.com', 'wordpress.com', 'archive.org', 'trustpilot.com',
]);

// ── DuckDuckGo (same hardening as find-and-queue) ───────────────────────────
// Copied rather than imported: edge functions deploy as standalone files. The
// behaviour must stay identical to find-and-queue's, because both are judged by
// the same shared soft-ban detector.
const BROWSER_UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
];
const ACCEPT_LANGS = ['en-US,en;q=0.9', 'en-GB,en;q=0.9', 'en-US,en;q=0.9,fr;q=0.8'];

interface DdgSession {
  ua: string; acceptLang: string; vqd: Map<string, string>;
  requests: number; emptyResponses: number; resultsTotal: number;
}
function makeSession(): DdgSession {
  return {
    ua: BROWSER_UAS[Math.floor(Math.random() * BROWSER_UAS.length)],
    acceptLang: ACCEPT_LANGS[Math.floor(Math.random() * ACCEPT_LANGS.length)],
    vqd: new Map(), requests: 0, emptyResponses: 0, resultsTotal: 0,
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
const jitter = (minMs = 2500, maxMs = 7000) =>
  new Promise(r => setTimeout(r, minMs + Math.floor(Math.random() * (maxMs - minMs))));

function extractVqd(html: string): string {
  const m1 = html.match(/name=["']vqd["'][^>]*value=["']([^"']+)["']/i)
    || html.match(/value=["']([^"']+)["'][^>]*name=["']vqd["']/i);
  if (m1) return m1[1];
  const m2 = html.match(/vqd\s*[=:]\s*['"]([^'"]+)['"]/);
  return m2 ? m2[1] : '';
}

function parseDdgHtml(html: string, num: number): Array<{ link: string; title: string; snippet: string }> {
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

async function searchDuckDuckGo(
  query: string, num: number, page: number, s: DdgSession,
): Promise<Array<{ link: string; title: string; snippet: string }>> {
  const baseUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  s.requests++;
  const record = (r: Array<{ link: string; title: string; snippet: string }>) => {
    s.resultsTotal += r.length;
    if (!r.length) s.emptyResponses++;
    return r;
  };

  let html1 = '';
  let vqd = s.vqd.get(query) || '';
  if (page === 1 || !vqd) {
    try {
      const res = await fetch(baseUrl, { headers: ddgHeaders(s), signal: AbortSignal.timeout(12_000) });
      if (res.ok) html1 = await res.text();
      else res.body?.cancel().catch(() => {});
    } catch { /* fall through */ }
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
      headers: { ...ddgHeaders(s), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) { res.body?.cancel().catch(() => {}); return record([]); }
    const paged = parseDdgHtml(await res.text(), num);
    // A rejected POST comes back near-empty. Returning page 1 again would
    // double-count the same domains as if they were deeper results, so report
    // nothing instead — the health counter should see this as the thin page it is.
    return record(paged.length >= 3 ? paged : []);
  } catch { return record([]); }
}

// ── Shared soft-ban state ───────────────────────────────────────────────────
// Same 'ddg' source key as find-and-queue, on purpose: the resource being
// protected is one egress IP, so a degradation caused by either function must
// stop both.
async function isThrottled(source: string): Promise<Date | null> {
  try {
    const { data } = await supabase.from('source_health')
      .select('throttled, throttle_until').eq('source', source)
      .order('window_start', { ascending: false }).limit(1).maybeSingle();
    if (!data?.throttled || !data?.throttle_until) return null;
    const until = new Date(data.throttle_until);
    return until.getTime() > Date.now() ? until : null;
  } catch { return null; }
}

const HEALTHY_AVG = 5;
async function recordHealth(source: string, s: DdgSession): Promise<boolean> {
  if (!s.requests) return false;
  const avg = s.resultsTotal / s.requests;
  const degraded = s.requests >= 3 && avg < HEALTHY_AVG;
  const until = degraded ? new Date(Date.now() + 45 * 60 * 1000).toISOString() : null;
  try {
    await supabase.from('source_health').insert([{
      source, requests: s.requests, results_total: s.resultsTotal,
      empty_results: s.emptyResponses, avg_results: Number(avg.toFixed(2)),
      throttled: degraded, throttle_until: until,
    }]);
    if (degraded) {
      await supabase.from('error_log').insert([{
        level: 'warning', service: 'brand-search',
        message: `${source} degraded: ${avg.toFixed(1)} results/request over ${s.requests} requests `
          + `(${s.emptyResponses} empty) — backing off until ${until}`,
      }]);
    }
  } catch { /* health tracking must never break the run */ }
  return degraded;
}

// ── Groq ────────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are an analyst for a betting affiliate program (1xBet).

Each item below was found in search results for a BRAND query — someone searching
for a specific bookmaker's app, mirror or download page. Sites ranking for these
queries are almost always AFFILIATES intercepting that brand traffic.

Brand-traffic affiliates are our PRIMARY TARGET. They send high-intent users who
already decided to play.

We WANT: mirror sites, APK/download portals, brand review pages, landing pages
with referral links, any site that captures brand traffic and monetises it.

We do NOT want: the operator's own official website, app stores (Google Play,
App Store), Wikipedia, forums, news portals, streaming sites.

For EACH item return one JSON object, keyed back to the item by its "i" index:

{
  "i": 0,
  "score": 0-100,
  "traffic_type": "brand_mirror" | "apk_portal" | "review_page" | "aggregator" | "operator" | "other",
  "is_operator": false,
  "brand_promoted": "",
  "promotes_1xbet": false,
  "has_download": false,
  "monetization_signal": false,
  "geo": "",
  "lang": "",
  "relevant": true,
  "summary": "max 12 words"
}

RULES:
- relevant = true if is_operator = false AND traffic_type != "aggregator"
- A mirror or APK page for a COMPETITOR brand is a strong target: relevant = true
- Sites promoting Melbet, 22bet, BetWinner, Megapari, Paripesa, Linebet are
  VALID TARGETS — treat them like any other competitor affiliate
- is_operator = true ONLY for the bookmaker's own official website
- promotes_1xbet = true does NOT make it irrelevant; flag it and let the system decide

Return ONLY JSON shaped {"results":[...]}. No prose, no markdown.`;

let groqKeyIdx = 0;
let groqLastError = '';
let groqCount = 0;

async function groqChat(user: string, itemCount: number): Promise<string | null> {
  const n = GROQ_KEYS.length;
  if (!n) { groqLastError = 'no GROQ key configured'; return null; }
  const body = {
    model: 'llama-3.1-8b-instant',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: user },
    ],
    temperature: 0.1,
    // Sized to the batch, not fixed — and this is the whole ballgame on the
    // free tier. Groq reserves max_tokens against a 6000 tokens/minute budget
    // whether the answer uses them or not, so a flat 4096 plus the prompt put
    // ONE request at the per-minute ceiling: every request after it in the
    // same minute came back 429. Measured cost of that: 257 sites found across
    // six runs, 14 saved, three runs analysing literally nothing.
    // A verdict is ~55 tokens of JSON; 110 per item is a comfortable double.
    // find-and-queue has done it this way all along (130 * cands.length + 100).
    max_tokens: 110 * itemCount + 120,
    response_format: { type: 'json_object' },
  };
  // Two rounds with a pause: the keys are shared across the whole pipeline, so
  // all three being momentarily over their per-minute cap is normal and passes
  // within a second or two. Losing the run's material to that is not.
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
          signal: AbortSignal.timeout(25_000),
        });
        if (res.status === 429 || res.status >= 500) {
          groqLastError = `HTTP ${res.status} (key ${idx + 1}, round ${round + 1})`;
          res.body?.cancel().catch(() => {});
          continue;
        }
        if (!res.ok) {
          groqLastError = `HTTP ${res.status}: ${(await res.text()).slice(0, 150)}`;
          return null;
        }
        const d = await res.json();
        groqKeyIdx = (idx + 1) % n;
        return d?.choices?.[0]?.message?.content || '';
      } catch (e: any) {
        groqLastError = e?.message || 'fetch error';
      }
    }
  }
  groqKeyIdx = (groqKeyIdx + 1) % n;
  return null;
}

interface Verdict {
  score: number; traffic_type: string; is_operator: boolean;
  brand_promoted: string; promotes_1xbet: boolean; has_download: boolean;
  monetization_signal: boolean; geo: string; lang: string;
  relevant: boolean; summary: string;
}

interface Candidate {
  url: string; domain: string; title: string; snippet: string;
  position: number; keyword: string; keywordId: number;
  brand: string; geo: string; lang: string;
}

async function judge(batch: Candidate[]): Promise<Map<number, Verdict>> {
  const out = new Map<number, Verdict>();
  if (!batch.length) return out;
  const user = batch.map((c, i) =>
    `${i}. url: ${c.url}\n`
    + `   found_for_query: "${c.keyword}" (brand: ${c.brand}, position ${c.position})\n`
    + `   title: ${(c.title || '—').slice(0, 180)}\n`
    + `   snippet: ${(c.snippet || '—').slice(0, 220)}`,
  ).join('\n\n');

  const raw = await groqChat(user, batch.length);
  if (!raw) return out;
  try {
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim().match(/\{[\s\S]*\}/)?.[0] || raw);
    const results: any[] = Array.isArray(parsed?.results) ? parsed.results
                         : Array.isArray(parsed) ? parsed : [];
    for (const v of results) {
      const i = Number(v?.i);
      if (!Number.isInteger(i) || i < 0 || i >= batch.length || out.has(i)) continue;
      out.set(i, {
        score: Math.max(0, Math.min(100, Number(v.score) || 0)),
        traffic_type: String(v.traffic_type || 'other').slice(0, 30),
        is_operator: !!v.is_operator,
        brand_promoted: String(v.brand_promoted || '').slice(0, 60),
        promotes_1xbet: !!v.promotes_1xbet,
        has_download: !!v.has_download,
        monetization_signal: !!v.monetization_signal,
        geo: String(v.geo || '').slice(0, 8).toUpperCase(),
        lang: String(v.lang || '').slice(0, 8),
        relevant: v.relevant === undefined ? true : !!v.relevant,
        summary: String(v.summary || '').slice(0, 300),
      });
    }
  } catch { /* unparseable batch — those candidates are simply skipped */ }
  return out;
}

// ── Main ────────────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const stats = {
    keywords_run: 0, found: 0, official_blocked: 0, dedup: 0, skipped_platform: 0,
    analyzed: 0, operators: 0, irrelevant: 0, low_score: 0,
    saved: 0, occupied: 0, suspected: 0, reason: '',
  };
  const json = (s: unknown, code = 200) => new Response(JSON.stringify(s),
    { status: code, headers: { ...cors, 'Content-Type': 'application/json' } });

  const startedAt = Date.now();
  const deadline  = startedAt + TIME_BUDGET_MS;
  const body: any = await req.json().catch(() => ({}));

  // Own tick, never find-and-queue's. `force` exists for manual runs from the
  // interface, which must not have to wait up to nine minutes to prove a change.
  const tick = Math.floor(Date.now() / (3 * 60 * 1000));
  if (!body.force && tick % 3 !== TICK_RESIDUE) {
    return json({ skipped: true, reason: 'throttled — brand search runs ~every 9 min, offset from find-and-queue' });
  }

  // One run per tick, whoever asks. The logs caught two full runs starting one
  // second apart (09:58:23 and 09:58:24) — the external scheduler fired
  // find-and-queue twice inside the same three-minute bucket, and each handed
  // off. That doubles the draw on both shared budgets at once: the Groq
  // per-minute tokens and the DuckDuckGo egress IP, which are exactly the two
  // things this pipeline is rationed against. `force` skips the tick gate but
  // not this: a manual run from the interface should still not collide with a
  // scheduled one.
  try {
    const { data: claimed } = await supabase.from('app_state')
      .select('value').eq('key', 'brand_search_tick').maybeSingle();
    if (String(claimed?.value || '') === String(tick)) {
      return json({ skipped: true, reason: `tick ${tick} already claimed by a concurrent run` });
    }
    await supabase.from('app_state').upsert(
      { key: 'brand_search_tick', value: String(tick), updated_at: new Date().toISOString() },
      { onConflict: 'key' },
    );
  } catch { /* if app_state is unavailable, a duplicate run is better than none */ }

  try {
    if (!GROQ_KEYS.length) { stats.reason = 'no LLM key configured'; return json(stats, 400); }

    const throttledUntil = await isThrottled('ddg');
    if (throttledUntil) {
      stats.reason = `DuckDuckGo backing off until ${throttledUntil.toISOString()}`;
      return json({ ...stats, skipped: true });
    }

    // ── Pick keywords: strict least-recently-run rotation ─────────────────
    // NULLS FIRST means never-run keywords go first, so a freshly generated
    // pool is worked through before anything is repeated. This is the property
    // the main pipeline's layer A lacked, which is how it ended up re-searching
    // the same five queries indefinitely.
    const { data: kwRows } = await supabase.from('brand_keywords')
      // runs/urls_found/leads_created are selected because they are incremented
      // below. Without them in the projection every update would write 0+1 and
      // the per-keyword yield stats — the only evidence for retiring a burnt
      // modifier — would permanently read 1.
      .select('id, keyword, lang, brand_target_id, runs, urls_found, leads_created, '
            + 'brand_targets!inner(brand, geo, priority, active)')
      .eq('active', true)
      .eq('brand_targets.active', true)
      .order('last_run_at', { ascending: true, nullsFirst: true })
      .limit(KW_PER_RUN * 4);

    if (!kwRows?.length) { stats.reason = 'no active brand keywords — run brand_generate_keywords()'; return json(stats); }

    // Priority 1 markets first within the least-recently-run window: UZ, NG,
    // KE, GH, CM, SN and BD are where the confirmed cases are.
    const picked = [...kwRows]
      .sort((a: any, b: any) => (a.brand_targets?.priority ?? 5) - (b.brand_targets?.priority ?? 5))
      .slice(0, KW_PER_RUN);

    // ── Dedup sets ────────────────────────────────────────────────────────
    const { data: officialRows } = await supabase.from('official_domains').select('domain');
    const official = new Set((officialRows || []).map((r: any) => String(r.domain).toLowerCase()));

    const { data: leadRows } = await supabase.from('leads')
      .select('domain_normalized').not('domain_normalized', 'is', null)
      .order('created_at', { ascending: false }).limit(10000);
    const known = new Set((leadRows || [])
      .map((l: any) => String(l.domain_normalized || '').toLowerCase()).filter(Boolean));

    const { data: sentRows } = await supabase.from('email_log').select('email');
    const emailedDomains = new Set((sentRows || [])
      .map((r: any) => String(r.email || '').toLowerCase().split('@')[1] || '').filter(Boolean));

    const { data: blRows } = await supabase.from('blacklist').select('value');
    const blacklist = new Set((blRows || []).map((r: any) => String(r.value || '').toLowerCase()));

    // ── Search ────────────────────────────────────────────────────────────
    const session = makeSession();
    const candidates: Candidate[] = [];
    const seenThisRun = new Set<string>();

    for (const kw of picked as any[]) {
      if (Date.now() > deadline) { stats.reason = 'deadline during search'; break; }
      const t = kw.brand_targets || {};
      stats.keywords_run++;
      let urlsForKw = 0;

      for (let page = 1; page <= PAGES; page++) {
        if (Date.now() > deadline) break;
        if (page > 1 || stats.keywords_run > 1) await jitter();

        // Minus words are barely needed here — the SERP is self-filtered. Only
        // the platforms that rank for everything are worth excluding, and
        // YouTube is left out because it is its own branch, not noise.
        const query = `${kw.keyword} -wikipedia -reddit -quora -youtube`;
        const results = await searchDuckDuckGo(query, RESULTS_PER_PAGE, page, session);
        stats.found += results.length;
        urlsForKw += results.length;

        results.forEach((r, idx) => {
          const domain = normalizeDomain(r.link);
          if (!domain) return;
          // Position across pages, so "position 2" means what it says even when
          // the result came off page 2. This number is a direct proxy for how
          // much brand traffic the site actually intercepts.
          const position = (page - 1) * RESULTS_PER_PAGE + idx + 1;

          if (official.has(domain))       { stats.official_blocked++; return; }
          if (GLOBAL_SKIP.has(domain))    { stats.skipped_platform++; return; }
          if (SKIP_TLD.some(t2 => domain.endsWith(t2))) { stats.skipped_platform++; return; }
          if (blacklist.has(domain))      { stats.skipped_platform++; return; }
          if (known.has(domain))          { stats.dedup++; return; }
          if (emailedDomains.has(domain)) { stats.dedup++; return; }
          if (seenThisRun.has(domain))    return;
          seenThisRun.add(domain);

          candidates.push({
            url: r.link, domain, title: r.title, snippet: r.snippet,
            position, keyword: kw.keyword, keywordId: kw.id,
            brand: t.brand || '', geo: t.geo || '', lang: kw.lang || '',
          });
        });
      }

      await quiet(supabase.from('brand_keywords').update({
        last_run_at: new Date().toISOString(),
        runs: (kw.runs ?? 0) + 1,
        urls_found: (kw.urls_found ?? 0) + urlsForKw,
      }).eq('id', kw.id));
    }

    const degraded = await recordHealth('ddg', session);
    if (degraded) stats.reason = 'ddg degraded — backing off';

    if (!candidates.length) {
      stats.reason = stats.reason || 'no new domains this run';
      await quiet(supabase.from('error_log').insert([{
        level: 'info', service: 'brand-search',
        message: `kw=${stats.keywords_run} found=${stats.found} official=${stats.official_blocked} `
          + `dedup=${stats.dedup} saved=0 ${stats.reason}`,
      }]));
      return json(stats);
    }

    // ── Qualify ───────────────────────────────────────────────────────────
    let lastGroqMs = 0;
    const leadsPerKeyword = new Map<number, number>();

    for (let bi = 0; bi < candidates.length; bi += GROQ_BATCH) {
      if (Date.now() > deadline) { stats.reason = 'deadline during qualification'; break; }
      const batch = candidates.slice(bi, bi + GROQ_BATCH);

      const since = Date.now() - lastGroqMs;
      if (since < GROQ_PACE_MS) await new Promise(r => setTimeout(r, GROQ_PACE_MS - since));
      if (Date.now() > deadline) break;
      lastGroqMs = Date.now();

      const verdicts = await judge(batch);

      for (let j = 0; j < batch.length; j++) {
        const c = batch[j];
        const v = verdicts.get(j);
        if (!v) continue;
        stats.analyzed++;

        // The operator's own site is the one thing this pipeline must never
        // contact. official_domains already caught the known ones; this is the
        // model's read on the rest.
        if (v.is_operator)  { stats.operators++; continue; }
        if (!v.relevant)    { stats.irrelevant++; continue; }
        if (v.score < MIN_SCORE) { stats.low_score++; continue; }

        // A site already pushing 1xBet with a promo code belongs to another
        // manager. Not deleted — flagged, and kept out of automatic sending so
        // a human decides.
        const occupied = v.promotes_1xbet;

        const leadData: Record<string, unknown> = {
          url: c.url,
          name: c.domain,
          brand: '1xbet',
          stage: 'new',
          pipeline: 'brand',
          source: 'brand',
          domain_normalized: c.domain,
          geo: c.geo || v.geo || null,
          lang: c.lang || v.lang || null,
          type: v.traffic_type,
          score: v.score,
          summary: v.summary || null,
          found_keyword: c.keyword,
          brand_keyword_id: c.keywordId,
          brand_found: c.brand || v.brand_promoted || null,
          serp_position: c.position,
          traffic_type: v.traffic_type,
          has_apk: v.has_download || null,
          monetization_signal: v.monetization_signal,
          competitor_book: v.brand_promoted || c.brand || null,
          exclude_reason: occupied ? 'occupied' : null,
        };

        const { error: insErr } = await supabase.from('leads').insert([leadData]);
        if (insErr) {
          // Unique violation = another pipeline saved this domain first. That
          // is the dedup working, not a failure.
          if (!/duplicate key|unique constraint/i.test(insErr.message || '')) {
            stats.reason = 'insert: ' + insErr.message;
          }
          continue;
        }
        stats.saved++;
        if (occupied) stats.occupied++;
        leadsPerKeyword.set(c.keywordId, (leadsPerKeyword.get(c.keywordId) || 0) + 1);
        known.add(c.domain);
      }
    }

    // Per-keyword yield, so a burnt-out brand or modifier can be retired on
    // evidence rather than on impression.
    for (const [kwId, n] of leadsPerKeyword) {
      const row = (picked as any[]).find(k => k.id === kwId);
      await quiet(supabase.from('brand_keywords')
        .update({ leads_created: (row?.leads_created ?? 0) + n }).eq('id', kwId));
    }

    await quiet(supabase.from('error_log').insert([{
      level: 'info', service: 'brand-search',
      message: `kw=${stats.keywords_run} found=${stats.found} official=${stats.official_blocked} `
        + `dedup=${stats.dedup} analyzed=${stats.analyzed} operators=${stats.operators} `
        + `saved=${stats.saved} occupied=${stats.occupied} groqCalls=${groqCount} `
        + (groqLastError ? `groqErr="${groqLastError}" ` : '')
        + stats.reason,
    }]));

    return json(stats);
  } catch (e: any) {
    await quiet(supabase.from('error_log').insert([{
      level: 'critical', service: 'brand-search', message: String(e?.message || e),
    }]));
    return json({ ...stats, error: String(e?.message || e) }, 500);
  }
});
