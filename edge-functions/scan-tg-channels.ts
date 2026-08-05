// Supabase Edge Function: scan-tg-channels
// ════════════════════════════════════════════════════════════════════════════
// Stage 1 of the Telegram outreach pipeline: DISCOVERY.
//
// Rotates through public search queries (tg_search_queries), keeps only public
// t.me channel URLs, scores them for partner fitness with Groq, and inserts the
// survivors as status='new'. Nothing is messaged here — nothing is messaged
// anywhere in this pipeline.
//
// Search source: DuckDuckGo HTML (free) by default. SerpApi stays OFF unless
// TG_SCAN_USE_SERP=true — the SerpApi budget is 250/month per key and belongs to
// find-and-queue; a 2-query/30-min scan on SerpApi would eat ~2900 calls a month
// on its own, i.e. the whole quota several times over.
//
// Rides the existing */15 Cloudflare tick (the free plan caps cron triggers at
// 5, all taken) and fires on every one of them, round the clock. Each run takes
// QUERIES_PER_RUN queries off the pool least-recently-used first and walks
// pages 1→2→3 across successive runs of the same query, so breadth and depth
// both keep turning over instead of re-reading the same first page.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GROQ_API_KEY (+GROQ_KEY_2/3),
//      optional TG_SCAN_USE_SERP + SERPAPI_KEY_1/2/3

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const GROQ_KEYS = [
  Deno.env.get('GROQ_API_KEY') || '',
  Deno.env.get('GROQ_KEY_2') || '',
  Deno.env.get('GROQ_KEY_3') || '',
].filter(Boolean);

const USE_SERP = (Deno.env.get('TG_SCAN_USE_SERP') || '').toLowerCase() === 'true';
const SERPAPI_ACCOUNTS = [
  { service: 'serpapi_1', key: Deno.env.get('SERPAPI_KEY_1') || '' },
  { service: 'serpapi_2', key: Deno.env.get('SERPAPI_KEY_2') || '' },
  { service: 'serpapi_3', key: Deno.env.get('SERPAPI_KEY_3') || '' },
].filter(a => a.key);

// Volume mode: this is discovery only — no message ever reaches a channel owner
// from here — so it runs flat out on every tick to build the base as fast as the
// free search source allows.
const QUERIES_PER_RUN   = 6;
const RESULTS_PER_QUERY = 30;
const SCORE_CHUNK       = 20;   // candidates per Groq call — a 180-item prompt is
                                // both slow and past what an 8b model reads reliably
const MIN_SCORE         = 40;   // below this a channel is not worth a contact lookup
const DEADLINE_MS       = 110_000; // stop starting new work; edge functions get ~150s

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Best-effort await. A Supabase query builder is a thenable WITHOUT .catch, so
// `builder.catch(...)` throws TypeError instead of swallowing anything — a
// bookkeeping write has to be wrapped like this to stay non-fatal.
async function quiet(p: PromiseLike<unknown>): Promise<void> {
  try { await p; } catch { /* bookkeeping is best-effort */ }
}

// ── t.me URL canonicalisation + filtering ───────────────────────────────────
// Path segments that are Telegram's own endpoints, not channels.
const RESERVED = new Set([
  's', 'c', 'k', 'a', 'z', 'iv', 'bg', 'share', 'proxy', 'socks', 'login',
  'contact', 'invoice', 'setlanguage', 'addstickers', 'addemoji', 'addtheme',
  'addlist', 'telegram', 'joinchat', 'confirmphone', 'privacy', 'faq', 'apps',
]);

/** Canonical https://t.me/<username>, or null when the URL is not a public
 *  channel we may look at. Private invites (t.me/+…, /joinchat/…) are dropped
 *  here and never fetched anywhere downstream. */
function normalizeTgUrl(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (!/^(www\.)?(t|telegram)\.me$/i.test(u.hostname)) return null;

  let path = u.pathname.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!path) return null;
  if (path.startsWith('+')) return null;                    // private invite
  if (/^joinchat(\/|$)/i.test(path)) return null;           // private invite
  if (path.startsWith('s/')) path = path.slice(2);          // /s/<name> preview

  const name = path.split('/')[0];                          // drop /<post_id>
  if (!/^[A-Za-z0-9_]{4,32}$/.test(name)) return null;
  if (RESERVED.has(name.toLowerCase())) return null;
  if (/bot$/i.test(name)) return null;                      // a bot, not a channel
  return 'https://t.me/' + name;
}

// ── Search: DuckDuckGo HTML ─────────────────────────────────────────────────
const BROWSER_UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
];
function pickUA(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return BROWSER_UAS[Math.abs(h) % BROWSER_UAS.length];
}

interface Hit { link: string; title: string; snippet: string }

function parseDdgHtml(html: string, num: number): Hit[] {
  const out: Hit[] = [];
  if (!html) return out;
  const linkRe  = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|span|div)>/gi;
  const links: Array<{ url: string; title: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null && links.length < num * 2) {
    let url = m[1];
    const uddg = url.match(/[?&]uddg=([^&]+)/)?.[1];
    if (uddg) url = decodeURIComponent(uddg);
    if (url.startsWith('http') && !url.includes('duckduckgo.com')) {
      links.push({ url, title: m[2].replace(/<[^>]+>/g, '').trim() });
    }
  }
  const snippets: string[] = [];
  while ((m = snippRe.exec(html)) !== null) {
    snippets.push(m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
  }
  for (let i = 0; i < Math.min(links.length, num); i++) {
    out.push({ link: links[i].url, title: links[i].title, snippet: snippets[i] || '' });
  }
  return out;
}

function extractVqd(html: string): string {
  return html.match(/name=["']vqd["'][^>]*value=["']([^"']+)["']/i)?.[1]
    || html.match(/value=["']([^"']+)["'][^>]*name=["']vqd["']/i)?.[1]
    || html.match(/vqd\s*[=:]\s*['"]([^'"]+)['"]/)?.[1]
    || '';
}

/** Search DuckDuckGo HTML. Page 1 is a plain GET; deeper pages need the vqd
 *  token off page 1 and a POST. Rotating the page per query run is what keeps a
 *  fixed pool of queries producing new channels instead of re-reading the same
 *  top 30 results forever. */
async function searchDdg(query: string, num: number, page = 1): Promise<Hit[]> {
  const UA = pickUA(query);
  const headers = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://duckduckgo.com/',
  };

  let html1 = '';
  try {
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers, signal: AbortSignal.timeout(12_000),
    });
    if (res.ok) html1 = await res.text();
    else res.body?.cancel().catch(() => {});
  } catch { /* fall through to the empty parse */ }

  if (page === 1 || !html1) return parseDdgHtml(html1, num);

  const vqd = extractVqd(html1);
  if (!vqd) return parseDdgHtml(html1, num);

  const offset = (page - 1) * 30;
  try {
    const res = await fetch('https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        q: query, s: String(offset), dc: String(offset + 1),
        v: 'l', o: 'json', api: '/d.js', nextParams: '', vqd, kl: '',
      }).toString(),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) { res.body?.cancel().catch(() => {}); return parseDdgHtml(html1, num); }
    const paged = parseDdgHtml(await res.text(), num);
    // A rejected POST returns a near-empty page — fall back to page 1 rather
    // than reporting the query as barren.
    return paged.length >= 3 ? paged : parseDdgHtml(html1, num);
  } catch { return parseDdgHtml(html1, num); }
}

// ── Search: SerpApi (opt-in only) ───────────────────────────────────────────
async function pickSerpAccount(): Promise<{ service: string; key: string } | null> {
  const nowMonth = new Date().toISOString().slice(0, 7);
  for (const acct of SERPAPI_ACCOUNTS) {
    const { data: row } = await supabase.from('api_usage')
      .select('used, limit_value, last_reset_at').eq('service', acct.service).single();
    if (!row) continue;
    let used = row.used ?? 0;
    const lim = row.limit_value ?? 250;
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

async function searchSerp(query: string, num: number, key: string): Promise<Hit[]> {
  try {
    const url = `https://serpapi.com/search.json?engine=google&num=${num}`
      + `&q=${encodeURIComponent(query)}&api_key=${key}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    if (!res.ok) { res.body?.cancel().catch(() => {}); return []; }
    const data = await res.json();
    const organic = Array.isArray(data?.organic_results) ? data.organic_results : [];
    return organic.slice(0, num).map((r: any) => ({
      link: r.link || '', title: r.title || '', snippet: r.snippet || '',
    })).filter((r: Hit) => r.link.startsWith('http'));
  } catch { return []; }
}

// ── Groq ────────────────────────────────────────────────────────────────────
let groqKeyIdx = 0;

/** Groq chat with per-key rotation: a 429 retries on the next key rather than
 *  dropping the batch (no sleeping — we can't stall inside an edge function). */
async function groqChat(body: Record<string, unknown>): Promise<string | null> {
  const n = GROQ_KEYS.length;
  if (!n) return null;
  for (let i = 0; i < n; i++) {
    const idx = (groqKeyIdx + i) % n;
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + GROQ_KEYS[idx] },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(25_000),
      });
      if (res.status === 429 || res.status >= 500) { res.body?.cancel().catch(() => {}); continue; }
      if (!res.ok) { res.body?.cancel().catch(() => {}); return null; }
      const d = await res.json();
      groqKeyIdx = (idx + 1) % n;
      return d?.choices?.[0]?.message?.content || '';
    } catch { /* next key */ }
  }
  groqKeyIdx = (groqKeyIdx + 1) % n;
  return null;
}

interface Verdict {
  i: number; score: number; name: string; geo: string;
  language: string; niche: string; reasoning: string;
}

/** One Groq call for the whole candidate batch (title+snippet only). Per-channel
 *  calls would multiply quota use for no gain — the page itself is read later,
 *  in extract-tg-contact, and only for channels that survive this filter. */
async function scoreBatch(cands: Hit[]): Promise<Map<number, Verdict>> {
  const out = new Map<number, Verdict>();
  if (!cands.length) return out;

  const list = cands.map((c, i) =>
    `${i}. ${c.link}\n   title: ${c.title.slice(0, 160)}\n   snippet: ${c.snippet.slice(0, 300)}`,
  ).join('\n');

  const prompt = `Ты аналитик партнёрской программы букмекера 1xBet (фокус — Африка).
Ниже список ПУБЛИЧНЫХ Telegram-каналов из поисковой выдачи. Оцени каждый как потенциального партнёра-аффилиата.

Высокий балл (70-100): канал с собственной аудиторией по ставкам/прогнозам/казино/Aviator, ведёт автор или команда, есть признаки монетизации (промокоды, реферальные ссылки, реклама).
Средний (40-69): тематика подходит, но масштаб или авторство неясны.
Низкий (0-39): официальный канал букмекера или конкурента, новостной агрегатор, скам/"гарантированные выигрыши", не по теме, не про ставки/казино, канал на русском рынке РФ/СНГ без связи с Африкой.

Верни СТРОГО JSON вида:
{"results":[{"i":0,"score":75,"name":"название канала","geo":"NG","language":"en","niche":"betting_tips","reasoning":"кратко, 1 предложение"}]}
geo — ISO-код страны или "" если неясно. language — ISO-код (en/ru/fr/pt/sw/…) или "".
niche — одно из: betting_tips, casino, aviator, esports, crypto, sports_news, other.
Только JSON, без markdown.

Каналы:
${list}`;

  const raw = await groqChat({
    model: 'llama-3.1-8b-instant',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.1,
    max_tokens: 2500,
    response_format: { type: 'json_object' },
  });
  if (!raw) return out;

  try {
    const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || raw);
    for (const r of (parsed?.results || [])) {
      const i = Number(r.i);
      if (!Number.isInteger(i) || i < 0 || i >= cands.length) continue;
      out.set(i, {
        i,
        score: Math.max(0, Math.min(100, Number(r.score) || 0)),
        name: String(r.name || '').slice(0, 200),
        geo: String(r.geo || '').slice(0, 8),
        language: String(r.language || '').slice(0, 8),
        niche: String(r.niche || 'other').slice(0, 40),
        reasoning: String(r.reasoning || '').slice(0, 500),
      });
    }
  } catch { /* unparseable batch — treated as "no verdicts" */ }
  return out;
}

// ── Main ────────────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const stats = {
    ran: false, queries: [] as string[], candidates: 0, fresh: 0,
    inserted: 0, source: USE_SERP ? 'serpapi' : 'ddg', reason: '',
  };
  const json = (s: unknown, code = 200) => new Response(JSON.stringify(s),
    { status: code, headers: { ...cors, 'Content-Type': 'application/json' } });

  const startedAt = Date.now();
  const outOfTime = () => Date.now() - startedAt > DEADLINE_MS;

  try {
    stats.ran = true;
    if (!GROQ_KEYS.length) { stats.reason = 'no Groq key configured'; return json(stats); }

    // Round-robin over the query pool: least-recently-used first, so every angle
    // gets its turn instead of random picks starving half the pool.
    const { data: queries } = await supabase.from('tg_search_queries')
      .select('id, query, runs, channels_found')
      .eq('active', true)
      .order('last_run_at', { ascending: true, nullsFirst: true })
      .limit(QUERIES_PER_RUN);
    if (!queries?.length) { stats.reason = 'no active queries'; return json(stats); }

    // Collect candidates. The in-run Set matters: one channel routinely appears
    // in both queries' results, and a duplicate inside a single insert batch
    // would abort the whole batch on the channel_url unique constraint.
    const seen = new Set<string>();
    const cands: Array<Hit & { url: string; query: string }> = [];
    // SerpApi only when explicitly armed AND an account still has budget left;
    // otherwise this quietly stays on the free source rather than stopping.
    const serpAcct = USE_SERP ? await pickSerpAccount() : null;
    stats.source = serpAcct ? 'serpapi' : 'ddg';

    // find-and-queue already leans hard on DuckDuckGo and has been rate-limited
    // there before. If the first few queries come back empty, DDG is throttling
    // us — bail out of the run rather than keep hammering and make it worse for
    // the main search pipeline.
    let emptyStreak = 0;

    for (const q of queries) {
      if (outOfTime()) break;
      if (emptyStreak >= 3) { stats.reason = 'search source returning nothing — backing off'; break; }
      stats.queries.push(q.query);
      // Walk pages 1→2→3 across successive runs of the same query, so a query
      // that has already given up its first page reaches further down instead of
      // returning the same URLs to be discarded as duplicates.
      const page = 1 + ((q.runs ?? 0) % 3);
      const hits = serpAcct
        ? await searchSerp(q.query, RESULTS_PER_QUERY, serpAcct.key)
        : await searchDdg(q.query, RESULTS_PER_QUERY, page);
      if (serpAcct) {
        const { data: u } = await supabase.from('api_usage')
          .select('used').eq('service', serpAcct.service).single();
        await supabase.from('api_usage')
          .update({ used: (u?.used ?? 0) + 1, updated_at: new Date().toISOString() })
          .eq('service', serpAcct.service);
      }
      emptyStreak = hits.length ? 0 : emptyStreak + 1;
      for (const h of hits) {
        const url = normalizeTgUrl(h.link);
        if (!url || seen.has(url)) continue;
        seen.add(url);
        cands.push({ ...h, url, query: q.query });
      }
      await supabase.from('tg_search_queries')
        .update({ runs: (q.runs ?? 0) + 1, last_run_at: new Date().toISOString() })
        .eq('id', q.id);
      await sleep(700);
    }
    stats.candidates = cands.length;
    if (!cands.length) { stats.reason = 'no t.me results'; return json(stats); }

    // Drop everything already known — including rejected/dead ones, so a spent
    // channel can't come back round after round. Chunked: a single .in() over
    // ~180 URLs builds a query string long enough to be rejected outright.
    const knownSet = new Set<string>();
    for (let i = 0; i < cands.length; i += 60) {
      const { data: known } = await supabase.from('telegram_channels')
        .select('channel_url').in('channel_url', cands.slice(i, i + 60).map(c => c.url));
      for (const r of known || []) knownSet.add(r.channel_url);
    }
    const fresh = cands.filter(c => !knownSet.has(c.url));
    stats.fresh = fresh.length;
    if (!fresh.length) { stats.reason = 'all candidates already known'; return json(stats); }

    // Score in chunks, and keep whatever is scored when the clock runs out —
    // a partial harvest beats losing the whole run to a timeout.
    const verdicts = new Map<number, Verdict>();
    for (let i = 0; i < fresh.length; i += SCORE_CHUNK) {
      if (outOfTime()) { stats.reason = `deadline — scored ${i}/${fresh.length}`; break; }
      const chunk = fresh.slice(i, i + SCORE_CHUNK);
      for (const [j, v] of await scoreBatch(chunk)) verdicts.set(i + j, v);
    }

    const rows = fresh.map((c, i) => ({ c, v: verdicts.get(i) }))
      .filter(x => x.v && x.v.score >= MIN_SCORE)
      .map(({ c, v }) => ({
        channel_url:  c.url,
        channel_name: v!.name || c.title.slice(0, 200) || c.url.split('/').pop(),
        geo:          v!.geo || null,
        language:     v!.language || null,
        niche:        v!.niche,
        description:  c.snippet.slice(0, 1000) || null,
        ai_score:     v!.score,
        ai_reasoning: v!.reasoning,
        status:       'new',
        found_query:  c.query,
      }));

    if (rows.length) {
      // ignoreDuplicates: a concurrent run (or a manual add) may have inserted
      // the same URL between the dedup check and here.
      const { data: ins, error } = await supabase.from('telegram_channels')
        .upsert(rows, { onConflict: 'channel_url', ignoreDuplicates: true })
        .select('id');
      if (error) throw new Error(error.message);
      stats.inserted = ins?.length ?? 0;
      if (ins?.length) {
        await quiet(supabase.from('telegram_channel_log').insert(
          ins.map(r => ({ channel_id: r.id, action: 'created', metadata: { source: stats.source } })),
        ));
      }
      // Yield stats per query, so archive-style pruning is possible later.
      for (const q of queries) {
        const n = rows.filter(r => r.found_query === q.query).length;
        if (n) {
          await supabase.from('tg_search_queries')
            .update({ channels_found: (q.channels_found ?? 0) + n }).eq('id', q.id);
        }
      }
    }

    await quiet(supabase.from('error_log').insert([{
      level: 'info', service: 'scan-tg-channels',
      message: `cands=${stats.candidates} fresh=${stats.fresh} inserted=${stats.inserted} src=${stats.source}`,
    }]));

    return json(stats);
  } catch (e: any) {
    return json({ ...stats, error: String(e?.message || e) }, 500);
  }
});
