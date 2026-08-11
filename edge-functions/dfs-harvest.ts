// Supabase Edge Function: dfs-harvest
// ════════════════════════════════════════════════════════════════════════════
// Stage 1 of the DataForSEO pipeline: HARVEST.
//
// Pulls the backlink profiles of competitor bookmakers and dumps the referring
// domains into dfs_domains as raw material. Analyses nothing, fetches no pages,
// contacts nobody — that is dfs-qualify's and dfs-enrich's job. This function
// exists to turn money into rows as cheaply as possible.
//
// WHY BACKLINKS AND NOT KEYWORDS
// A site that links to Bet9ja is an affiliate by construction: an SEO affiliate
// cannot earn without sending traffic to a book. The keyword pipeline can only
// ever see ~5 400 URLs (150 keywords × 12 results × 3 pages) and has already
// found all of them. bet9ja.com alone has 18 115 referring domains.
//
// RUN IT MANUALLY (or weekly), NOT ON THE 3-MINUTE CRON. Every call costs real
// money and the whole point is large, infrequent batches.
//
// Cost model, confirmed against the live API:
//   $0.024 per request + $0.000036 per row  →  1000 rows = $0.06
// Filtering and sorting are free on DataForSEO's side, so `rank > 15` is applied
// in the request and junk is never paid for.
//
// Body params (all optional):
//   { budget_usd: 5, mode: 'intersect'|'broad'|'anchors'|'both'|'all',
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
    saved: 0,
    intersections: [] as Array<{ geo: string; targets: string[]; found: number }>,
    broad: [] as Array<{ competitor: string; found: number; offset: number; total: number }>,
    anchors_filled: 0,
    reason: '',
    error: '',
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
    const mode        = String(body.mode || 'both');
    const rowsPerCall = Math.min(1000, Math.max(10, Number(body.rows_per_call) || 1000));
    stats.mode = mode;

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
      const bal = await dfsBalance();
      return json({
        estimate_only: true,
        balance: bal.ok ? bal.balance : null,
        balance_error: bal.ok ? null : bal.error,
        rows_per_call: rowsPerCall,
        cost_per_call: Number(perCall.toFixed(6)),
        intersect: { calls: intersectCalls, cost: Number((intersectCalls * perCall).toFixed(4)) },
        broad:     { calls: broadCalls,     cost: Number((broadCalls * perCall).toFixed(4)) },
        anchors:   { calls: broadCalls,     cost: Number((broadCalls * perCall).toFixed(4)) },
        both:      { calls: intersectCalls + broadCalls,
                     cost: Number(((intersectCalls + broadCalls) * perCall).toFixed(4)) },
        all:       { calls: intersectCalls + broadCalls * 2,
                     cost: Number(((intersectCalls + broadCalls * 2) * perCall).toFixed(4)) },
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
    const affordable = () => stats.spent + perCall <= cap;

    const { data: competitors } = await supabase.from('dfs_competitors')
      .select('id, domain, geo, priority, harvested_offset, total_ref_domains')
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

    // ── Phase A: intersections ────────────────────────────────────────────
    // The highest-precision signal available. A news site mentions one book
    // once; only an affiliate review site links to three at the same time.
    // Run WITHIN a geo — a Nigeria×Kenya intersection returns near-nothing.
    if (mode === 'intersect' || mode === 'both' || mode === 'all') {
      const byGeo = new Map<string, string[]>();
      for (const c of competitors) {
        const g = c.geo || '—';
        if (!byGeo.has(g)) byGeo.set(g, []);
        byGeo.get(g)!.push(normDomain(c.domain));
      }

      for (const [geo, domains] of byGeo) {
        if (outOfTime()) { stats.reason = 'deadline during intersections'; break; }
        if (!affordable()) { stats.reason = 'budget spent during intersections'; break; }
        // Intersection needs at least two targets to mean anything.
        if (domains.length < 2) continue;

        const targetList = domains.slice(0, 3); // already priority-ordered
        const targets: Record<string, string> = {};
        targetList.forEach((d, i) => { targets[String(i + 1)] = d; });

        const r = await dfsCall('/v3/backlinks/domain_intersection/live', {
          targets,
          limit: rowsPerCall,
          offset: 0,
          intersection_mode: 'intersect',
          backlinks_status_type: 'live',
          order_by: ['rank,desc'],
          filters: [['rank', '>', MIN_RANK]],
        }, geo + ':' + targetList.join('+'));
        stats.calls++;
        stats.spent += r.cost;
        if (!r.ok) { stats.reason = 'intersection failed: ' + r.error; continue; }

        // Every domain here links to all targets, so it is emitted once per
        // competitor — the RPC merges them into one row with intersect_count=N.
        const rows: UpsertRow[] = [];
        for (const it of r.items) {
          const domain = normDomain(it?.domain || it?.target || '');
          if (!domain) continue;
          for (const comp of targetList) {
            rows.push({
              domain, source: 'intersection', competitor: comp,
              dfs_rank: num(it?.rank),
              spam_score: num(it?.backlinks_spam_score),
              backlinks_count: num(it?.backlinks),
              referring_pages: num(it?.referring_pages),
              anchor: null, page_title: null,
              first_seen: str(it?.first_seen, 40),
            });
          }
        }
        const kept = await ingest(rows);
        stats.intersections.push({ geo, targets: targetList, found: kept });
        await sleep(300);
      }
    }

    // ── Phase B: broad referring-domain pull ──────────────────────────────
    // Volume. Resumes from harvested_offset so successive runs walk deeper
    // instead of re-buying the same first page.
    if (mode === 'broad' || mode === 'both' || mode === 'all') {
      for (const c of competitors) {
        if (outOfTime()) { stats.reason = 'deadline during broad pull'; break; }
        if (!affordable()) { stats.reason = 'budget spent during broad pull'; break; }

        const domain = normDomain(c.domain);
        const offset = Number(c.harvested_offset) || 0;
        // Exhausted: pagination already passed the profile's size.
        if (c.total_ref_domains && offset >= c.total_ref_domains) continue;

        const r = await dfsCall('/v3/backlinks/referring_domains/live', {
          target: domain,
          limit: rowsPerCall,
          offset,
          internal_list_limit: 10,
          backlinks_status_type: 'live',
          include_subdomains: true,
          exclude_internal_backlinks: true,
          order_by: ['rank,desc'],
          filters: [['rank', '>', MIN_RANK]],
        }, domain);
        stats.calls++;
        stats.spent += r.cost;
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
        })).filter((x: UpsertRow) => x.domain);

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

    // ── Phase C: anchors ──────────────────────────────────────────────────
    // The anchor text is what lets dfs-qualify judge a domain WITHOUT fetching
    // its page: "Bet9ja promo code" settles the question on its own. That is
    // the difference between qualifying 100k domains and qualifying 100.
    if (mode === 'anchors' || mode === 'both' || mode === 'all') {
      for (const c of competitors) {
        if (outOfTime()) { stats.reason = 'deadline during anchor pass'; break; }
        if (!affordable()) { stats.reason = 'budget spent during anchor pass'; break; }

        const domain = normDomain(c.domain);
        const r = await dfsCall('/v3/backlinks/backlinks/live', {
          target: domain,
          limit: rowsPerCall,
          mode: 'one_per_domain',       // one link per donor — don't pay for dupes
          backlinks_status_type: 'live',
          filters: [['dofollow', '=', true]],
          order_by: ['rank,desc'],
        }, domain);
        stats.calls++;
        stats.spent += r.cost;
        if (!r.ok) { stats.reason = 'backlinks failed: ' + r.error; continue; }

        const rows: UpsertRow[] = r.items.map((it: any) => ({
          domain: normDomain(it?.domain_from || ''),
          source: 'referring_domains',
          competitor: domain,
          dfs_rank: num(it?.rank ?? it?.domain_from_rank),
          spam_score: num(it?.backlink_spam_score),
          backlinks_count: null,
          referring_pages: null,
          anchor: str(it?.anchor, 500),
          page_title: str(it?.page_from_title, 500),
          first_seen: str(it?.first_seen, 40),
        })).filter((x: UpsertRow) => x.domain);

        const withAnchor = rows.filter(x => x.anchor).length;
        await ingest(rows);
        stats.anchors_filled += withAnchor;
        await sleep(300);
      }
    }

    const after = await dfsBalance();
    if (after.ok) stats.balance_after = after.balance;

    await quiet(supabase.from('error_log').insert([{
      level: 'info', service: 'dfs-harvest',
      message: `mode=${mode} calls=${stats.calls} spent=$${stats.spent.toFixed(4)} `
        + `seen=${stats.rows_seen} junk=${stats.junk_filtered} saved=${stats.saved} `
        + `anchors=${stats.anchors_filled} balance=$${(stats.balance_after ?? 0).toFixed(4)} ${stats.reason}`,
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
