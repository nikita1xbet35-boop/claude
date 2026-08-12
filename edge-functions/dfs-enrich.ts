// Supabase Edge Function: dfs-enrich
// ════════════════════════════════════════════════════════════════════════════
// Stage 3 of the DataForSEO pipeline: ENRICH.
//
// Takes leads the qualifier promoted (pipeline='dataforseo') and fills in what
// only a page fetch can tell:
//
//   1. Contacts — the same three-phase walk find-and-queue uses (homepage →
//      /advertise|/partners|/media|/press → /contact|/about). That logic is
//      proven and is reproduced here unchanged in behaviour.
//   2. Analytics ids — UA-/G-/GTM-/ca-pub-. Two sites sharing one is two sites
//      with one OWNER. Affiliates run portfolios, and an owner with twenty
//      sites is worth incomparably more than twenty cold approaches; that
//      relationship is invisible without this step.
//   3. commercial_keywords — how many commercial terms the domain actually
//      ranks for. The final professional/hobby discriminator, and the only
//      signal here that costs money, so it is rate- and balance-gated.
//
// Deploy: supabase functions deploy dfs-enrich --no-verify-jwt
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DFS_LOGIN, DFS_PASSWORD,
//      JINA_API_KEY (optional)

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const JINA_API_KEY = Deno.env.get('JINA_API_KEY') || '';
const DFS_LOGIN    = Deno.env.get('DFS_LOGIN') || '';
const DFS_PASSWORD = Deno.env.get('DFS_PASSWORD') || '';

const DEADLINE_MS      = 110_000;
const FETCH_TIMEOUT_MS = 7_000;
const BATCH            = 12;   // leads per run — each one fans out ~15 page fetches
const BODY_CAP_BYTES   = 2_500_000;

// ranked_keywords is a Labs endpoint and costs more than backlinks, so it only
// runs when the account is comfortably funded and only a few times per run.
// Without this the enricher would quietly drain a balance meant for harvesting.
const RANKED_MIN_BALANCE = 2.0;
const RANKED_PER_RUN     = 3;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function quiet(p: PromiseLike<unknown>): Promise<void> {
  try { await p; } catch { /* bookkeeping is best-effort */ }
}

// ── Email extraction (behaviour-identical to find-and-queue) ────────────────
const EMAIL_REGEX  = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const EMAIL_IGNORE = ['noreply', 'no-reply', 'unsubscribe', 'privacy', 'legal', 'abuse',
  'example', 'sentry', 'wpcf7', '@2x', '@3x', '.png', '@example', '.jpg', '.gif', '.webp', '.svg'];
const EMAIL_PLACEHOLDERS = [
  'youremail', 'your-email', 'your_email', 'yourname', 'your-name',
  'email@email', 'test@test', 'user@user', 'name@name',
  'demo@', 'sample@', 'placeholder', 'changeme', 'username@',
  'admin@example', 'info@example', 'user@example', 'test@example',
  'email@domain', 'mail@domain', 'name@domain', 'user@domain', 'email@site', 'mail@site',
];
const EMAIL_PLACEHOLDER_LOCAL = new Set(['email', 'test', 'demo', 'sample', 'info123',
  'admin123', 'example', 'noreply', 'donotreply', 'postmaster', 'mailer']);
const EMAIL_AD  = ['advertis', 'ads@', 'partner', 'sponsor', 'commercial', 'business', 'collab', 'media@', 'marketing'];
const EMAIL_GEN = ['contact', 'info@', 'hello@', 'hi@', 'enquir', 'support'];
const DISPOSABLE = ['mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail', 'throwaway'];

function isPlaceholderEmail(e: string): boolean {
  const l = e.toLowerCase();
  if (EMAIL_PLACEHOLDERS.some(p => l.includes(p))) return true;
  return EMAIL_PLACEHOLDER_LOCAL.has(l.split('@')[0]);
}
function isMalformedLocalPart(e: string): boolean {
  const local = e.split('@')[0].toLowerCase();
  if (/\.(com|net|org|co|info|me|io|news|blog|site|web)\.[a-z]{2,3}$/.test(local)) return true;
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
const emailPriority = (e: string): number => {
  const l = e.toLowerCase();
  if (EMAIL_AD.some(k => l.includes(k)))  return 1;
  if (EMAIL_GEN.some(k => l.includes(k))) return 2;
  return 3;
};
const emailType = (e: string): string => {
  const l = e.toLowerCase();
  if (EMAIL_AD.some(k => l.includes(k)))  return 'advertising';
  if (EMAIL_GEN.some(k => l.includes(k))) return 'general';
  return 'admin';
};
function deobfuscate(text: string): string {
  return text
    .replace(/([a-zA-Z0-9._%+\-]+)\s*[\[(]at[\])\s]\s*([a-zA-Z0-9.\-]+)\s*[\[(]dot[\])\s]\s*([a-zA-Z]{2,})/gi, '$1@$2.$3')
    .replace(/([a-zA-Z0-9._%+\-]+)\s+AT\s+([a-zA-Z0-9.\-]+)\s+DOT\s+([a-zA-Z]{2,})/g, '$1@$2.$3')
    .replace(/([a-zA-Z0-9._%+\-]+)\s*\[at\]\s*([a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/gi, '$1@$2')
    .replace(/([a-zA-Z0-9._%+\-]+)\s*\(at\)\s*([a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/gi, '$1@$2')
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
function extractDataAttrs(html: string): string[] {
  const found: string[] = [];
  const re1 = /data-email=["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re1.exec(html)) !== null) {
    const e = m[1].trim();
    if (isValidEmail(e)) found.push(e);
  }
  // Cloudflare's data-cfemail: hex string XORed with its own first byte.
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
    } catch { /* malformed attribute */ }
  }
  return found;
}
function extractFooter(html: string): string {
  const m = /<footer[\s\S]*?<\/footer>/gi.exec(html);
  if (m) return m[0];
  return html.slice(Math.floor(html.length * 0.8));
}

// ── Page fetching ───────────────────────────────────────────────────────────
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

let jinaCount = 0;

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
  } catch { /* fall through to Jina */ }

  try {
    jinaCount++;
    const headers: Record<string, string> = {};
    if (JINA_API_KEY) headers['Authorization'] = `Bearer ${JINA_API_KEY}`;
    const res = await fetch('https://r.jina.ai/' + url, {
      headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS + 5_000),
    });
    if (res.ok) {
      const text = await readCapped(res);
      if (text && text.length > 100) return text;
    } else {
      res.body?.cancel().catch(() => {});
    }
  } catch { /* unreachable */ }

  return null;
}

// ── Contacts ────────────────────────────────────────────────────────────────
interface Contact {
  email: string | null; emailType: string | null;
  telegram: string | null; whatsapp: string | null;
  phone: string | null; sourceUrl: string | null; source: string | null;
}

function scanContacts(html: string, page: string, acc: Contact, prio: { v: number }, label: string) {
  // Regex passes over multi-MB pages blow the edge CPU budget; contacts live
  // near the header and footer, so the middle is skipped.
  if (html.length > 260_000) html = html.slice(0, 200_000) + '\n' + html.slice(-60_000);

  const deobf  = deobfuscate(html);
  const footer = deobfuscate(extractFooter(html));
  const all = [...new Set([
    ...extractMailto(html),
    ...extractJsonLd(html),
    ...extractDataAttrs(html),
    ...(deobf.match(EMAIL_REGEX) || []),
    ...(footer.match(EMAIL_REGEX) || []),
  ])].filter(isValidEmail);

  for (const e of all) {
    const p = emailPriority(e);
    if (p < prio.v) {
      prio.v = p;
      acc.email = e;
      acc.emailType = emailType(e);
      acc.sourceUrl = page;
      acc.source = label;
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
    whatsapp: null, phone: null, sourceUrl: null, source: null,
  };
  const prio = { v: 99 };

  scanContacts(homepageHtml, siteUrl, acc, prio, 'homepage');
  if (prio.v <= 1) return acc;   // an advertising/partner address — nothing beats it

  const partnerPages = ['/advertise', '/advertising', '/partners', '/partnership',
    '/work-with-us', '/sponsor', '/media', '/press'];
  if (Date.now() < deadline) {
    const pages = await Promise.all(partnerPages.map(p =>
      fetchPage(origin + p).then(h => ({ page: origin + p, html: h }))));
    for (const { page, html } of pages) {
      if (!html || html.length < 100) continue;
      scanContacts(html, page, acc, prio, 'partners');
    }
    if (prio.v <= 1) return acc;
  }

  if (!acc.email && !acc.telegram && !acc.whatsapp && Date.now() < deadline) {
    const genericPages = ['/contact', '/contact-us', '/about', '/about-us', '/business', '/collaborate'];
    const pages = await Promise.all(genericPages.map(p =>
      fetchPage(origin + p).then(h => ({ page: origin + p, html: h }))));
    for (const { page, html } of pages) {
      if (!html || html.length < 100) continue;
      scanContacts(html, page, acc, prio, 'homepage');
    }
  }

  return acc;
}

// ── Owner fingerprints → clustering ────────────────────────────────────────
// The goal is not a site, it is an OWNER with a portfolio of 15-30 sites: one
// deal instead of thirty cold emails.
//
// Strength order matters, because one owner must not end up split across an
// AdSense cluster and a GTM cluster:
//   1. bookmaker ref-id — the same affiliate ID on two sites is the same
//      affiliate account. For our specific question this is the best signal
//      there is, and we already parse outbound links.
//   2. AdSense ca-pub — a billing account, so sharing one is sharing a payee.
//   3. UA / Facebook Pixel / Yandex Metrica — property-level, rarely shared.
//   4. GA4 G- and GTM — issued per data stream / container and routinely
//      shared by agencies, so they cluster weakly.
//
// Honest limits, worth stating because the method is often oversold:
// Universal Analytics was switched off in July 2023, so UA- only appears on old
// or abandoned sites. GA4 has no sequential numbering, which is why the G- id
// says less than the UA- one did. And competent SEOs deliberately scrub these —
// separate accounts, separate registrars, separate hosting. This catches the
// middle of the market and the people not hiding; it is a supplementary tool,
// not the backbone.
function extractAnalyticsIds(html: string): string[] {
  const ids = new Set<string>();
  const pats: RegExp[] = [
    /\bca-pub-\d{10,20}\b/gi,
    /\bUA-\d{4,12}-\d{1,4}\b/gi,
    /\bG-[A-Z0-9]{8,12}\b/g,
    /\bGTM-[A-Z0-9]{5,10}\b/g,
  ];
  for (const re of pats) {
    const found = html.match(re) || [];
    for (const f of found) ids.add(f.toUpperCase().replace('CA-PUB-', 'ca-pub-'));
  }
  // Facebook Pixel and Yandex Metrica, both initialised through a call rather
  // than appearing as a bare token, so they need their own capture.
  const fb = html.matchAll(/fbq\(\s*['"]init['"]\s*,\s*['"](\d{13,17})['"]/g);
  for (const m of fb) ids.add('FBQ-' + m[1]);
  const ym = html.matchAll(/ym\(\s*(\d{7,9})\s*,/g);
  for (const m of ym) ids.add('YM-' + m[1]);

  return [...ids].slice(0, 16);
}

/** Affiliate ids carried in outbound links to bookmakers. Two sites pushing the
 *  same affiliate id are the same affiliate account — for this program that is
 *  a harder link than any analytics tag, and it is the one thing nobody scrubs,
 *  because scrubbing it would stop them getting paid. */
function extractRefIds(html: string): string[] {
  const out = new Set<string>();
  // Only inside links that point at a bookmaker: `tag=` and `refcode=` are
  // common enough elsewhere that scanning the whole page would cluster
  // unrelated sites together.
  const links = html.matchAll(/https?:\/\/[^\s"'<>]{5,300}/g);
  const BOOKS = /(bet9ja|sportybet|betking|nairabet|betway|betpawa|premierbet|premier-bet|1win|betclic|betika|sportpesa|odibets|mozzartbet|fortebet|soccabet|msport|betano|parimatch|helabet|melbet|22bet)/i;
  for (const m of links) {
    const url = m[0];
    if (!BOOKS.test(url)) continue;
    const id = url.match(/[?&](?:site|tag|refcode|ref|btag|affid|aff_id|sub_id|clickid)=([A-Za-z0-9_\-]{3,40})/i);
    if (id) out.add('REF-' + id[1].toLowerCase());
    if (out.size >= 6) break;
  }
  return [...out];
}

/** UA-12345678-23 → 23. The suffix is the property's sequence number inside the
 *  account, so it is a direct lower bound on how many sites the owner runs —
 *  no inference required, and visible even on a single page. */
function uaPortfolioHint(ids: string[]): number | null {
  let max = 0;
  for (const id of ids) {
    const m = id.match(/^UA-\d{4,12}-(\d{1,4})$/i);
    if (m) max = Math.max(max, Number(m[1]) || 0);
  }
  return max > 1 ? max : null;
}

const idType = (id: string): string =>
  id.startsWith('REF-')    ? 'bookmaker_ref'
  : id.startsWith('ca-pub-') ? 'adsense'
  : id.startsWith('FBQ-')  ? 'fb_pixel'
  : id.startsWith('YM-')   ? 'yandex_metrica'
  : id.startsWith('GTM-')  ? 'gtm'
  : id.startsWith('UA-')   ? 'ga_ua'
  : 'ga';

/** Attach the lead to an owner cluster, creating it if new, and refresh the
 *  cluster's site count. Picks the strongest id available so one owner does not
 *  end up split across an AdSense cluster and a GTM cluster. */
async function clusterOwner(leadId: number, ids: string[]): Promise<number | null> {
  if (!ids.length) return null;
  const ranked = [...ids].sort((a, b) => {
    // Same ordering as the comment on extractAnalyticsIds: a shared payout
    // account beats a shared tag manager by a wide margin, and picking the
    // strongest available id is what stops one owner being split across two
    // clusters keyed on two different ids from the same page.
    const w = (x: string) =>
      x.startsWith('REF-')     ? 0
      : x.startsWith('ca-pub-') ? 1
      : x.startsWith('UA-')     ? 2
      : x.startsWith('FBQ-')    ? 3
      : x.startsWith('YM-')     ? 4
      : x.startsWith('GTM-')    ? 6
      : 5;
    return w(a) - w(b);
  });
  const key = ranked[0];

  const { data: existing } = await supabase.from('owner_clusters')
    .select('id').eq('cluster_key', key).maybeSingle();

  let clusterId = existing?.id ?? null;
  if (!clusterId) {
    const { data: created, error } = await supabase.from('owner_clusters')
      .insert([{ cluster_key: key, key_type: idType(key), sites_count: 1, best_lead_id: leadId }])
      .select('id').single();
    // A concurrent run may have created it between the read and the write.
    if (error) {
      const { data: retry } = await supabase.from('owner_clusters')
        .select('id').eq('cluster_key', key).maybeSingle();
      clusterId = retry?.id ?? null;
    } else {
      clusterId = created?.id ?? null;
    }
  }
  if (!clusterId) return null;

  await quiet(supabase.from('leads').update({ owner_cluster_id: clusterId }).eq('id', leadId));

  // Portfolio size AND what the portfolio is worth. A cluster of twenty hobby
  // blogs and a cluster of five properties holding real commercial volume are
  // different propositions, and the interface sorts on the second number.
  const { data: members, count } = await supabase.from('leads')
    .select('total_search_volume', { count: 'exact' }).eq('owner_cluster_id', clusterId);
  const totalVolume = (members || [])
    .reduce((s: number, r: any) => s + (Number(r.total_search_volume) || 0), 0);
  await quiet(supabase.from('owner_clusters')
    .update({ sites_count: count ?? 1, total_search_volume: totalVolume }).eq('id', clusterId));

  return clusterId;
}

// ── DataForSEO: ranked keywords ─────────────────────────────────────────────
const COMMERCIAL_RE = /\b(best|top|review|reviews|bonus|promo|promos|code|codes|comparison|compare|ranking|ranked|vs|odds|sign ?up|meilleur|meilleurs|avis|comparatif|code promo|melhor|melhores|analise|codigo|apuestas)\b/i;

const dfsAuth = () => 'Basic ' + btoa(`${DFS_LOGIN}:${DFS_PASSWORD}`);

async function dfsBalance(): Promise<number> {
  try {
    const res = await fetch('https://api.dataforseo.com/v3/appendix/user_data', {
      headers: { 'Authorization': dfsAuth() }, signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) { res.body?.cancel().catch(() => {}); return 0; }
    const d = await res.json();
    return Number(d?.tasks?.[0]?.result?.[0]?.money?.balance) || 0;
  } catch { return 0; }
}

/** Commercial keywords the domain holds in the TOP 10, and the search volume
 *  behind them.
 *
 *  v7.1: the filters moved into the request and the position window tightened
 *  from 20 to 10. Both matter. A position in the 11-20 band earns almost
 *  nothing, and a keyword with no search volume earns nothing at all — a site
 *  "ranking for 500 keys" with no traffic is a PBN node or a set of positions
 *  that are really 15-50. Filtering API-side is free, so an unqualified domain
 *  now comes back as an empty result instead of 100 paid rows we then discard.
 *
 *  This is the same measurement dfs-harvest's ranked phase makes; it runs here
 *  too because a lead promoted from the older backlinks path never passed
 *  through that phase and would otherwise have no volume figure at all. */
const RANKED_MAX_POSITION = 11;   // rank_group < 11
const RANKED_MIN_VOLUME   = 100;  // search_volume > 100

interface RankedResult { commercial: number; volume: number; top3: number; }

async function rankedCommercial(domain: string, locationCode: number): Promise<RankedResult | null> {
  try {
    const res = await fetch('https://api.dataforseo.com/v3/dataforseo_labs/google/ranked_keywords/live', {
      method: 'POST',
      headers: { 'Authorization': dfsAuth(), 'Content-Type': 'application/json' },
      body: JSON.stringify([{
        target: domain,
        location_code: locationCode,
        language_code: 'en',
        limit: 200,
        filters: [
          ['ranked_serp_element.serp_item.rank_group', '<', RANKED_MAX_POSITION],
          'and',
          ['keyword_data.keyword_info.search_volume', '>', RANKED_MIN_VOLUME],
        ],
        order_by: ['keyword_data.keyword_info.search_volume,desc'],
      }]),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) { res.body?.cancel().catch(() => {}); return null; }
    const body = await res.json();
    const task = body?.tasks?.[0];
    const cost = Number(body?.cost) || 0;
    const items = task?.result?.[0]?.items;

    await quiet(supabase.from('dfs_usage').insert([{
      endpoint: '/v3/dataforseo_labs/google/ranked_keywords/live',
      target: domain,
      rows_returned: Array.isArray(items) ? items.length : 0,
      cost_usd: cost,
      status_code: Number(task?.status_code) || null,
      error_message: Number(task?.status_code) === 20000 ? null : String(task?.status_message || '').slice(0, 200),
    }]));

    if (!Array.isArray(items)) return null;
    let commercial = 0, volume = 0, top3 = 0;
    for (const it of items) {
      const pos = Number(it?.ranked_serp_element?.serp_item?.rank_group) || 999;
      const vol = Number(it?.keyword_data?.keyword_info?.search_volume) || 0;
      // Belt and braces: if the API ignored or rejected the filter clause we
      // would otherwise count the very rows the filter exists to exclude.
      if (pos >= RANKED_MAX_POSITION || vol <= RANKED_MIN_VOLUME) continue;
      commercial++;
      volume += vol;
      if (pos <= 3) top3++;
    }
    return { commercial, volume, top3 };
  } catch { return null; }
}

// Africa location codes for the Labs endpoints.
const LOCATION_CODES: Record<string, number> = {
  NG: 2566, KE: 2404, GH: 2288, TZ: 2834, UG: 2800, CM: 2120, SN: 2686,
  ZM: 2894, ET: 2231, MZ: 2508, ML: 2466, CD: 2180, CI: 2384, BF: 2854,
};

// ── Main ────────────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  jinaCount = 0;
  const stats = {
    processed: 0, with_email: 0, with_any_contact: 0, no_contact: 0,
    analytics_found: 0, clustered: 0, ranked_checked: 0,
    portfolio_hints: 0, reason: '',
  };
  const json = (s: unknown, code = 200) => new Response(JSON.stringify(s),
    { status: code, headers: { ...cors, 'Content-Type': 'application/json' } });

  const startedAt = Date.now();
  const deadline  = startedAt + DEADLINE_MS;
  const outOfTime = () => Date.now() > deadline;

  try {
    // Only this pipeline's leads, and only ones never enriched. enriched_at is
    // this function's own marker and is stamped even when nothing is found, so a
    // dead site is not re-fetched on every tick.
    //
    // NOT contact_source: recover-contacts writes that too, so claiming on it
    // would let whichever function ran first permanently hide the lead from the
    // other.
    const { data: leads } = await supabase.from('leads')
      .select('id, url, domain_normalized, geo, contact_email, affiliate_maturity, total_search_volume')
      .eq('pipeline', 'dataforseo')
      .is('enriched_at', null)
      .order('id', { ascending: true })
      .limit(BATCH);

    if (!leads?.length) { stats.reason = 'nothing to enrich'; return json(stats); }

    let rankedBudgetLeft = 0;
    if (DFS_LOGIN && DFS_PASSWORD) {
      const bal = await dfsBalance();
      rankedBudgetLeft = bal >= RANKED_MIN_BALANCE ? RANKED_PER_RUN : 0;
      if (!rankedBudgetLeft) {
        stats.reason = `ranked_keywords skipped — balance $${bal.toFixed(2)} < $${RANKED_MIN_BALANCE}`;
      }
    }

    for (const lead of leads) {
      if (outOfTime()) { stats.reason = 'deadline'; break; }
      stats.processed++;

      let origin = '';
      try {
        origin = new URL(lead.url.startsWith('http') ? lead.url : 'https://' + lead.url).origin;
      } catch { origin = 'https://' + (lead.domain_normalized || ''); }

      const html = await fetchPage(lead.url);
      const patch: Record<string, unknown> = { enriched_at: new Date().toISOString() };

      if (html && html.length > 200) {
        const contact = await extractContact(lead.url, origin, html, deadline);

        if (contact.email) {
          patch.contact_email      = contact.email;
          patch.contact_email_type = contact.emailType;
          patch.email              = contact.email;   // legacy column kept in sync
          patch.contact_source     = contact.source || 'homepage';
          stats.with_email++;
        }
        if (contact.telegram)  { patch.contact_telegram = contact.telegram; patch.tg = contact.telegram; }
        if (contact.whatsapp)  patch.contact_whatsapp   = contact.whatsapp;
        if (contact.phone)     patch.contact_phone      = contact.phone;
        if (contact.sourceUrl) patch.contact_source_url = contact.sourceUrl;

        if (!patch.contact_source) {
          // Reached the site but found nothing — record that, so the next tick
          // moves on instead of re-fetching the same dead end forever.
          patch.contact_source = (contact.telegram || contact.whatsapp || contact.phone)
            ? 'social' : 'none';
        }
        if (contact.email || contact.telegram || contact.whatsapp || contact.phone) {
          stats.with_any_contact++;
        } else {
          stats.no_contact++;
        }

        // Analytics tags plus the bookmaker ref-ids from outbound links. The
        // ref-ids are the reason this is worth doing at all for our question:
        // the same affiliate id on two sites is one payout account.
        const ids = [...extractAnalyticsIds(html), ...extractRefIds(html)];
        if (ids.length) {
          patch.analytics_ids = ids;
          stats.analytics_found++;
          const hint = uaPortfolioHint(ids);
          if (hint) {
            patch.ua_portfolio_hint = hint;
            stats.portfolio_hints++;
          }
        }

        // ranked_keywords only for leads that are actually reachable — paying
        // to profile a site nobody can contact is money for nothing.
        const geo = String(lead.geo || '').toUpperCase().slice(0, 2);
        const loc = LOCATION_CODES[geo];
        // Skip leads the harvest phase already profiled — paying twice for the
        // same measurement is how a qualification step turns into a money leak.
        if (rankedBudgetLeft > 0 && loc && (contact.email || contact.telegram)
            && lead.total_search_volume === null) {
          const r = await rankedCommercial(lead.domain_normalized || origin.replace(/^https?:\/\//, ''), loc);
          rankedBudgetLeft--;
          stats.ranked_checked++;
          if (r !== null) {
            patch.commercial_keywords = r.commercial;
            patch.total_search_volume = r.volume;
            patch.top3_keywords       = r.top3;
            // Same thresholds as dfs-harvest and dfs-qualify (v7.1 §2 step 2),
            // so a lead's maturity does not depend on which stage happened to
            // measure it.
            if (r.commercial >= 15 && r.volume >= 10_000) {
              patch.affiliate_maturity = 'professional';
            } else if (r.commercial >= 5 && lead.affiliate_maturity === 'hobby') {
              patch.affiliate_maturity = 'semi_pro';
            }
          }
        }
      } else {
        patch.contact_source = 'unreachable';
        stats.no_contact++;
      }

      await quiet(supabase.from('leads').update(patch).eq('id', lead.id));

      if (Array.isArray(patch.analytics_ids) && (patch.analytics_ids as string[]).length) {
        const cid = await clusterOwner(lead.id, patch.analytics_ids as string[]);
        if (cid) stats.clustered++;
      }
    }

    await quiet(supabase.from('error_log').insert([{
      level: 'info', service: 'dfs-enrich',
      message: `processed=${stats.processed} email=${stats.with_email} `
        + `any=${stats.with_any_contact} none=${stats.no_contact} `
        + `analytics=${stats.analytics_found} clustered=${stats.clustered} `
        + `portfolio=${stats.portfolio_hints} `
        + `ranked=${stats.ranked_checked} jina=${jinaCount} ${stats.reason}`,
    }]));

    return json(stats);
  } catch (e: any) {
    await quiet(supabase.from('error_log').insert([{
      level: 'critical', service: 'dfs-enrich', message: String(e?.message || e),
    }]));
    return json({ ...stats, error: String(e?.message || e) }, 500);
  }
});
