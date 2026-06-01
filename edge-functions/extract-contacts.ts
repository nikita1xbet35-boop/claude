// Supabase Edge Function: extract-contacts
// Autonomously finds contact emails for leads that don't have one yet.
//
// Flow per run:
//   1. Pick a batch of leads: stage='new', contact_email IS NULL, contact_email_type IS NULL
//   2. For each: crawl homepage + partner/advertise + contact/about pages
//   3. Extract emails (mailto links, JSON-LD, Cloudflare data-cfemail, deobfuscated text, footer)
//      / telegram / whatsapp / phone — priority order: advertising > general > admin
//   4. SerpAPI fallback if no email found on-site
//   5. Update the lead — found → contact fields, not found → contact_email_type='not_found'
//
// Deploy: supabase functions deploy extract-contacts
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto), SERP_API_KEY, JINA_API_KEY (optional)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL  = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const JINA_API_KEY  = Deno.env.get('JINA_API_KEY') || '';

// How many leads to process per run
const BATCH_SIZE = 12;
// Global wall-clock budget — stop starting new leads after this
const TIME_BUDGET_MS = 110_000;
// Per-page fetch timeout
const FETCH_TIMEOUT_MS = 8_000;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Email extraction ──────────────────────────────────────────────────────────
const EMAIL_REGEX  = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const EMAIL_IGNORE = ['noreply', 'no-reply', 'unsubscribe', 'privacy', 'legal', 'abuse',
  'example', 'sentry', 'wpcf7', '@2x', '@3x', '.png', '@example', '.jpg', '.gif', '.webp', '.svg'];
const EMAIL_AD     = ['advertis', 'ads@', 'partner', 'sponsor', 'commercial', 'business', 'collab', 'media@', 'marketing'];
const EMAIL_GEN    = ['contact', 'info@', 'hello@', 'hi@', 'enquir', 'support'];
const DISPOSABLE   = ['mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail', 'throwaway'];

function isValidEmail(e: string): boolean {
  if (!e || e.length > 100 || !e.includes('@') || !e.includes('.')) return false;
  const l = e.toLowerCase();
  if (EMAIL_IGNORE.some(ig => l.includes(ig))) return false;
  if (DISPOSABLE.some(d => l.includes(d)))     return false;
  return /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(e);
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

function deobfuscateEmails(text: string): string {
  return text
    .replace(/([a-zA-Z0-9._%+\-]+)\s*[\[(]at[\])\s]\s*([a-zA-Z0-9.\-]+)\s*[\[(]dot[\])\s]\s*([a-zA-Z]{2,})/gi, '$1@$2.$3')
    .replace(/([a-zA-Z0-9._%+\-]+)\s+AT\s+([a-zA-Z0-9.\-]+)\s+DOT\s+([a-zA-Z]{2,})/g, '$1@$2.$3')
    .replace(/([a-zA-Z0-9._%+\-]+)\s*\[at\]\s*([a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/gi, '$1@$2')
    .replace(/([a-zA-Z0-9._%+\-]+)\s*\(at\)\s*([a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/gi, '$1@$2')
    .replace(/[​-‍﻿]/g, ''); // strip zero-width chars used in CSS obfuscation
}

function extractMailtoLinks(html: string): string[] {
  const found: string[] = [];
  const re = /href=["']mailto:([^"'?&\s]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const e = decodeURIComponent(m[1]).trim();
    if (e.includes('@') && !EMAIL_IGNORE.some(ig => e.toLowerCase().includes(ig))) found.push(e);
  }
  return found;
}

/** Extract emails from JSON-LD / schema.org "email" fields */
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

/** data-email attribute + Cloudflare data-cfemail obfuscation decoder */
function extractDataAttrs(html: string): string[] {
  const found: string[] = [];
  // Plain data-email
  const re1 = /data-email=["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re1.exec(html)) !== null) {
    const e = m[1].trim();
    if (isValidEmail(e)) found.push(e);
  }
  // Cloudflare email obfuscation: data-cfemail hex-encoded XOR
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
    } catch (_) {}
  }
  return found;
}

/** Extract the footer section of a page for targeted email scanning */
function extractFooter(html: string): string {
  const footerRe = /<footer[\s\S]*?<\/footer>/gi;
  const match = footerRe.exec(html);
  if (match) return match[0];
  return html.slice(Math.floor(html.length * 0.8));
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

/** Scan one HTML page and update bestEmail/tg/wa/phone accumulators. */
function scanPage(
  html: string, page: string,
  state: { bestEmail: string | null; bestPrio: number; bestType: string | null; sourceUrl: string | null; tg: string | null; wa: string | null; phone: string | null },
): void {
  const deobf  = deobfuscateEmails(html);
  const footer = extractFooter(html);
  const footerDeobf = deobfuscateEmails(footer);

  const allEmails = [...new Set([
    ...extractMailtoLinks(html),
    ...extractJsonLd(html),
    ...extractDataAttrs(html),
    ...(deobf.match(EMAIL_REGEX) || []),
    ...(footerDeobf.match(EMAIL_REGEX) || []),
  ])].filter(isValidEmail);

  for (const e of allEmails) {
    const p = emailPriority(e);
    if (p < state.bestPrio) {
      state.bestPrio   = p;
      state.bestEmail  = e;
      state.bestType   = emailType(e);
      state.sourceUrl  = page;
    }
  }

  if (!state.tg) {
    const m = html.match(/t\.me\/([a-zA-Z][a-zA-Z0-9_]{4,})/);
    if (m && !['share', 'msg', 'joinchat', 'iv'].includes(m[1])) state.tg = '@' + m[1];
  }
  if (!state.wa) {
    const m = html.match(/wa\.me\/(\d{7,})/);
    if (m) state.wa = '+' + m[1];
  }
  if (!state.phone) {
    const m = html.match(/\+[\d][\d\s\-().]{8,17}[\d]/);
    if (m) state.phone = m[0].replace(/\s+/g, ' ').trim();
  }
}

async function extractContacts(siteUrl: string): Promise<ContactResult | null> {
  const base = normalizeBase(siteUrl);
  if (!base) return null;

  const state = {
    bestEmail: null as string | null, bestPrio: 99,
    bestType: null as string | null, sourceUrl: null as string | null,
    tg: null as string | null, wa: null as string | null, phone: null as string | null,
  };

  // Phase 1: homepage
  const homeHtml = await fetchPage(siteUrl);
  if (homeHtml && homeHtml.length > 100) {
    scanPage(homeHtml, siteUrl, state);
  }
  // Already found an advertising/partner email — return immediately
  if (state.bestPrio <= 1) {
    return buildResult(state);
  }

  // Phase 2: high-value partner/advertise pages
  const phase2Pages = [
    base + '/advertise',
    base + '/advertising',
    base + '/partners',
    base + '/partnership',
    base + '/work-with-us',
    base + '/sponsor',
    base + '/media',
    base + '/press',
  ];
  for (const page of phase2Pages) {
    const html = await fetchPage(page);
    if (!html || html.length < 100) continue;
    scanPage(html, page, state);
    if (state.bestPrio <= 1) return buildResult(state); // advertising email found
  }

  // Phase 3: generic contact / about pages
  const phase3Pages = [
    base + '/contact',
    base + '/contact-us',
    base + '/about',
    base + '/about-us',
    base + '/business',
    base + '/collaborate',
    base + '/team',
  ];
  for (const page of phase3Pages) {
    const html = await fetchPage(page);
    if (!html || html.length < 100) continue;
    scanPage(html, page, state);
    // Stop as soon as we have any email or social contact
    if (state.bestEmail || state.tg || state.wa) break;
  }

  // Phase 4: DuckDuckGo fallback — search for emails mentioned on third-party pages (free, no key)
  if (!state.bestEmail) {
    try {
      const domain = new URL(base).hostname.replace(/^www\./, '');
      const q = `"@${domain}" email contact advertise`;
      const res = await fetch(
        `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
        {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AffiliateOS/1.0)', 'Accept': 'text/html' },
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (res.ok) {
        const html = await res.text();
        const text = html.replace(/<[^>]+>/g, ' ');
        const root = domain.split('.')[0];
        const ddgEmails = [...new Set(
          (deobfuscateEmails(text).match(EMAIL_REGEX) || [])
            .filter((e: string) => e.toLowerCase().includes(root) && isValidEmail(e)),
        )] as string[];
        for (const e of ddgEmails) {
          const p = emailPriority(e);
          if (p < state.bestPrio) {
            state.bestPrio  = p;
            state.bestEmail = e;
            state.bestType  = emailType(e);
            state.sourceUrl = 'ddg:' + domain;
          }
        }
      }
    } catch (_) { /* ddg fallback failed */ }
  }

  if (!state.bestEmail && !state.tg && !state.wa) return null;
  return buildResult(state);
}

function buildResult(state: {
  bestEmail: string | null; bestType: string | null; sourceUrl: string | null;
  tg: string | null; wa: string | null; phone: string | null;
}): ContactResult {
  return {
    contact_email:      state.bestEmail,
    contact_email_type: state.bestType,
    contact_telegram:   state.tg,
    contact_whatsapp:   state.wa,
    contact_phone:      state.phone,
    contact_source_url: state.sourceUrl,
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

  jinaCalls = 0;
  serpCalls = 0;

  const stats = { processed: 0, found: 0, not_found: 0, skipped: false };
  const startedAt = Date.now();

  try {
    // extract-contacts never pauses — finding contacts is always safe
    const { data: leads, error } = await supabase
      .from('leads')
      .select('id, url, name')
      .is('contact_email', null)
      .is('contact_email_type', null)
      .not('stage', 'eq', 'excluded')
      .order('created_at', { ascending: true })
      .limit(BATCH_SIZE);

    if (error) throw new Error(`leads query failed: ${error.message}`);
    if (!leads || leads.length === 0) {
      return new Response(JSON.stringify({ ...stats, reason: 'no leads to process' }),
        { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    for (const lead of leads) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) break;

      const url = lead.url;
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
        // Also sync legacy columns
        const update: Record<string, unknown> = { ...result };
        if (result.contact_email)    update.email = result.contact_email;
        if (result.contact_telegram) update.tg    = result.contact_telegram;
        await supabase.from('leads').update(update).eq('id', lead.id);
        stats.found++;
      } else {
        await supabase.from('leads')
          .update({ contact_email_type: 'not_found', contact_source_url: null })
          .eq('id', lead.id);
        stats.not_found++;
      }
      stats.processed++;
    }

    await bumpUsage('jina', jinaCalls);

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
