// Supabase Edge Function: find-appstore
// New lead source (PREPARED, DISABLED by default). Finds betting/casino apps in
// our GEOs via Apple's keyless iTunes Search API, pulls the developer website
// from each app, extracts a support/business email from that site, and inserts
// leads with source='appstore' that flow through the normal send pipeline.
//
// SAFETY GATE: does nothing unless env APPSTORE_ENABLED === 'true'. iTunes Search
// needs no API key. Without the flag it is a no-op.
//
// Deploy: supabase functions deploy find-appstore --no-verify-jwt
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto), APPSTORE_ENABLED

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ENABLED = (Deno.env.get('APPSTORE_ENABLED') || '').toLowerCase() === 'true';

const APPS_PER_RUN = 12;
const FETCH_TIMEOUT_MS = 8_000;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// GEO → iTunes store country code + search term
// Africa-focus week — App Store queries narrowed to African GEOs.
const STORE_QUERIES: Array<{ geo: string; country: string; term: string }> = [
  { geo: 'NG', country: 'ng', term: 'betting' },
  { geo: 'KE', country: 'ke', term: 'betting' },
  { geo: 'GH', country: 'gh', term: 'betting' },
  { geo: 'TZ', country: 'tz', term: 'betting' },
  { geo: 'UG', country: 'ug', term: 'betting' },
  { geo: 'CM', country: 'cm', term: 'paris sportif' },
  { geo: 'CI', country: 'ci', term: 'paris sportif' },
  { geo: 'SN', country: 'sn', term: 'paris sportif' },
  { geo: 'ZM', country: 'zm', term: 'betting' },
  { geo: 'CD', country: 'cd', term: 'paris sportif' },
  { geo: 'ET', country: 'et', term: 'betting' },
  { geo: 'MZ', country: 'mz', term: 'apostas' },
];

const EMAIL_REGEX  = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const EMAIL_IGNORE = ['noreply', 'no-reply', 'example', 'apple.com', 'sentry', '.png', '.jpg', 'wixpress'];
const EMAIL_AD     = ['advertis', 'ads@', 'partner', 'sponsor', 'business', 'marketing', 'support'];
function isValidEmail(e: string): boolean {
  if (!e || e.length > 100) return false;
  const l = e.toLowerCase();
  if (EMAIL_IGNORE.some(ig => l.includes(ig))) return false;
  return /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(e);
}

async function fetchText(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AffiliateOS/1.0)' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow',
    });
    if (!res.ok) { res.body?.cancel().catch(() => {}); return ''; }
    return (await res.text()).slice(0, 500_000);
  } catch { return ''; }
}

function extractEmail(html: string): string | null {
  const found = [...new Set(html.match(EMAIL_REGEX) || [])].filter(isValidEmail);
  if (!found.length) return null;
  // Prefer advertising/business/support addresses.
  found.sort((a, b) => (EMAIL_AD.some(k => b.toLowerCase().includes(k)) ? 1 : 0)
                     - (EMAIL_AD.some(k => a.toLowerCase().includes(k)) ? 1 : 0));
  return found[0];
}

function domainOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const stats = { enabled: ENABLED, processed: 0, saved: 0, no_email: 0, reason: '' };

  if (!ENABLED) {
    stats.reason = 'disabled (APPSTORE_ENABLED not set)';
    return new Response(JSON.stringify(stats), { headers: { ...cors, 'Content-Type': 'application/json' } });
  }

  try {
    const slot = Math.floor(Date.now() / (30 * 60 * 1000));
    const { geo, country, term } = STORE_QUERIES[slot % STORE_QUERIES.length];

    // Apple iTunes Search API — keyless.
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}`
      + `&country=${country}&entity=software&limit=${APPS_PER_RUN}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    if (!res.ok) throw new Error(`iTunes Search → HTTP ${res.status}`);
    const data = await res.json();
    const apps = Array.isArray(data?.results) ? data.results : [];

    // Blacklist + dedup by developer domain
    const { data: bl } = await supabase.from('blacklist').select('value');
    const blacklist = new Set((bl || []).map((r: any) => (r.value || '').toLowerCase()));
    const { data: existing } = await supabase.from('leads')
      .select('domain_normalized, url').eq('source', 'appstore').limit(5000);
    const existingDomains = new Set((existing || []).map((r: any) =>
      (r.domain_normalized || domainOf(r.url || '')).toLowerCase()).filter(Boolean));

    for (const app of apps) {
      stats.processed++;
      const sellerUrl: string = app.sellerUrl || app.trackViewUrl || '';
      const dom = domainOf(sellerUrl);
      if (!dom || blacklist.has(dom) || existingDomains.has(dom)) continue;

      const html  = await fetchText(sellerUrl);
      const email = html ? extractEmail(html) : null;
      if (!email) { stats.no_email++; continue; }

      const { error } = await supabase.from('leads').insert([{
        url: sellerUrl, name: app.sellerName || app.trackName || dom,
        brand: '1xbet', stage: 'new', geo, type: 'appstore', score: 60, priority: 'Medium',
        summary: `App developer — ${app.trackName || dom}`,
        contact_email: email, contact_email_type: 'advertising', email,
        source: 'appstore', domain_normalized: dom,
      }]);
      if (!error) { existingDomains.add(dom); stats.saved++; }
    }

    await supabase.from('error_log').insert([{
      level: 'info', service: 'find-appstore',
      message: `geo=${geo} term="${term}" processed=${stats.processed} saved=${stats.saved} no_email=${stats.no_email}`,
    }]);

    return new Response(JSON.stringify(stats), { headers: { ...cors, 'Content-Type': 'application/json' } });
  } catch (e: any) {
    await supabase.from('error_log').insert([{
      level: 'warning', service: 'find-appstore', message: e.message,
    }]);
    return new Response(JSON.stringify({ ...stats, error: e.message }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
});
