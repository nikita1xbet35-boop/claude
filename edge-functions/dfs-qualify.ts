// Supabase Edge Function: dfs-qualify
// ════════════════════════════════════════════════════════════════════════════
// Stage 2 of the DataForSEO pipeline: QUALIFY.
//
// Walks dfs_domains newest-signal-first and decides which raw domains become
// leads. Judges on `domain + anchor + page_title` ALONE — no page is fetched
// here. That is the whole economic point: the anchor "Bet9ja promo code" settles
// the question by itself, and it arrived free with the harvest. Fetching a page
// per domain would put a 7-second network round trip in front of a queue
// measured in hundreds of thousands.
//
// Queue order is intersect_count DESC, dfs_rank DESC. A domain linking to three
// competitor bookmakers at once is an affiliate review site with near-certainty;
// nothing else on the web behaves that way. Those get judged first, so the run
// spends its LLM budget on the best material even when the queue is huge.
//
// Rides a frequent cron in small batches. Rows are claimed (status='qualifying')
// before the LLM call so two overlapping runs cannot judge the same domain twice.
//
// Deploy: supabase functions deploy dfs-qualify --no-verify-jwt
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//      ANTHROPIC_API_KEY (preferred) or GROQ_API_KEY (+GROQ_KEY_1/2/3)

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY') || '';
// ── Model selection ─────────────────────────────────────────────────────────
// Groq decommissioned llama-3.1-8b-instant without warning and every call
// started coming back `HTTP 404: The model does not exist or you do not have
// access to it`. Seven functions named that model as a string literal, so the
// whole system went to zero in one step: search still found sites, DuckDuckGo
// was healthy, and not one candidate could be judged.
//
// A single hardcoded model is therefore a single point of failure owned by
// somebody else. This is a list: on a "model is gone" answer we advance to the
// next one and keep going, and the surviving model's name goes into the run log
// so the swap is visible rather than silent.
const GROQ_MODELS = [
  'llama-3.3-70b-versatile',   // current default
  'openai/gpt-oss-20b',
  'gemma2-9b-it',
  'llama-3.1-8b-instant',      // the retired one, kept last in case access returns
];
let groqModelIdx = 0;
const groqModel = () => GROQ_MODELS[groqModelIdx];
/** Does this failure mean the model itself is gone (as opposed to a bad request)? */
function groqModelGone(status: number, text: string): boolean {
  return (status === 404 || status === 400)
    && /does not exist|decommissioned|model[_ ]not[_ ]found|has been deprecated/i.test(text);
}

const GROQ_KEYS = [
  Deno.env.get('GROQ_API_KEY') || '',
  // GROQ_KEY_1 — четвёртый слот, добавлен когда Ник завёл три новых аккаунта.
  // Слотов было три (GROQ_API_KEY + _2 + _3), и секрет с именем GROQ_KEY_1 не
  // читал НИКТО: ни воркфлоу его не передавал, ни одна функция не забирала.
  // Ключ лежал бы в настройках и молча не работал — ровно тот случай, когда
  // всё выглядит настроенным и ничего не происходит.
  Deno.env.get('GROQ_KEY_1')   || '',
  Deno.env.get('GROQ_KEY_2') || '',
  Deno.env.get('GROQ_KEY_3') || '',
].filter(Boolean);

const DEADLINE_MS  = 110_000;
const CLAIM_BATCH  = 120;   // domains pulled per run
// 25, not the original number: every single Groq call was failing with HTTP
// 413 "request too large" — not a rate limit, a hard per-request cap that
// retrying or rotating keys cannot get around. 25 domains × ~200 output
// tokens/verdict plus max_tokens:8000 was pushing the request over Groq's
// free-tier per-request ceiling on every batch, so nothing was EVER judged.
// Smaller batch, smaller ceiling — both moved together below.
const LLM_BATCH    = 15;    // domains per LLM call
const MIN_SCORE    = 35;
// Above this, the domain is in somebody's spam neighbourhood. DataForSEO's
// spam_score is a 0-100 read on the referring profile; a real affiliate that
// sells ad space sits in single digits, and writing to a 45 is writing to a PBN.
const MAX_SPAM     = 30;
// Link-graph override threshold. Was 2 — which promoted everything, because an
// intersection built from two targets gives EVERY row a count of exactly 2, so
// the override fired on all of them and the model's verdict never mattered.
// At 3 the override means what it was meant to mean: three separate bookmakers
// is evidence no single anchor string can outweigh.
const OVERRIDE_INTERSECT = 3;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function quiet(p: PromiseLike<unknown>): Promise<void> {
  try { await p; } catch { /* bookkeeping is best-effort */ }
}

// ── LLM ─────────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are an analyst for a betting affiliate program (1xBet, Africa focus).

Each item below is a website that links to a competitor bookmaker. Your job is to
decide whether it is a POTENTIAL AFFILIATE PARTNER — a site that owns an audience
and monetises betting traffic.

We WANT: betting review/comparison sites, tipster and prediction sites, sports
blogs and media with a betting section, bonus/promo-code sites, sports news
portals — anyone who publishes to their own audience and promotes bookmakers.

Writing guides, tutorials or promoting bookmakers is a POSITIVE signal — it proves
they own betting audience and know how to monetise it.

We do NOT want: the bookmakers themselves, livescore/stats-only tools, streaming
sites, forums, link shorteners, social platforms, marketplaces, job boards,
directories, adult/NSFW sites, news sites that merely mention a bookmaker once,
and anything with no owned audience.

We especially do NOT want MACHINE-GENERATED sites — pages produced automatically
ABOUT other websites or files rather than written for readers. These link to many
bookmakers at once as a side effect of scraping, so the link graph flatters them
and only you can catch it. Reject on sight, score 0, audience_owner = false:
- SEO / DNS / WHOIS / IP / hosting lookup and "website worth" tools
  (subdomainfinder.io, whois-*, *seotool*, statscrop, websiteoutlook)
- PDF, ebook, document and APK scrapers and download mirrors (pdfbookee.com,
  docplayer, apkpure, anything "download"/"crack"/"torrent")
- subtitle, streaming and file-hosting sites
- URL shorteners, redirect farms, expired-domain and traffic-estimate sites
- parked domains, template demos and sites with no editorial content

Rule of thumb: if a human editor did not decide to publish the page, it is not a
partner, no matter how many bookmakers it links to.

For EACH item return one JSON object, keyed back to the item by its "i" index:

{
 "i": 0,
 "score": 0-100,
 "type": "review|tipster|media|blog|bonus_codes|aggregator|operator|other",
 "audience_owner": true,
 "monetization_signal": false,
 "affiliate_maturity": "hobby|semi_pro|professional",
 "pro_signals": {
   "multi_bookmaker": false,
   "commercial_anchor": false,
   "comparison_content": false
 },
 "geo": "",
 "lang": "",
 "is_operator": false,
 "geo_excluded": false,
 "our_brand": false,
 "relevant": true,
 "summary": "max 12 words"
}

FIELD RULES:
- pro_signals.multi_bookmaker: evidence it links to 3+ different bookmakers.
- pro_signals.commercial_anchor: anchor is commercial — "review", "bonus code",
  "promo code", "best betting sites", "vs", "comparison".
- pro_signals.comparison_content: title suggests a toplist/comparison/ranking.
- geo_excluded: primary audience is US/UK/Western Europe/Ukraine/Brazil/Australia.
- our_brand: promotes 1xBet/Melbet/BetWinner/Megapari/Paripesa/22bet/Linebet —
  that relationship is already owned by another manager, so it is NOT a prospect.

RULES for "relevant":
- relevant = true ONLY IF audience_owner = true AND is_operator = false
  AND geo_excluded = false AND our_brand = false
- An anchor like "Bet9ja promo code" or "Betway review" is strong evidence of an
  affiliate site: audience_owner = true, monetization_signal = true
- A generic anchor with a news-style title is weak evidence: audience_owner = false
  unless the domain itself is clearly a betting/sports property

RULES for "affiliate_maturity":
- professional: commercial anchor + comparison content + multi_bookmaker
- semi_pro: commercial anchor OR comparison content
- hobby: neither
(When an item carries commercial_keywords_top10, that number decides maturity
instead — it is measured, not inferred. Your value is only used when it is absent.)

WEIGHING THE EVIDENCE:
- "found_by: ranks in Google top for commercial betting queries" is the STRONGEST
  signal available. Paid-for positions on "best betting sites nigeria" are held
  by professional affiliates almost by definition — nobody else competes there.
  Such a domain is audience_owner = true unless it is plainly an operator, a
  news giant, or one of the machine sites above.
- A high est_traffic_from_those_queries with a low median_position is a real
  business. Treat it as far better evidence than any anchor text.
- Absence of an anchor means nothing for these domains: they were found in the
  SERP, not in a link graph, so there is no anchor to have.

Return ONLY JSON shaped {"results":[...]}. No prose, no markdown.`;

let groqKeyIdx = 0;

// Last reason judge() returned nothing. A queue that claims rows and gives
// back zero verdicts every single tick is invisible without this: the caller
// only saw `unjudged`, never WHY — invalid key, rate limit, or a model Groq
// has since deprecated all look identical from the outside. Surfaced into
// error_log below, at zero extra cost since a failed call is a free one.
let lastLlmError = '';

/** Groq with per-key rotation and a second pass after a pause. The keys are
 *  shared with find-and-queue, which keeps them near their per-minute cap, so
 *  all three can be 429 at the same instant and be fine a second later. */
async function groqChat(user: string, itemCount: number): Promise<string | null> {
  const n = GROQ_KEYS.length;
  if (!n) { lastLlmError = 'no GROQ key configured'; return null; }
  const body = {
    model: groqModel(),
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: user },
    ],
    temperature: 0.1,
    // Sized to the batch. 8000 caused outright 413s; 4096 stopped the 413s but
    // left a subtler version of the same problem — Groq reserves max_tokens
    // against a 6000 tokens/minute budget whether the answer uses them or not,
    // so a near-ceiling reservation lets exactly one request through per
    // minute and 429s the rest. This verdict carries more fields than the
    // brand one, so 200 per item rather than 110.
    max_tokens: 200 * itemCount + 200,
    response_format: { type: 'json_object' },
  };
  let sawRateLimit = false;
  // The free tier's limit is a ROLLING minute, so a 2s pause between rounds was
  // theatre: if all three keys are over budget now, they are still over budget
  // two seconds later. Measured over 48h: every one of these functions ended its
  // last run on `HTTP 429 (round 2)` with material already paid for — twenty
  // DDG results fetched, zero analysed. The ladder below spends up to 25s of
  // wall clock to save that material, which is the cheapest trade in the system.
  const BACKOFF_MS = [0, 5_000, 20_000];
  for (let round = 0; round < BACKOFF_MS.length; round++) {
    if (round) await sleep(BACKOFF_MS[round]);
    for (let i = 0; i < n; i++) {
      const idx = (groqKeyIdx + i) % n;
      try {
        // The model list can advance mid-run (see GROQ_MODELS), so stamp the
        // current choice onto the body at call time rather than at build time.
        (body as Record<string, unknown>).model = groqModel();
        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + GROQ_KEYS[idx] },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        });
        if (res.status === 429 || res.status >= 500) {
          sawRateLimit = true;
          lastLlmError = `groq key#${idx} HTTP ${res.status}`;
          res.body?.cancel().catch(() => {});
          continue;
        }
        if (res.status === 401 || res.status === 403) {
          // Отвергнут КЛЮЧ, а не запрос — пробуем следующий (см. find-and-queue).
          lastLlmError = `groq key#${idx} HTTP ${res.status} — ключ отвергнут`;
          res.body?.cancel().catch(() => {});
          continue;
        }
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          // The model was retired under us. Every key will say the same thing,
          // so rotating them is pointless — move down GROQ_MODELS and retry.
          if (groqModelGone(res.status, text) && groqModelIdx < GROQ_MODELS.length - 1) {
            groqModelIdx++;
            lastLlmError = `model retired, switched to ${groqModel()}`;
            continue;
          }
          lastLlmError = `groq key#${idx} HTTP ${res.status}: ${text.slice(0, 200)}`;
          return null;
        }
        const d = await res.json();
        groqKeyIdx = (idx + 1) % n;
        return d?.choices?.[0]?.message?.content || '';
      } catch (e: any) {
        lastLlmError = `groq key#${idx} network error: ${String(e?.message || e).slice(0, 200)}`;
      }
    }
  }
  groqKeyIdx = (groqKeyIdx + 1) % n;
  if (!lastLlmError) lastLlmError = sawRateLimit ? 'groq: all keys rate-limited/5xx after retry' : 'groq: unknown failure';
  return null;
}

/** Anthropic path. Preferred when a key is present: this queue is measured in
 *  hundreds of thousands of rows and the Groq free tier is already the search
 *  pipeline's bottleneck. */
async function anthropicChat(user: string): Promise<string | null> {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 8000,
        temperature: 0.1,
        // Cached: the system prompt is ~700 tokens and identical on every call.
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: user }],
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) { res.body?.cancel().catch(() => {}); return null; }
    const d = await res.json();
    return d?.content?.[0]?.text || '';
  } catch { return null; }
}

interface Verdict {
  score: number; type: string; audience_owner: boolean; monetization_signal: boolean;
  affiliate_maturity: string; pro_signals: Record<string, boolean>;
  geo: string; lang: string; is_operator: boolean; geo_excluded: boolean;
  our_brand: boolean; relevant: boolean; summary: string;
}

interface Row {
  id: number; domain: string; anchor: string | null; page_title: string | null;
  seed_competitor: string | null; intersect_count: number; dfs_rank: number | null;
  spam_score: number | null; competitors_list: string[] | null;
  // v7.1 — SERP ownership. These outrank everything above: they say the domain
  // is in the top of Google for queries people pay to rank for, which no anchor
  // string can establish.
  source: string | null; keyword_cluster: string | null;
  etv: number | null; median_position: number | null; relevance: number | null;
  commercial_keywords: number | null; total_search_volume: number | null;
  top3_keywords: number | null; rank_checked_at: string | null;
}

// v7.1 §2 step 2. Deliberately not a judgement call — these are the numbers the
// API returned, and the LLM does not get to overrule them upward.
const PRO_MIN_KEYWORDS  = 15;
const PRO_MIN_VOLUME    = 10_000;
const SEMI_MIN_KEYWORDS = 5;

function maturityOf(r: Row): string | null {
  const ck = Number(r.commercial_keywords ?? NaN);
  const sv = Number(r.total_search_volume ?? 0);
  if (!Number.isFinite(ck)) return null;          // never profiled — unknown
  if (ck >= PRO_MIN_KEYWORDS && sv >= PRO_MIN_VOLUME) return 'professional';
  if (ck >= SEMI_MIN_KEYWORDS) return 'semi_pro';
  return 'hobby';
}

// Deterministic own-brand backstop. The model is asked for our_brand, but a
// regex over the raw text cannot miss a mention the model wasn't focused on,
// and approaching a site another manager already owns is a real-money mistake.
const OUR_GROUP = ['1xbet', '1x bet', 'betwinner', 'melbet', 'megapari',
  'paripesa', '22bet', 'linebet', '1xpartners'];

// ── Machine junk ────────────────────────────────────────────────────────────
// Mirrors the list in dfs-harvest, which now drops these before they are ever
// written. Repeated here because the rows already in the table predate it, and
// because an LLM call costs money that a substring match does not. Kept as a
// copy rather than an import: edge functions deploy as standalone files.
const JUNK_PATTERNS = [
  'subdomainfinder', 'subdomain-', 'dnsdumpster', 'dnschecker', 'nslookup',
  'whois', 'iptrack', 'ip-track', 'iplocation', 'ip-lookup', 'mxtoolbox',
  'sitechecker', 'urlscan', 'seotool', 'seocheck', 'seoreview', 'seorank',
  'seoaudit', 'backlinkcheck', 'linkchecker', 'similarweb', 'ahrefs',
  'semrush', 'majestic', 'statscrop', 'websiteoutlook', 'siteworth',
  'websitevalue', 'worthofweb', 'trafficestimate', 'rank-checker',
  'rankchecker', 'domaintools', 'domainbigdata', 'expireddomain', 'hostadvice',
  'webhosting', 'cpanel', 'sitespeed', 'pagespeed', 'w3snoop', 'urlrate',
  'pdfbook', 'pdfdrive', 'pdffiller', 'pdfcoffee', 'ebookdownload', 'docplayer',
  'slideshare', 'scribd', 'epubdownload', 'freedownload', 'downloadapk',
  'apkpure', 'apkmirror', 'apkmody', 'apkdone', 'modapk', 'apk-', '-apk.',
  'crackdownload', 'nulled', 'warez', 'torrent',
  'shortlink', 'urlshort', 'shorten', 'linkbio', 'link-bio', 'redirect',
  'freewebsite', 'webstat', 'sitestat', 'domainstat', 'alexa-rank',
];

function isMachineJunk(domain: string): boolean {
  const stem = String(domain || '').split('.')[0];
  return JUNK_PATTERNS.some(p => domain.includes(p))
      || JUNK_PATTERNS.some(p => stem.includes(p.replace(/[-.]/g, '')));
}

async function judge(batch: Row[]): Promise<Map<number, Verdict>> {
  const out = new Map<number, Verdict>();
  if (!batch.length) return out;

  const user = batch.map((r, i) => {
    const lines = [`${i}. domain: ${r.domain}`];
    // SERP evidence first when we have it — it is the strongest thing in the
    // prompt, and burying it under an anchor string invites the model to judge
    // on the anchor.
    if (r.source === 'serp_competitors' || r.source === 'competitors_domain') {
      lines.push(`   found_by: ranks in Google top for commercial betting queries (${r.keyword_cluster || '—'})`);
      if (r.median_position !== null) lines.push(`   median_position: ${r.median_position}`);
      if (r.etv !== null)             lines.push(`   est_traffic_from_those_queries: ${Math.round(r.etv)}`);
    }
    if (r.commercial_keywords !== null) {
      lines.push(`   commercial_keywords_top10: ${r.commercial_keywords}`
        + ` (total monthly search volume ${r.total_search_volume ?? 0}`
        + `, ${r.top3_keywords ?? 0} of them in top-3)`);
    }
    lines.push(`   anchor: ${(r.anchor || '—').slice(0, 200)}`);
    lines.push(`   page_title: ${(r.page_title || '—').slice(0, 200)}`);
    lines.push(`   links_to: ${(r.competitors_list || [r.seed_competitor]).filter(Boolean).join(', ') || '—'}`
      + ` (${r.intersect_count} bookmaker${r.intersect_count === 1 ? '' : 's'})`);
    lines.push(`   dfs_rank: ${r.dfs_rank ?? '—'}`);
    return lines.join('\n');
  }).join('\n\n');

  const raw = ANTHROPIC_KEY ? await anthropicChat(user) : await groqChat(user, batch.length);
  if (!raw) return out;

  try {
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim().match(/\{[\s\S]*\}/)?.[0] || raw);
    const results: any[] = Array.isArray(parsed?.results) ? parsed.results
                         : Array.isArray(parsed) ? parsed : [];
    for (const v of results) {
      const i = Number(v?.i);
      if (!Number.isInteger(i) || i < 0 || i >= batch.length || out.has(i)) continue;
      const hay = (batch[i].domain + ' ' + (batch[i].anchor || '') + ' '
                 + (batch[i].page_title || '')).toLowerCase();
      const ourBrand = Boolean(v.our_brand) || OUR_GROUP.some(b => hay.includes(b));
      const ps = v.pro_signals || {};
      out.set(i, {
        score: Math.max(0, Math.min(100, Number(v.score) || 0)),
        type: String(v.type || 'other').slice(0, 30),
        audience_owner: v.audience_owner === undefined ? false : !!v.audience_owner,
        monetization_signal: !!v.monetization_signal,
        affiliate_maturity: ['hobby', 'semi_pro', 'professional'].includes(String(v.affiliate_maturity))
          ? String(v.affiliate_maturity) : 'hobby',
        pro_signals: {
          multi_bookmaker:    !!ps.multi_bookmaker,
          commercial_anchor:  !!ps.commercial_anchor,
          comparison_content: !!ps.comparison_content,
        },
        geo: String(v.geo || '').slice(0, 8).toUpperCase(),
        lang: String(v.lang || '').slice(0, 8),
        is_operator: !!v.is_operator,
        geo_excluded: !!v.geo_excluded,
        our_brand: ourBrand,
        relevant: !!v.relevant,
        summary: String(v.summary || '').slice(0, 300),
      });
    }
  } catch { /* unparseable batch — those rows stay 'qualifying' and are retried */ }
  return out;
}

// ── Main ────────────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const stats = {
    claimed: 0, judged: 0, promoted: 0, rejected: 0, unjudged: 0,
    already_lead: 0, already_emailed: 0, junk: 0, spammy: 0,
    llm: ANTHROPIC_KEY ? 'anthropic' : 'groq', reason: '',
  };
  const json = (s: unknown, code = 200) => new Response(JSON.stringify(s),
    { status: code, headers: { ...cors, 'Content-Type': 'application/json' } });

  const startedAt = Date.now();
  const outOfTime = () => Date.now() - startedAt > DEADLINE_MS;

  try {
    if (!ANTHROPIC_KEY && !GROQ_KEYS.length) {
      stats.reason = 'no LLM key configured';
      return json(stats, 400);
    }

    // Requeue rows a previous run claimed and died on, so a timeout mid-batch
    // doesn't strand them in 'qualifying' forever.
    //
    // Keys on claimed_at, NOT discovered_at: discovered_at is stamped at harvest
    // and never moves, so a sweep against it would release every row harvested
    // over 30 minutes ago on the very next tick — i.e. almost all of them,
    // moments after they were claimed, defeating the claim entirely.
    //
    // Two plain queries rather than one .or(): the cutoff is an ISO timestamp
    // and PostgREST's or() splits its conditions on dots, so embedding
    // "…:00.000Z" in that grammar is asking for a parse that silently matches
    // the wrong rows.
    const staleCutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    await quiet(supabase.from('dfs_domains')
      .update({ status: 'raw', claimed_at: null })
      .eq('status', 'qualifying')
      .is('claimed_at', null));
    await quiet(supabase.from('dfs_domains')
      .update({ status: 'raw', claimed_at: null })
      .eq('status', 'qualifying')
      .lt('claimed_at', staleCutoff));

    // Best material first — and in v7.1 "best" means estimated traffic from the
    // commercial SERP, not link count. A domain that owns the queries people pay
    // to rank for is a different class of evidence from one that once linked to
    // a book, so etv leads the sort and intersect_count is only the tie-break
    // for older backlinks rows that have no etv at all.
    const { data: rows } = await supabase.from('dfs_domains')
      .select('id, domain, anchor, page_title, seed_competitor, intersect_count, dfs_rank, '
            + 'spam_score, competitors_list, source, keyword_cluster, etv, median_position, '
            + 'relevance, commercial_keywords, total_search_volume, top3_keywords, rank_checked_at')
      .eq('status', 'raw')
      .order('etv', { ascending: false, nullsFirst: false })
      .order('intersect_count', { ascending: false })
      .order('dfs_rank', { ascending: false, nullsFirst: false })
      .limit(CLAIM_BATCH);

    if (!rows?.length) { stats.reason = 'queue empty'; return json(stats); }

    // Claim before judging — two overlapping runs must not spend the LLM twice
    // on the same domain.
    const ids = rows.map((r: any) => r.id);
    await supabase.from('dfs_domains')
      .update({ status: 'qualifying', claimed_at: new Date().toISOString() })
      .in('id', ids);
    stats.claimed = rows.length;

    // ── Cheap dedup before any LLM spend ──────────────────────────────────
    const domains = rows.map((r: any) => r.domain);
    const knownLeads = new Set<string>();
    for (let i = 0; i < domains.length; i += 60) {
      const { data } = await supabase.from('leads')
        .select('domain_normalized').in('domain_normalized', domains.slice(i, i + 60));
      for (const l of data || []) if (l.domain_normalized) knownLeads.add(l.domain_normalized);
    }

    const fresh: Row[] = [];
    const preRejected: Array<{ id: number; reason: string }> = [];
    for (const r of rows as Row[]) {
      if (knownLeads.has(r.domain)) {
        preRejected.push({ id: r.id, reason: 'already_lead' });
        stats.already_lead++;
        continue;
      }
      // Free rejections, before any token is spent. Both of these were sitting
      // at the top of the queue after the first real harvest.
      if (isMachineJunk(r.domain)) {
        preRejected.push({ id: r.id, reason: 'machine_junk' });
        stats.junk++;
        continue;
      }
      if (r.spam_score != null && r.spam_score > MAX_SPAM) {
        preRejected.push({ id: r.id, reason: 'spam_score' });
        stats.spammy++;
        continue;
      }
      fresh.push(r);
    }

    for (const p of preRejected) {
      await quiet(supabase.from('dfs_domains')
        .update({ status: 'rejected', reject_reason: p.reason, qualified_at: new Date().toISOString() })
        .eq('id', p.id));
    }
    stats.rejected += preRejected.length;

    if (!fresh.length) { stats.reason = 'nothing left after free filters'; return json(stats); }

    // Hard all-time dedup: never approach an address that was ever emailed.
    const { data: sent } = await supabase.from('email_log').select('email');
    const emailed = new Set((sent || [])
      .map((r: any) => String(r.email || '').toLowerCase().split('@')[1] || '')
      .filter(Boolean));

    // ── Judge ─────────────────────────────────────────────────────────────
    for (let i = 0; i < fresh.length; i += LLM_BATCH) {
      if (outOfTime()) {
        // Hand the untouched tail back to the queue rather than stranding it.
        const tail = fresh.slice(i).map(r => r.id);
        if (tail.length) await quiet(supabase.from('dfs_domains')
          .update({ status: 'raw', claimed_at: null }).in('id', tail));
        stats.reason = `deadline — judged ${i}/${fresh.length}, ${tail.length} returned to queue`;
        break;
      }

      const batch = fresh.slice(i, i + LLM_BATCH);
      const verdicts = await judge(batch);

      for (let j = 0; j < batch.length; j++) {
        const row = batch[j];
        const v = verdicts.get(j);

        // No verdict = the LLM failed on this row, NOT a rejection. Put it back
        // so a rate-limited minute doesn't silently burn real candidates —
        // that failure mode already cost the search pipeline 36 channels.
        if (!v) {
          stats.unjudged++;
          await quiet(supabase.from('dfs_domains')
            .update({ status: 'raw', claimed_at: null }).eq('id', row.id));
          continue;
        }
        stats.judged++;

        const reject = async (reason: string) => {
          stats.rejected++;
          await quiet(supabase.from('dfs_domains').update({
            status: 'rejected', reject_reason: reason, qualified_at: new Date().toISOString(),
          }).eq('id', row.id));
        };

        // Measured SERP ownership, computed BEFORE the model's soft rejections
        // are applied. A domain holding 15+ commercial keywords in the top 10
        // with real search volume behind them is a professional affiliate
        // whatever a single anchor string suggested — that is the entire
        // premise of the v7.1 rework, and it only means anything if the
        // measurement can overrule the guess.
        const measured = maturityOf(row);
        const provenBySerp = measured === 'professional' || measured === 'semi_pro';

        // Hard rejections stay absolute: no amount of traffic makes a bookmaker
        // a prospect, and approaching a site another manager already owns is a
        // real-money mistake regardless of how good the site is.
        if (v.our_brand)                 { await reject('our_brand'); continue; }
        if (v.is_operator)               { await reject('operator'); continue; }
        if (v.geo_excluded)              { await reject('geo_excluded'); continue; }
        if (emailed.has(row.domain))     { stats.already_emailed++; await reject('already_emailed'); continue; }

        // Soft rejections are the model's opinion about whether the site owns
        // an audience. Against a measured top-10 position on commercial queries
        // that opinion loses: today's run rejected all 30 domains as
        // "no_audience", which is exactly the judgement this data exists to
        // replace.
        if (!provenBySerp) {
          if (!v.audience_owner)         { await reject('no_audience'); continue; }
          if (!v.relevant)               { await reject('irrelevant'); continue; }
        }

        // The link graph can outweigh a weak score, but only from three
        // bookmakers up — and never against an explicit "this is a machine"
        // verdict, which is how pdfbookee.com (four books!) reached the top of
        // the queue. The override raises a borderline score; it does not
        // resurrect a rejection.
        const qualifies = v.score >= MIN_SCORE
          || row.intersect_count >= OVERRIDE_INTERSECT
          || measured === 'professional'
          || measured === 'semi_pro'
          || v.affiliate_maturity === 'professional';
        if (!qualifies) { await reject('low_score'); continue; }

        const leadData: Record<string, unknown> = {
          url: 'https://' + row.domain,
          name: row.domain,
          brand: '1xbet',
          stage: 'new',
          pipeline: 'dataforseo',
          source: 'dataforseo',
          dfs_domain_id: row.id,
          domain_normalized: row.domain,
          lang: v.lang || null,
          type: v.type,
          score: v.score,
          summary: v.summary || null,
          // Measured maturity wins over the guessed one wherever we have it.
          priority: (measured || v.affiliate_maturity) === 'professional' ? 'High'
                  : (measured || v.affiliate_maturity) === 'semi_pro' ? 'Medium' : 'Low',
          audience_owner: provenBySerp ? true : v.audience_owner,
          monetization_signal: v.monetization_signal,
          affiliate_maturity: measured || v.affiliate_maturity,
          pro_signals: v.pro_signals,
          // Link-graph evidence, snapshotted onto the lead: score-leads weights
          // it and the lead card shows it, and neither should have to join back
          // through dfs_domain_id for every row it renders.
          dfs_intersect_count: row.intersect_count,
          dfs_rank: row.dfs_rank,
          dfs_spam_score: row.spam_score,
          dfs_competitors: row.competitors_list || (row.seed_competitor ? [row.seed_competitor] : null),
          competitor_book: (row.competitors_list || [])[0] || row.seed_competitor || null,
          // v7.1 — SERP ownership, carried onto the lead for the same reason.
          // total_search_volume is the headline number: it is what makes one
          // lead worth more than another, and the send queue orders on it.
          commercial_keywords: row.commercial_keywords,
          total_search_volume: row.total_search_volume,
          top3_keywords: row.top3_keywords,
          dfs_etv: row.etv,
          dfs_median_position: row.median_position,
          dfs_source: row.source,
          // The market the domain was actually found in beats the model's guess
          // at a geo from a domain name.
          geo: row.keyword_cluster && row.keyword_cluster !== 'AFRICA'
            ? row.keyword_cluster : (v.geo || null),
        };

        const { error: insErr } = await supabase.from('leads').insert([leadData]);
        if (insErr) {
          const code = (insErr as any).code;
          if (code === '23505' || /duplicate key|unique constraint/i.test(insErr.message || '')) {
            await reject('already_lead');
            continue;
          }
          // A real insert failure must not consume the row — leave it claimed
          // and let the stale-requeue above return it in half an hour.
          stats.reason = 'insert: ' + insErr.message;
          continue;
        }

        stats.promoted++;
        await quiet(supabase.from('dfs_domains').update({
          status: 'promoted', qualified_at: new Date().toISOString(),
        }).eq('id', row.id));
      }
    }

    // unjudged>0 with judged=0 is a queue that LOOKS stuck but is actually the
    // LLM call failing every single tick — invisible without this, since the
    // row-level retry silently puts everything back to 'raw'. Bumping the
    // level to warning when nothing at all got judged makes it show up in any
    // error-log filter set to skip routine info noise.
    const llmFailing = stats.claimed > 0 && stats.judged === 0 && stats.unjudged > 0;
    await quiet(supabase.from('error_log').insert([{
      level: llmFailing ? 'warning' : 'info', service: 'dfs-qualify',
      message: `llm=${stats.llm} claimed=${stats.claimed} judged=${stats.judged} `
        + `promoted=${stats.promoted} rejected=${stats.rejected} unjudged=${stats.unjudged} `
        + `already_lead=${stats.already_lead} junk=${stats.junk} spammy=${stats.spammy} `
        + (llmFailing ? `llm_error="${lastLlmError}" ` : '')
        + `${stats.reason}`,
    }]));

    return json(stats);
  } catch (e: any) {
    await quiet(supabase.from('error_log').insert([{
      level: 'critical', service: 'dfs-qualify', message: String(e?.message || e),
    }]));
    return json({ ...stats, error: String(e?.message || e) }, 500);
  }
});
