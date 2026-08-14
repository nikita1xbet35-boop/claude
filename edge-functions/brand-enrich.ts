// Supabase Edge Function: brand-enrich
// ════════════════════════════════════════════════════════════════════════════
// Stage 2 of the BRAND pipeline (v8). Fetches each new lead's page and fills in
// what only the page itself can tell:
//
//   1. Contacts — same three-phase walk as the rest of the system, but with
//      Telegram promoted. Brand-traffic sites frequently have no email at all
//      and a TG link in the header; treating TG as a fallback here would throw
//      away most of the module's reachable partners.
//   2. Referral parameters from outbound bookmaker links. Two sites carrying the
//      same affiliate id are one owner — for this program that is the hardest
//      ownership signal there is, and the one nobody scrubs, because scrubbing
//      it means not getting paid.
//   3. has_apk — a direct .apk link or a download button. The confirmed
//      35 000-FTD-a-month model runs on APK traffic, so this is a quality mark,
//      not a curiosity.
//   4. suspected_official — the safety net for operator mirrors that are not in
//      official_domains. Never blocks; only keeps the lead out of automatic
//      sending until a human looks.
//
// Deploy: supabase functions deploy brand-enrich --no-verify-jwt
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, JINA_API_KEY (optional)

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const JINA_API_KEY = Deno.env.get('JINA_API_KEY') || '';

const DEADLINE_MS      = 110_000;
const FETCH_TIMEOUT_MS = 7_000;
const BATCH            = 10;
const BODY_CAP_BYTES   = 2_000_000;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function quiet(p: PromiseLike<unknown>): Promise<void> {
  try { await p; } catch { /* bookkeeping is best-effort */ }
}

// ── Email extraction ────────────────────────────────────────────────────────
const EMAIL_REGEX  = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const EMAIL_IGNORE = ['noreply', 'no-reply', 'unsubscribe', 'privacy', 'legal', 'abuse',
  'example', 'sentry', 'wpcf7', '@2x', '@3x', '.png', '.jpg', '.gif', '.webp', '.svg'];
const EMAIL_PLACEHOLDERS = ['youremail', 'your-email', 'yourname', 'email@email',
  'test@test', 'user@user', 'demo@', 'sample@', 'placeholder', 'changeme',
  'email@domain', 'mail@domain', 'name@domain'];
const DISPOSABLE = ['mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail', 'throwaway'];
const EMAIL_AD  = ['advertis', 'ads@', 'partner', 'sponsor', 'commercial', 'business', 'collab', 'media@', 'marketing'];
const EMAIL_GEN = ['contact', 'info@', 'hello@', 'hi@', 'enquir', 'support', 'admin'];

function isValidEmail(e: string): boolean {
  if (!e || e.length > 100 || !e.includes('@') || !e.includes('.')) return false;
  const l = e.toLowerCase();
  if (EMAIL_IGNORE.some(ig => l.includes(ig)))     return false;
  if (EMAIL_PLACEHOLDERS.some(p => l.includes(p))) return false;
  if (DISPOSABLE.some(d => l.includes(d)))         return false;
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
    .replace(/([a-zA-Z0-9._%+\-]+)\s*\[at\]\s*([a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/gi, '$1@$2')
    .replace(/([a-zA-Z0-9._%+\-]+)\s*\(at\)\s*([a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/gi, '$1@$2');
}
function extractMailto(html: string): string[] {
  const found: string[] = [];
  const re = /href=["']mailto:([^"'?&\s]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const e = decodeURIComponent(m[1]).trim();
    if (isValidEmail(e)) found.push(e);
  }
  return found;
}
function extractCfEmail(html: string): string[] {
  const found: string[] = [];
  const re = /data-cfemail=["']([0-9a-f]+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      const hex = m[1];
      const key = parseInt(hex.slice(0, 2), 16);
      let email = '';
      for (let i = 2; i < hex.length; i += 2) {
        email += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
      }
      if (isValidEmail(email)) found.push(email);
    } catch { /* malformed */ }
  }
  return found;
}

// ── Page fetching ───────────────────────────────────────────────────────────
async function readCapped(res: Response): Promise<string> {
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (ct && !ct.includes('text/') && !ct.includes('html') && !ct.includes('json')) {
    res.body?.cancel().catch(() => {});
    return '';
  }
  const reader = res.body?.getReader();
  if (!reader) return (await res.text()).slice(0, BODY_CAP_BYTES);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < BODY_CAP_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
  } finally { reader.cancel().catch(() => {}); }
  const buf = new Uint8Array(Math.min(total, BODY_CAP_BYTES));
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
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'follow',
    });
    if (res.ok) {
      const text = await readCapped(res);
      if (text && text.length > 200) return text;
    } else { res.body?.cancel().catch(() => {}); }
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
    } else { res.body?.cancel().catch(() => {}); }
  } catch { /* unreachable */ }
  return null;
}

// ── Brand-specific signals ──────────────────────────────────────────────────
// Bookmakers whose outbound links are worth reading a referral id out of.
const BOOKS_RE = /(1xbet|melbet|betwinner|megapari|paripesa|22bet|linebet|1win|mostbet|pin-?up|parimatch|bet9ja|sportybet|betking|nairabet|merrybet|betika|sportpesa|odibets|mozzartbet|betway|betpawa|soccabet|fortebet|premierbet|premier-bet|betclic|sunubet|meridianbet|betano|dafabet|10cric|rajabets)/i;

/** Referral ids carried in outbound links to bookmakers.
 *
 *  Scoped to links that actually point at a book: `tag=` and `ref=` are common
 *  enough on the open web that scanning every URL on the page would cluster
 *  unrelated sites together and quietly corrupt the owner graph. */
function extractRefParams(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  const links = html.matchAll(/https?:\/\/[^\s"'<>]{5,300}/g);
  const PARAM_RE = /[?&](site|tag|refcode|ref|sub_id|subid|click_id|clickid|btag|affid|aff_id|partner)=([A-Za-z0-9_\-]{2,40})/gi;
  for (const m of links) {
    const url = m[0];
    if (!BOOKS_RE.test(url)) continue;
    let p: RegExpExecArray | null;
    PARAM_RE.lastIndex = 0;
    while ((p = PARAM_RE.exec(url)) !== null) {
      const k = p[1].toLowerCase();
      if (!out[k]) out[k] = p[2];
      if (Object.keys(out).length >= 8) return out;
    }
  }
  return out;
}

/** A direct APK link or a download button pointing at one. */
function detectApk(html: string): boolean {
  if (/href=["'][^"']*\.apk(["'?#]|$)/i.test(html)) return true;
  if (/\.apk["'\s>]/i.test(html) && /download|скачать|télécharger|baixar|yuklab|indir|pakua/i.test(html)) return true;
  return false;
}

// ── Parked / dead domains ───────────────────────────────────────────────────
// A parked page has no owner to write to. Detecting it BEFORE contact
// extraction also skips ~15 page fetches per lead that were only ever going to
// find the registrar's support address.
const PARKED_MARKERS = [
  'domain is parked', 'this domain is for sale', 'buy this domain',
  'domain for sale', 'this website is for sale', 'future home of',
  'parked free', 'parking page', 'domain parking',
  'домен продаётся', 'сайт временно недоступен', 'домен припаркован',
  'parkingcrew', 'sedoparking', 'bodis.com', 'afternic', 'dan.com',
  'default web site page', 'welcome to nginx', 'apache2 ubuntu default page',
  'index of /', 'account suspended', 'this account has been suspended',
];

/** Text content with markup stripped — the structural checks below need to see
 *  how much a human would actually read, not how much HTML there is. */
function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Returns a reason when the page is parked/dead, null when it is a real site. */
function detectParked(html: string, text: string): string | null {
  const low = html.toLowerCase();
  for (const m of PARKED_MARKERS) {
    if (low.includes(m)) return `parked marker: ${m}`;
  }
  // Structural: a real affiliate page is not 500 characters long, and it links
  // somewhere. Both conditions together, because a short page with real
  // internal navigation may just be a thin landing.
  const internalLinks = (html.match(/href=["'](?!https?:|mailto:|tel:|#|javascript:)[^"']+["']/gi) || []).length;
  if (text.length < 500 && internalLinks === 0) return 'no content and no internal links';
  return null;
}

/** The brand this domain was found for must actually appear on the page.
 *
 *  A domain surfaced by the query "mostbet apk" that never says "mostbet" has
 *  changed since it was indexed — resold, parked, or the redirect was pulled.
 *  Whatever it is now, it is not the site the search found. */
function brandMismatch(html: string, text: string, brand: string): boolean {
  const stem = String(brand || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!stem || stem.length < 3) return false;   // too short to test honestly
  const hay = (text + ' ' + html).toLowerCase().replace(/[^a-z0-9]/g, '');
  return !hay.includes(stem);
}

// ── Operator-mirror heuristic ───────────────────────────────────────────────
// Second-level suffixes where the registrable label sits one further left:
// betway.co.ke's brand label is "betway", not "co".
const SLD_SUFFIXES = new Set([
  'co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'or', 'ne', 'go', 'web',
]);

/** The label a brand would occupy in a bare-brand domain.
 *  1win.xyz → "1win" · betway.co.ke → "betway" · ke.kamabet.com → "kamabet" */
function brandLabel(domain: string): string {
  const parts = String(domain || '').toLowerCase().replace(/^www\./, '').split('.');
  if (parts.length < 2) return parts[0] || '';
  const candidate = parts[parts.length - 2];
  if (SLD_SUFFIXES.has(candidate) && parts.length >= 3) return parts[parts.length - 3];
  return candidate;
}

// Zones where operators concentrate their mirrors. Not a blocklist — only a
// reason to look harder at a domain that already matched the bare-brand shape.
const MIRROR_TLDS = new Set([
  'xyz', 'social', 'bet', 'win', 'vip', 'pro', 'site', 'online',
  'club', 'icu', 'top', 'fyi', 'live', 'cyou', 'sbs',
]);

/** Operator-mirror heuristic. Returns a human-readable reason, or null.
 *
 *  THE SHAPE THAT MATTERS: a bare brand on some TLD. 1win.xyz is the operator's
 *  own mirror; operators run those on dozens of zones to survive blocking, and
 *  no explicit list can keep up. Affiliates almost always add a modifier —
 *  1winbonus.com, mostbet-app.net, bet9ja-apk.com — because they cannot
 *  register the bare brand and would not want to.
 *
 *  The previous version tested `domain.includes(brand)`, which flagged
 *  1winbonus.com as a mirror: exactly backwards, since the modifier is what
 *  proves it ISN'T one.
 *
 *  A flag only, never a block. The explicit official_domains list exists
 *  precisely because 1win.fyi (affiliate, our best kind of lead) and 1win.com
 *  (operator) cannot be told apart by domain shape alone — so a heuristic gets
 *  to withhold from automatic sending and ask a human, nothing more. */
function suspectedOfficial(
  html: string, domain: string, brand: string, refCount: number, emailDomain: string,
): string | null {
  const stem = String(brand || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!stem || stem.length < 4) return null;
  const label = brandLabel(domain).replace(/[^a-z0-9]/g, '');
  // Bare brand and nothing else. A modifier here means affiliate, and we stop.
  if (label !== stem) return null;

  const signals: string[] = [];
  signals.push('bare brand domain');

  const tld = domain.split('.').pop() || '';
  if (MIRROR_TLDS.has(tld)) signals.push(`mirror-prone .${tld}`);

  // Its own account system, not a download button pointing elsewhere.
  const hasOwnAuth = /<input[^>]+type=["']password["']/i.test(html)
    || /<form[^>]*>[\s\S]{0,2000}?(type=["']password["']|name=["']password["'])/i.test(html);
  if (hasOwnAuth) signals.push('login form');

  // Contact on the domain itself. support@1win.xyz is the product talking;
  // partner@othersite.com is a shopfront talking about the product.
  if (emailDomain && brandLabel(emailDomain) === label) signals.push('same-domain contact');

  // An affiliate links out to the book with a tracking id — that is how it
  // gets paid. Nothing outbound is the strongest hint it IS the book.
  if (refCount === 0) signals.push('no outbound referral links');

  // The bare-brand shape alone is suspicious but not enough: an affiliate can
  // genuinely own a homonym domain. Require corroboration from the page.
  const corroborated = hasOwnAuth
    || signals.includes('same-domain contact')
    || (refCount === 0 && MIRROR_TLDS.has(tld));
  return corroborated ? signals.join(' + ') : null;
}

/** Attach the lead to an owner cluster keyed on a shared referral id. */
async function clusterByRef(leadId: number, refs: Record<string, string>): Promise<number | null> {
  const entries = Object.entries(refs);
  if (!entries.length) return null;
  // One key per site, deterministically chosen, so two sites with the same id
  // land in the same cluster regardless of what else is on their pages.
  const [k, v] = entries.sort((a, b) => a[0].localeCompare(b[0]))[0];
  const key = `REF-${k}-${v}`.toLowerCase();

  const { data: existing } = await supabase.from('owner_clusters')
    .select('id').eq('cluster_key', key).maybeSingle();
  let clusterId = existing?.id ?? null;
  if (!clusterId) {
    const { data: created, error } = await supabase.from('owner_clusters')
      .insert([{ cluster_key: key, key_type: 'bookmaker_ref', sites_count: 1, best_lead_id: leadId }])
      .select('id').single();
    if (error) {
      const { data: retry } = await supabase.from('owner_clusters')
        .select('id').eq('cluster_key', key).maybeSingle();
      clusterId = retry?.id ?? null;
    } else { clusterId = created?.id ?? null; }
  }
  if (!clusterId) return null;

  await quiet(supabase.from('leads').update({ owner_cluster_id: clusterId }).eq('id', leadId));
  const { count } = await supabase.from('leads')
    .select('id', { count: 'exact', head: true }).eq('owner_cluster_id', clusterId);
  await quiet(supabase.from('owner_clusters').update({ sites_count: count ?? 1 }).eq('id', clusterId));
  return clusterId;
}

// ── Contact scan ────────────────────────────────────────────────────────────
interface Contact {
  email: string | null; emailType: string | null;
  telegram: string | null; whatsapp: string | null;
  sourceUrl: string | null; source: string | null;
}

function scanContacts(html: string, page: string, acc: Contact, prio: { v: number }, label: string) {
  if (html.length > 260_000) html = html.slice(0, 200_000) + '\n' + html.slice(-60_000);
  const deobf = deobfuscate(html);
  const all = [...new Set([
    ...extractMailto(html),
    ...extractCfEmail(html),
    ...(deobf.match(EMAIL_REGEX) || []),
  ])].filter(isValidEmail);

  for (const e of all) {
    const p = emailPriority(e);
    if (p < prio.v) {
      prio.v = p; acc.email = e; acc.emailType = emailType(e);
      acc.sourceUrl = page; acc.source = label;
    }
  }
  if (!acc.telegram) {
    const m = html.match(/t\.me\/([a-zA-Z][a-zA-Z0-9_]{4,})/);
    if (m && !['share', 'msg', 'joinchat', 'iv', 'addstickers'].includes(m[1])) acc.telegram = '@' + m[1];
  }
  if (!acc.whatsapp) {
    const m = html.match(/wa\.me\/(\d{7,})/);
    if (m) acc.whatsapp = '+' + m[1];
  }
}

// ── Main ────────────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  jinaCount = 0;
  const stats = {
    processed: 0, with_email: 0, with_telegram: 0, no_contact: 0,
    with_apk: 0, with_refs: 0, clustered: 0, suspected_official: 0,
    parked: 0, brand_mismatch: 0, registrar_contact: 0, reason: '',
  };
  const json = (s: unknown, code = 200) => new Response(JSON.stringify(s),
    { status: code, headers: { ...cors, 'Content-Type': 'application/json' } });

  const startedAt = Date.now();
  const deadline  = startedAt + DEADLINE_MS;

  try {
    const { data: leads } = await supabase.from('leads')
      .select('id, url, domain_normalized, brand_found, exclude_reason')
      .eq('pipeline', 'brand')
      .is('enriched_at', null)
      .order('serp_position', { ascending: true, nullsFirst: false })
      .limit(BATCH);

    if (!leads?.length) { stats.reason = 'nothing to enrich'; return json(stats); }

    // Registrar / hosting / parking domains. An address on one of these is
    // infrastructure support, not the site's owner.
    const { data: regRows } = await supabase.from('registrar_domains').select('domain');
    const registrars = new Set((regRows || [])
      .map((r: any) => String(r.domain || '').toLowerCase()).filter(Boolean));

    /** True when the address belongs to a registrar rather than to this site.
     *  Compared against a FOREIGN domain only: mail@hostinger.com on
     *  hostinger.com would be the owner's own perfectly legitimate address. */
    const isRegistrarEmail = (email: string, leadDomain: string): boolean => {
      const d = String(email || '').toLowerCase().split('@')[1] || '';
      if (!d) return false;
      if (d === String(leadDomain || '').toLowerCase()) return false;
      return registrars.has(d) || [...registrars].some(r => d.endsWith('.' + r));
    };

    for (const lead of leads) {
      if (Date.now() > deadline) { stats.reason = 'deadline'; break; }
      stats.processed++;

      let origin = '';
      try {
        origin = new URL(lead.url.startsWith('http') ? lead.url : 'https://' + lead.url).origin;
      } catch { origin = 'https://' + (lead.domain_normalized || ''); }

      const html = await fetchPage(lead.url);
      const patch: Record<string, unknown> = { enriched_at: new Date().toISOString() };

      if (!html || html.length < 200) {
        patch.contact_source = 'unreachable';
        stats.no_contact++;
        await quiet(supabase.from('leads').update(patch).eq('id', lead.id));
        continue;
      }

      const text = visibleText(html);

      // ── Cheap rejections, BEFORE any contact work ─────────────────────────
      // Both of these end with "there is nobody here to write to", and the
      // contact walk costs ~15 page fetches per lead. Doing it first is the
      // difference between spending that on real candidates and spending it
      // discovering a registrar's support address.
      const parkedWhy = detectParked(html, text);
      if (parkedWhy) {
        patch.reject_reason  = 'parked_domain';
        patch.exclude_reason = 'parked_domain';
        patch.stage = 'excluded';
        patch.contact_source = 'parked';
        stats.parked++;
        await quiet(supabase.from('leads').update(patch).eq('id', lead.id));
        continue;
      }

      if (brandMismatch(html, text, lead.brand_found || '')) {
        patch.reject_reason  = 'brand_mismatch';
        patch.exclude_reason = 'brand_mismatch';
        patch.stage = 'excluded';
        patch.contact_source = 'brand_mismatch';
        stats.brand_mismatch++;
        await quiet(supabase.from('leads').update(patch).eq('id', lead.id));
        continue;
      }

      // Brand signals come off the landing page itself — the referral links and
      // the APK button are on the page the searcher lands on, not on /contact.
      const refs = extractRefParams(html);
      const refCount = Object.keys(refs).length;
      if (refCount) { patch.ref_params = refs; stats.with_refs++; }

      const hasApk = detectApk(html);
      patch.has_apk = hasApk;
      if (hasApk) stats.with_apk++;

      // Contacts: homepage, then the pages that carry a business address.
      const acc: Contact = { email: null, emailType: null, telegram: null, whatsapp: null, sourceUrl: null, source: null };
      const prio = { v: 99 };
      scanContacts(html, lead.url, acc, prio, 'homepage');

      if (prio.v > 1 && Date.now() < deadline) {
        const pages = ['/contact', '/contacts', '/about', '/advertise', '/partners'];
        const fetched = await Promise.all(pages.map(p =>
          fetchPage(origin + p).then(h => ({ page: origin + p, html: h }))));
        for (const { page, html: h } of fetched) {
          if (!h || h.length < 100) continue;
          scanContacts(h, page, acc, prio, 'contact_page');
        }
      }

      // A registrar's support address is not a person who can agree to
      // anything. Dropped rather than stored, so it cannot be mistaken for a
      // working contact later — but recorded as the reason, so the lead reads
      // as "no reachable owner" instead of silently as "no contact found".
      if (acc.email && isRegistrarEmail(acc.email, lead.domain_normalized || '')) {
        patch.reject_reason = 'registrar_contact';
        stats.registrar_contact++;
        acc.email = null;
        acc.emailType = null;
        acc.source = 'registrar';
      }

      // The mirror heuristic wants the contact domain, so it runs after the
      // contact walk: support@1win.xyz on 1win.xyz is the product talking,
      // and that is the single most telling signal available here.
      const suspect = suspectedOfficial(
        html, lead.domain_normalized || '', lead.brand_found || '', refCount,
        String(acc.email || '').split('@')[1] || '',
      );
      if (suspect) {
        patch.suspected_official = true;
        patch.suspected_reason   = suspect;
        // Kept out of automatic sending, not deleted — this is a heuristic and
        // heuristics are wrong often enough that a human must confirm.
        if (!lead.exclude_reason) {
          patch.exclude_reason = 'suspected_official';
          patch.reject_reason  = 'suspected_official';
        }
        stats.suspected_official++;
      }

      if (acc.email) {
        patch.contact_email      = acc.email;
        patch.contact_email_type = acc.emailType;
        patch.email              = acc.email;
        patch.contact_source     = acc.source || 'homepage';
        stats.with_email++;
      }
      if (acc.telegram) {
        patch.contact_telegram = acc.telegram;
        patch.tg = acc.telegram;
        stats.with_telegram++;
      }
      if (acc.whatsapp) patch.contact_whatsapp = acc.whatsapp;
      if (acc.sourceUrl) patch.contact_source_url = acc.sourceUrl;

      if (!patch.contact_source) {
        // Telegram counts as reached here. On brand-traffic sites a TG link is
        // frequently the ONLY contact the owner publishes, and recording those
        // as 'none' would write off most of the module's reachable partners.
        patch.contact_source = acc.telegram ? 'telegram' : (acc.whatsapp ? 'social' : 'none');
      }
      if (!acc.email && !acc.telegram && !acc.whatsapp) stats.no_contact++;

      await quiet(supabase.from('leads').update(patch).eq('id', lead.id));

      if (refCount) {
        const cid = await clusterByRef(lead.id, refs);
        if (cid) stats.clustered++;
      }
    }

    await quiet(supabase.from('error_log').insert([{
      level: 'info', service: 'brand-enrich',
      message: `processed=${stats.processed} email=${stats.with_email} tg=${stats.with_telegram} `
        + `none=${stats.no_contact} apk=${stats.with_apk} refs=${stats.with_refs} `
        + `clustered=${stats.clustered} suspect=${stats.suspected_official} `
        + `parked=${stats.parked} mismatch=${stats.brand_mismatch} `
        + `registrar=${stats.registrar_contact} jina=${jinaCount} ${stats.reason}`,
    }]));

    return json(stats);
  } catch (e: any) {
    await quiet(supabase.from('error_log').insert([{
      level: 'critical', service: 'brand-enrich', message: String(e?.message || e),
    }]));
    return json({ ...stats, error: String(e?.message || e) }, 500);
  }
});
