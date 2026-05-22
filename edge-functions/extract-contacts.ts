// Supabase Edge Function: extract-contacts
// Autonomously finds contact emails for leads that don't have one yet.
// Ported from the browser-side extractContactsFromUrl logic into a cron-driven
// edge function so the system no longer needs a human to press "find contacts".
//
// Flow per run:
//   1. Pick a batch of leads: stage='new', contact_email IS NULL, contact_email_type IS NULL
//   2. For each: crawl homepage + contact/about pages (direct fetch → Jina fallback)
//   3. Extract emails / telegram / whatsapp / phone
//   4. SerpAPI fallback if no email found on-site
//   5. Update the lead — found → contact fields, not found → contact_email_type='not_found'
//
// Deploy: supabase functions deploy extract-contacts
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto), SERP_API_KEY, JINA_API_KEY (optional)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL  = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SERP_API_KEY  = Deno.env.get('SERP_API_KEY') || '';
const JINA_API_KEY  = Deno.env.get('JINA_API_KEY') || '';

// How many leads to process per run
const BATCH_SIZE = 8;
// Global wall-clock budget — stop starting new leads after this
const TIME_BUDGET_MS = 110_000;
// Per-page fetch timeout
const FETCH_TIMEOUT_MS = 8_000;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Email extraction constants (mirrors index.html) ──────────────────────────
const EMAIL_REGEX  = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const EMAIL_IGNORE = ['noreply', 'no-reply', 'unsubscribe', 'privacy', 'legal', 'abuse',
  'example', 'sentry', 'wpcf7', '@2x', '@3x', '.png', '@example', '.jpg', '.gif', '.webp', '.svg'];
const EMAIL_AD     = ['advertis', 'ads@', 'partner', 'sponsor', 'commercial', 'business', 'collab', 'media@', 'marketing'];
const EMAIL_GEN    = ['contact', 'info@', 'hello@', 'hi@', 'enquir', 'support'];
const DISPOSABLE   = ['mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail', 'throwaway'];

function deobfuscateEmails(text: string): string {
  return text
    .replace(/([a-zA-Z0-9._%+\-]+)\s*[\[(]at[\])\s]\s*([a-zA-Z0-9.\-]+)\s*[\[(]dot[\])\s]\s*([a-zA-Z]{2,})/gi, '$1@$2.$3')
    .replace(/([a-zA-Z0-9._%+\-]+)\s+AT\s+([a-zA-Z0-9.\-]+)\s+DOT\s+([a-zA-Z]{2,})/g, '$1@$2.$3')
    .replace(/([a-zA-Z0-9._%+\-]+)\s*\[at\]\s*([a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/gi, '$1@$2')
    .replace(/([a-zA-Z0-9._%+\-]+)\s*\(at\)\s*([a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/gi, '$1@$2');
}

function extractMailtoLinks(html: string): string[] {
  const found: string[] = [];
  const re = /href=["']mailto:([^"'?]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const e = m[1].trim().toLowerCase();
    if (e.includes('@') && !EMAIL_IGNORE.some(ig => e.includes(ig))) found.push(m[1].trim());
  }
  return found;
}

function emailPriority(e: string): number {
  const l = e.toLowerCase();
  if (EMAIL_AD.some(k => l.includes(k)))  return 1;
  if (EMAIL_GEN.some(k => l.includes(k))) return 2;
  return 3;
}

function emailType(e: string): string {
  const l = e.toLowerCase();
  if (EMAIL_AD.some(k => l.includes(k)))  return 'advertising';
  if (EMAIL_GEN.some(k => l.includes(k))) return 'general';
  return 'admin';
}

function isValidEmail(e: string): boolean {
  if (!e || e.length > 100 || !e.includes('@') || !e.includes('.')) return false;
  const l = e.toLowerCase();
  if (EMAIL_IGNORE.some(ig => l.includes(ig))) return false;
  if (DISPOSABLE.some(d => l.includes(d)))     return false;
  return /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(e);
}

function normalizeBase(url: string): string | null {
  try {
    const u = new URL(url.startsWith('http') ? url : 'https://' + url);
    return u.origin;
  } catch (_) {
    return null;
  }
}

// ── Page fetching: direct first, Jina as fallback ────────────────────────────
let jinaCalls = 0;

async function fetchPage(url: string): Promise<string | null> {
  // 1. Direct fetch — edge functions have no CORS restriction
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AffiliateOS/1.0)' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'follow',
    });
    if (res.ok) {
      const text = await res.text();
      if (text && text.length > 200) return text;
    }
  } catch (_) { /* fall through to Jina */ }

  // 2. Jina reader fallback — returns clean text, bypasses bot blocks
  try {
    jinaCalls++;
    const headers: Record<string, string> = {};
    if (JINA_API_KEY) headers['Authorization'] = `Bearer ${JINA_API_KEY}`;
    const res = await fetch('https://r.jina.ai/' + url, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS + 4_000),
    });
    if (res.ok) {
      const text = await res.text();
      if (text && text.length > 100) return text;
    }
  } catch (_) { /* give up on this page */ }

  return null;
}

interface ContactResult {
  contact_email: string | null;
  contact_email_type: string | null;
  contact_telegram: string | null;
  contact_whatsapp: string | null;
  contact_phone: string | null;
  contact_source_url: string | null;
}

let serpCalls = 0;

async function extractContacts(siteUrl: string): Promise<ContactResult | null> {
  const base = normalizeBase(siteUrl);
  if (!base) return null;

  let bestEmail: string | null = null, bestPrio = 99, bestType: string | null = null;
  let sourceUrl: string | null = null;
  let tg: string | null = null, wa: string | null = null, phone: string | null = null;

  const pages = [
    siteUrl,
    base + '/contact', base + '/contact-us',
    base + '/about', base + '/about-us',
    base + '/advertise',
  ];

  for (let i = 0; i < pages.length; i++) {
    const html = await fetchPage(pages[i]);
    if (!html || html.length < 100) continue;

    const deobf  = deobfuscateEmails(html);
    const mailto = extractMailtoLinks(html);
    const regexEmails = (deobf.match(EMAIL_REGEX) || []).filter(isValidEmail);
    const found = [...new Set([...mailto, ...regexEmails])].filter(isValidEmail);

    for (const e of found) {
      const p = emailPriority(e);
      if (p < bestPrio) { bestPrio = p; bestEmail = e; bestType = emailType(e); sourceUrl = pages[i]; }
    }

    if (!tg) {
      const m = html.match(/t\.me\/([a-zA-Z][a-zA-Z0-9_]{4,})/);
      if (m && !['share', 'msg', 'joinchat'].includes(m[1])) tg = '@' + m[1];
    }
    if (!wa) {
      const m = html.match(/wa\.me\/(\d{7,})/);
      if (m) wa = '+' + m[1];
    }
    if (!phone) {
      const m = html.match(/\+[\d][\d\s\-().]{8,17}[\d]/);
      if (m) phone = m[0].replace(/\s+/g, ' ').trim();
    }

    // Stop as soon as any contact is found
    if (bestEmail || tg || wa) break;
  }

  // SerpAPI fallback — find emails mentioned on third-party pages
  if (!bestEmail && SERP_API_KEY) {
    try {
      const domain = new URL(base).hostname.replace(/^www\./, '');
      const q = encodeURIComponent(`"@${domain}" email contact`);
      serpCalls++;
      const res = await fetch(
        `https://serpapi.com/search.json?q=${q}&num=10&api_key=${SERP_API_KEY}`,
        { signal: AbortSignal.timeout(10_000) },
      );
      if (res.ok) {
        const sd = await res.json();
        const snippets = (sd.organic_results || [])
          .map((r: any) => (r.snippet || '') + ' ' + (r.title || '')).join(' ');
        const root = domain.split('.')[0];
        const serpEmails = [...new Set(
          (deobfuscateEmails(snippets).match(EMAIL_REGEX) || [])
            .filter((e: string) => e.toLowerCase().includes(root) && isValidEmail(e)),
        )];
        for (const e of serpEmails as string[]) {
          const p = emailPriority(e);
          if (p < bestPrio) { bestPrio = p; bestEmail = e; bestType = emailType(e); sourceUrl = 'serp:' + domain; }
        }
      }
    } catch (_) { /* serp fallback failed, continue */ }
  }

  if (!bestEmail && !tg && !wa) return null;
  return {
    contact_email:      bestEmail,
    contact_email_type: bestType,
    contact_telegram:   tg,
    contact_whatsapp:   wa,
    contact_phone:      phone,
    contact_source_url: sourceUrl,
  };
}

async function bumpUsage(service: string, delta: number) {
  if (delta <= 0) return;
  const { data } = await supabase.from('api_usage').select('used').eq('service', service).single();
  if (data) {
    await supabase.from('api_usage')
      .update({ used: (data.used ?? 0) + delta, updated_at: new Date().toISOString() })
      .eq('service', service);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const stats = { processed: 0, found: 0, not_found: 0, skipped: false };
  const startedAt = Date.now();

  try {
    // System pause check
    const { data: sysRow } = await supabase
      .from('api_usage').select('system_paused').eq('service', 'gmail_main').single();
    if (sysRow?.system_paused) {
      stats.skipped = true;
      return new Response(JSON.stringify({ ...stats, reason: 'system paused' }),
        { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    // Pick leads that have never had contact extraction run
    const { data: leads, error } = await supabase
      .from('leads')
      .select('id, url, website, name')
      .eq('stage', 'new')
      .is('contact_email', null)
      .is('contact_email_type', null)
      .order('created_at', { ascending: true })
      .limit(BATCH_SIZE);

    if (error) throw new Error(`leads query failed: ${error.message}`);
    if (!leads || leads.length === 0) {
      return new Response(JSON.stringify({ ...stats, reason: 'no leads to process' }),
        { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    for (const lead of leads) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) break;

      const url = lead.url || lead.website;
      if (!url) {
        await supabase.from('leads')
          .update({ contact_email_type: 'not_found' }).eq('id', lead.id);
        stats.processed++; stats.not_found++;
        continue;
      }

      let result: ContactResult | null = null;
      try {
        result = await extractContacts(url);
      } catch (e: any) {
        await supabase.from('error_log').insert([{
          level: 'warning', service: 'extract-contacts',
          message: `Lead ${lead.id} extraction error: ${e.message}`, lead_id: lead.id,
        }]);
      }

      if (result) {
        await supabase.from('leads').update(result).eq('id', lead.id);
        stats.found++;
      } else {
        await supabase.from('leads')
          .update({ contact_email_type: 'not_found', contact_source_url: null })
          .eq('id', lead.id);
        stats.not_found++;
      }
      stats.processed++;
    }

    // Track external API usage so check-limits stays accurate
    await bumpUsage('jina', jinaCalls);
    await bumpUsage('serpapi', serpCalls);

    await supabase.from('error_log').insert([{
      level: 'info', service: 'extract-contacts',
      message: `Processed ${stats.processed} leads — found ${stats.found}, not found ${stats.not_found}`,
    }]);

    return new Response(JSON.stringify(stats),
      { headers: { ...cors, 'Content-Type': 'application/json' } });

  } catch (e: any) {
    await supabase.from('error_log').insert([{
      level: 'critical', service: 'extract-contacts', message: e.message,
    }]);
    return new Response(JSON.stringify({ ...stats, error: e.message }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
});
