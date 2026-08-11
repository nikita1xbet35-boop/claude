// Supabase Edge Function: recover-contacts
// ════════════════════════════════════════════════════════════════════════════
// Salvage pass over leads that were qualified but came back with no contact.
//
// ~4000 sites sit in the base in exactly that state: found, judged relevant, and
// then abandoned because the homepage walk found no address. The homepage is not
// the only place a contact exists, and these are already-vetted sites — cheaper
// to reopen than to find 4000 new ones.
//
// Three sources, tried in descending yield:
//
//   1. ARCHIVE.ORG. Affiliates hide their address over time; Wayback snapshots
//      from 2021-2023 usually still have it in plain text. Free. Rate-limited by
//      courtesy to ~1 request/second — this is somebody's donated infrastructure.
//   2. WORDPRESS REST API. Most affiliate sites are WordPress and many leave
//      /wp-json/wp/v2/users open, which yields an author NAME. A name plus a
//      domain is a person you can find and message directly, and that converts
//      far better than info@.
//   3. FOOTER SOCIALS. Telegram/X/Facebook/Instagram links — frequently a warmer
//      channel than email regardless.
//
// Every attempt stamps contact_recovery_at, found or not, so a dead site is
// tried once instead of on every tick. contact_source records WHICH method won,
// so the yield of each is measurable rather than assumed.
//
// Contact-form submission is deliberately not duplicated here — find-contact-form
// and process-form-queue already cover that channel.
//
// Deploy: supabase functions deploy recover-contacts --no-verify-jwt
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const DEADLINE_MS      = 110_000;
const BATCH            = 8;      // each lead costs several external round trips
const FETCH_TIMEOUT_MS = 9_000;
// Archive.org is donated infrastructure. One request per second is the published
// courtesy limit and there is no reason to push it.
const ARCHIVE_GAP_MS   = 1_100;
const MAX_SNAPSHOTS    = 3;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function quiet(p: PromiseLike<unknown>): Promise<void> {
  try { await p; } catch { /* bookkeeping is best-effort */ }
}

// ── Email validity (same rules the rest of the pipeline uses) ───────────────
const EMAIL_REGEX  = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const EMAIL_IGNORE = ['noreply', 'no-reply', 'unsubscribe', 'privacy', 'legal', 'abuse',
  'example', 'sentry', 'wpcf7', '@2x', '@3x', '.png', '@example', '.jpg', '.gif', '.webp', '.svg',
  'archive.org', 'web.archive.org'];
const EMAIL_PLACEHOLDERS = [
  'youremail', 'your-email', 'your_email', 'yourname', 'your-name',
  'email@email', 'test@test', 'user@user', 'name@name',
  'demo@', 'sample@', 'placeholder', 'changeme', 'username@',
  'admin@example', 'info@example', 'user@example', 'test@example',
  'email@domain', 'mail@domain', 'name@domain', 'user@domain', 'email@site', 'mail@site',
];
const PLACEHOLDER_LOCAL = new Set(['email', 'test', 'demo', 'sample', 'info123',
  'admin123', 'example', 'noreply', 'donotreply', 'postmaster', 'mailer']);
const DISPOSABLE = ['mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail', 'throwaway'];
const EMAIL_AD  = ['advertis', 'ads@', 'partner', 'sponsor', 'commercial', 'business', 'collab', 'media@', 'marketing'];
const EMAIL_GEN = ['contact', 'info@', 'hello@', 'hi@', 'enquir', 'support'];

function isValidEmail(e: string): boolean {
  if (!e || e.length > 100 || !e.includes('@') || !e.includes('.')) return false;
  const l = e.toLowerCase();
  if (EMAIL_IGNORE.some(ig => l.includes(ig))) return false;
  if (EMAIL_PLACEHOLDERS.some(p => l.includes(p))) return false;
  if (PLACEHOLDER_LOCAL.has(l.split('@')[0])) return false;
  if (DISPOSABLE.some(d => l.includes(d))) return false;
  const local = l.split('@')[0];
  if (/\.(com|net|org|co|info|me|io|news|blog|site|web)\.[a-z]{2,3}$/.test(local)) return false;
  if (/^\.|\.$|\.\./.test(local)) return false;
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

/** Pick the best address out of a page: an advertising/partnership inbox beats a
 *  generic one, which beats a personal one. */
function bestEmail(html: string, domain: string): string | null {
  const found = [...new Set(html.match(EMAIL_REGEX) || [])].filter(isValidEmail);
  if (!found.length) return null;
  // Prefer an address on the site's own domain — Wayback pages are full of other
  // people's addresses (comment threads, ad network boilerplate, footers).
  const stem = domain.split('.')[0];
  const own = found.filter(e => e.toLowerCase().split('@')[1]?.includes(stem));
  const pool = own.length ? own : found;
  return pool.sort((a, b) => emailPriority(a) - emailPriority(b))[0];
}

async function getText(url: string, timeout = FETCH_TIMEOUT_MS): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AffiliateOS/1.0)' },
      signal: AbortSignal.timeout(timeout),
      redirect: 'follow',
    });
    if (!res.ok) { res.body?.cancel().catch(() => {}); return null; }
    const t = await res.text();
    return t.length > 3_000_000 ? t.slice(0, 3_000_000) : t;
  } catch { return null; }
}

// ── 1. Archive.org ──────────────────────────────────────────────────────────
/** Ask the CDX index which /contact* snapshots exist, then read the newest few.
 *  Ordered newest-first: a 2023 address is likelier to still work than a 2019 one. */
async function tryArchive(domain: string, deadline: number): Promise<string | null> {
  const cdx = `http://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(domain)}/contact*`
    + `&output=json&limit=20&filter=statuscode:200&collapse=urlkey`;
  const raw = await getText(cdx, 12_000);
  await sleep(ARCHIVE_GAP_MS);
  if (!raw) return null;

  let rows: string[][];
  try { rows = JSON.parse(raw); } catch { return null; }
  if (!Array.isArray(rows) || rows.length < 2) return null;

  // Row 0 is the header. Columns: urlkey, timestamp, original, mimetype, ...
  const header = rows[0];
  const tsIdx  = header.indexOf('timestamp');
  const urlIdx = header.indexOf('original');
  if (tsIdx < 0 || urlIdx < 0) return null;

  const snaps = rows.slice(1)
    .filter(r => r[tsIdx] && r[urlIdx])
    .sort((a, b) => String(b[tsIdx]).localeCompare(String(a[tsIdx])))
    .slice(0, MAX_SNAPSHOTS);

  for (const s of snaps) {
    if (Date.now() > deadline) break;
    const html = await getText(`http://web.archive.org/web/${s[tsIdx]}/${s[urlIdx]}`, 12_000);
    await sleep(ARCHIVE_GAP_MS);
    if (!html) continue;
    // mailto: first — an explicit link is far less likely to be a false positive
    // than a bare string somewhere in an archived page.
    const mailto = [...html.matchAll(/href=["']mailto:([^"'?&\s]+)/gi)]
      .map(m => decodeURIComponent(m[1]).trim())
      .filter(isValidEmail);
    if (mailto.length) return mailto.sort((a, b) => emailPriority(a) - emailPriority(b))[0];
    const e = bestEmail(html, domain);
    if (e) return e;
  }
  return null;
}

// ── 2. WordPress REST API ───────────────────────────────────────────────────
/** An open users endpoint gives author names. Not an address, but a person —
 *  and a named person at a known domain is a far better opening than info@. */
async function tryWordPress(origin: string): Promise<{ person: string | null; email: string | null }> {
  const raw = await getText(origin + '/wp-json/wp/v2/users?per_page=10', 8_000);
  if (!raw) return { person: null, email: null };
  try {
    const users = JSON.parse(raw);
    if (!Array.isArray(users) || !users.length) return { person: null, email: null };
    const named = users
      .map((u: any) => String(u?.name || '').trim())
      .filter(n => n && n.length < 80 && !/^(admin|administrator|editor|user|author)$/i.test(n));
    // Some misconfigured installs leak the address outright.
    const leaked = users
      .map((u: any) => String(u?.email || '').trim())
      .filter(isValidEmail);
    return { person: named[0] || null, email: leaked[0] || null };
  } catch { return { person: null, email: null }; }
}

// ── 3. Footer socials ───────────────────────────────────────────────────────
const SOCIAL_PATTERNS: Array<[string, RegExp]> = [
  ['telegram',  /(?:https?:\/\/)?(?:t\.me|telegram\.me)\/([a-zA-Z][a-zA-Z0-9_]{4,31})/i],
  ['whatsapp',  /(?:https?:\/\/)?wa\.me\/(\d{7,15})/i],
  ['twitter',   /(?:https?:\/\/)?(?:www\.)?(?:twitter|x)\.com\/([a-zA-Z0-9_]{2,15})(?:[/?#]|$)/i],
  ['facebook',  /(?:https?:\/\/)?(?:www\.)?facebook\.com\/([a-zA-Z0-9.\-]{4,50})(?:[/?#]|$)/i],
  ['instagram', /(?:https?:\/\/)?(?:www\.)?instagram\.com\/([a-zA-Z0-9._]{2,30})(?:[/?#]|$)/i],
];
// Platform routes that are not accounts — matching these produces a "contact"
// pointing at Facebook's own login page.
const SOCIAL_RESERVED = new Set(['share', 'sharer', 'intent', 'home', 'login', 'signup',
  'privacy', 'policies', 'help', 'about', 'tr', 'plugins', 'dialog', 'profile.php',
  'explore', 'accounts', 'p', 'reel', 'story', 'search', 'hashtag', 'i', 'msg', 'joinchat', 'iv']);

function findSocials(html: string): { socials: string[]; telegram: string | null; whatsapp: string | null } {
  const socials: string[] = [];
  let telegram: string | null = null;
  let whatsapp: string | null = null;
  for (const [net, re] of SOCIAL_PATTERNS) {
    const m = html.match(re);
    if (!m) continue;
    const handle = m[1];
    if (SOCIAL_RESERVED.has(handle.toLowerCase())) continue;
    if (net === 'telegram')  telegram = '@' + handle;
    else if (net === 'whatsapp') whatsapp = '+' + handle;
    else socials.push(`${net}:${handle}`);
  }
  return { socials, telegram, whatsapp };
}

// ── Main ────────────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const stats = {
    processed: 0, recovered: 0, by_archive: 0, by_wp: 0, by_social: 0,
    persons: 0, still_empty: 0, reason: '',
  };
  const json = (s: unknown, code = 200) => new Response(JSON.stringify(s),
    { status: code, headers: { ...cors, 'Content-Type': 'application/json' } });

  const startedAt = Date.now();
  const deadline  = startedAt + DEADLINE_MS;

  try {
    // Best leads first — if only a handful can be salvaged per run, they should
    // be the ones worth salvaging.
    const { data: leads } = await supabase.from('leads')
      .select('id, url, domain_normalized, fit_score')
      .is('contact_email', null)
      .is('contact_recovery_at', null)
      // Don't front-run dfs-enrich: its homepage walk is far cheaper than an
      // archive.org lookup, so DataForSEO leads only reach the salvage pass once
      // the normal path has already tried and failed.
      .or('pipeline.neq.dataforseo,enriched_at.not.is.null')
      .order('fit_score', { ascending: false, nullsFirst: false })
      .limit(BATCH);

    if (!leads?.length) { stats.reason = 'nothing to recover'; return json(stats); }

    for (const lead of leads) {
      if (Date.now() > deadline) { stats.reason = 'deadline'; break; }
      stats.processed++;

      let origin = '';
      let domain = String(lead.domain_normalized || '');
      try {
        const u = new URL(lead.url?.startsWith('http') ? lead.url : 'https://' + lead.url);
        origin = u.origin;
        if (!domain) domain = u.hostname.replace(/^www\./, '');
      } catch {
        origin = 'https://' + domain;
      }
      if (!domain) {
        await quiet(supabase.from('leads')
          .update({ contact_recovery_at: new Date().toISOString(), contact_source: 'none' })
          .eq('id', lead.id));
        stats.still_empty++;
        continue;
      }

      const patch: Record<string, unknown> = { contact_recovery_at: new Date().toISOString() };
      let email: string | null = null;
      let source: string | null = null;

      // 1. Archive.org — highest yield, so it goes first.
      email = await tryArchive(domain, deadline);
      if (email) { source = 'archive'; stats.by_archive++; }

      // 2. WordPress — an address if leaked, a name either way.
      if (Date.now() < deadline) {
        const wp = await tryWordPress(origin);
        if (wp.person) { patch.contact_person = wp.person; stats.persons++; }
        if (!email && wp.email) { email = wp.email; source = 'wp_api'; stats.by_wp++; }
      }

      // 3. Socials off the live homepage.
      if (Date.now() < deadline) {
        const html = await getText(lead.url || origin);
        if (html) {
          const { socials, telegram, whatsapp } = findSocials(html);
          if (socials.length) patch.contact_socials = socials;
          if (telegram) { patch.contact_telegram = telegram; patch.tg = telegram; }
          if (whatsapp) patch.contact_whatsapp = whatsapp;
          if (!email && (telegram || whatsapp || socials.length)) {
            source = 'social';
            stats.by_social++;
          }
        }
      }

      if (email) {
        patch.contact_email      = email;
        patch.contact_email_type = emailType(email);
        patch.email              = email;   // legacy column kept in sync
        // A recovered address has NOT been through the P0.1 validation gate;
        // clearing the status re-queues it for validate-emails rather than
        // letting it reach the send queue unverified.
        patch.email_status       = null;
        stats.recovered++;
      } else if (!source) {
        stats.still_empty++;
      }
      // Only stamp contact_source when this pass actually found something.
      // Writing 'none' unconditionally would overwrite a meaningful value left
      // by the normal contact walk ('partners', 'homepage') with a worse one.
      // contact_recovery_at is what records that the attempt happened.
      if (source) patch.contact_source = source;

      await quiet(supabase.from('leads').update(patch).eq('id', lead.id));
    }

    await quiet(supabase.from('error_log').insert([{
      level: 'info', service: 'recover-contacts',
      message: `processed=${stats.processed} emails=${stats.recovered} `
        + `(archive=${stats.by_archive} wp=${stats.by_wp}) social=${stats.by_social} `
        + `persons=${stats.persons} empty=${stats.still_empty} ${stats.reason}`,
    }]));

    return json(stats);
  } catch (e: any) {
    await quiet(supabase.from('error_log').insert([{
      level: 'critical', service: 'recover-contacts', message: String(e?.message || e),
    }]));
    return json({ ...stats, error: String(e?.message || e) }, 500);
  }
});
