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

// ── Analytics ids → owner clustering ───────────────────────────────────────
// AdSense (ca-pub-) is the strongest of the three: it is a billing account, so
// sharing one is sharing a payee. GA identifies a property, GTM only a
// container — both are routinely shared by agencies, hence the ranking.
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
  return [...ids].slice(0, 12);
}

const idType = (id: string): string =>
  id.startsWith('ca-pub-') ? 'adsense'
  : id.startsWith('GTM-')  ? 'gtm'
  : 'ga';

/** Attach the lead to an owner cluster, creating it if new, and refresh the
 *  cluster's site count. Picks the strongest id available so one owner does not
 *  end up split across an AdSense cluster and a GTM cluster. */
async function clusterOwner(leadId: number, ids: string[]): Promise<number | null> {
  if (!ids.length) return null;
  const ranked = [...ids].sort((a, b) => {
    const w = (x: string) => x.startsWith('ca-pub-') ? 0 : x.startsWith('GTM-') ? 2 : 1;
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

  const { count } = await supabase.from('leads')
    .select('id', { count: 'exact', head: true }).eq('owner_cluster_id', clusterId);
  await quiet(supabase.from('owner_clusters')
    .update({ sites_count: count ?? 1 }).eq('id', clusterId));

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

/** Commercial keywords the domain ranks for in the top 20. This is the money
 *  question: informational long-tail is a hobby blog, commercial terms mean
 *  somebody paid for that position. */
async function rankedCommercial(domain: string, locationCode: number): Promise<number | null> {
  try {
    const res = await fetch('https://api.dataforseo.com/v3/dataforseo_labs/google/ranked_keywords/live', {
      method: 'POST',
      headers: { 'Authorization': dfsAuth(), 'Content-Type': 'application/json' },
      body: JSON.stringify([{
        target: domain,
        location_code: locationCode,
        language_code: 'en',
        limit: 100,
        order_by: ['ranked_serp_element.serp_item.rank_group,asc'],
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
    let n = 0;
    for (const it of items) {
      const kw = String(it?.keyword_data?.keyword || '');
      const pos = Number(it?.ranked_serp_element?.serp_item?.rank_group) || 999;
      if (pos <= 20 && COMMERCIAL_RE.test(kw)) n++;
    }
    return n;
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
    analytics_found: 0, clustered: 0, ranked_checked: 0, reason: '',
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
      .select('id, url, domain_normalized, geo, contact_email, affiliate_maturity')
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

        const ids = extractAnalyticsIds(html);
        if (ids.length) {
          patch.analytics_ids = ids;
          stats.analytics_found++;
        }

        // ranked_keywords only for leads that are actually reachable — paying
        // to profile a site nobody can contact is money for nothing.
        const geo = String(lead.geo || '').toUpperCase().slice(0, 2);
        const loc = LOCATION_CODES[geo];
        if (rankedBudgetLeft > 0 && loc && (contact.email || contact.telegram)) {
          const n = await rankedCommercial(lead.domain_normalized || origin.replace(/^https?:\/\//, ''), loc);
          rankedBudgetLeft--;
          stats.ranked_checked++;
          if (n !== null) {
            patch.commercial_keywords = n;
            // 10+ commercial terms in the top 20 is a paid-for SEO position —
            // promote the maturity verdict the qualifier could only guess at
            // from a single anchor string.
            if (n >= 10 && lead.affiliate_maturity !== 'professional') {
              patch.affiliate_maturity = 'professional';
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
