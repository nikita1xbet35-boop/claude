// Supabase Edge Function: validate-emails
// ════════════════════════════════════════════════════════════════════════════
// P0.1 — Email validation gate. Nothing reaches send_queue until its address has
// been checked, so dead addresses stop burning domain reputation.
//
// Providers, in order of preference:
//   1. MillionVerifier bulk API — used when MILLIONVERIFIER_KEY is set.
//   2. Built-in checker — syntax → disposable → role → MX lookup over DNS-over-HTTPS.
//      This runs with no paid key and still catches the expensive failure mode
//      (a domain that cannot receive mail at all), so the gate is useful today
//      rather than "later, once a key exists".
//
// Statuses written to leads.email_status:
//   valid | invalid | catch_all | disposable | role | unknown
// Per ТЗ: invalid/disposable are blacklisted, catch_all is allowed but
// deprioritised, and role addresses (info@, ads@, partners@) are KEPT — for
// media outfits that is the intended inbox.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, MILLIONVERIFIER_KEY (optional)

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const MV_KEY       = Deno.env.get('MILLIONVERIFIER_KEY') || '';

const BATCH = 60;                 // leads validated per invocation
const DNS_TIMEOUT_MS = 4000;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const DISPOSABLE = new Set([
  'mailinator.com','guerrillamail.com','tempmail.com','throwam.com','yopmail.com',
  'sharklasers.com','guerrillamailblock.com','10minutemail.com','trashmail.com',
  'temp-mail.org','fakeinbox.com','getnada.com','dispostable.com','maildrop.cc',
]);

// Kept (not blocked) — for media/affiliate sites this is the real contact inbox.
const ROLE_PREFIXES = [
  'info','contact','sales','ads','advertising','partner','partners','partnership',
  'marketing','media','support','hello','admin','office','business','pr','team',
];

// Obvious template placeholders scraped off page markup.
const PLACEHOLDER_RE = /^(your|you|name|email|mail|example|test|sample|user|domain|abc|xxx)@|@(example|domain|email|test|sample|yourdomain|mydomain)\.|^\.\.\.@/i;

const mxCache = new Map<string, boolean>();

async function hasMx(domain: string): Promise<boolean | null> {
  if (mxCache.has(domain)) return mxCache.get(domain)!;
  const ask = async (type: string) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), DNS_TIMEOUT_MS);
    try {
      const r = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=${type}`,
        { signal: ctl.signal, headers: { accept: 'application/dns-json' } });
      if (!r.ok) return null;
      const j = await r.json();
      return Array.isArray(j.Answer) && j.Answer.length > 0;
    } catch { return null; } finally { clearTimeout(t); }
  };
  let ok = await ask('MX');
  // No MX is not proof of undeliverability — a bare A record can still accept mail.
  if (ok === false) ok = await ask('A');
  if (ok !== null) mxCache.set(domain, ok);
  return ok;
}

interface Verdict { status: string; provider: string }

async function validateBuiltIn(email: string): Promise<Verdict> {
  const e = email.trim().toLowerCase();
  if (!EMAIL_RE.test(e) || PLACEHOLDER_RE.test(e)) return { status: 'invalid', provider: 'builtin' };

  const [local, domain] = e.split('@');
  if (DISPOSABLE.has(domain)) return { status: 'disposable', provider: 'builtin' };

  const mx = await hasMx(domain);
  if (mx === false) return { status: 'invalid', provider: 'builtin' };
  if (mx === null)  return { status: 'unknown', provider: 'builtin' };   // retry next run

  const isRole = ROLE_PREFIXES.includes(local) || ROLE_PREFIXES.some(p => local.startsWith(p + '.') || local.startsWith(p + '-'));
  return { status: isRole ? 'role' : 'valid', provider: 'builtin' };
}

// MillionVerifier single-address endpoint; the function is already batched by the
// BATCH loop, so this stays simple and quota-accounted per call.
async function validateMV(email: string): Promise<Verdict | null> {
  try {
    const r = await fetch(`https://api.millionverifier.com/api/v3/?api=${MV_KEY}&email=${encodeURIComponent(email)}&timeout=10`);
    if (!r.ok) return null;
    const j = await r.json();
    const res = String(j.result || '').toLowerCase();
    const map: Record<string, string> = {
      ok: 'valid', valid: 'valid',
      catch_all: 'catch_all', catchall: 'catch_all',
      unknown: 'unknown',
      disposable: 'disposable',
      invalid: 'invalid', bad: 'invalid',
    };
    return { status: map[res] || 'unknown', provider: 'millionverifier' };
  } catch { return null; }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const stats: Record<string, number | string> = {
    checked: 0, valid: 0, role: 0, catch_all: 0, invalid: 0, disposable: 0, unknown: 0, suppressed: 0,
  };

  try {
    // Only leads that have an address and were never validated.
    const { data: leads } = await supabase.from('leads')
      .select('id, contact_email, email_status')
      .not('contact_email', 'is', null)
      .or('email_status.is.null,email_status.eq.unknown')
      .limit(BATCH);

    if (!leads?.length) {
      stats.reason = 'nothing to validate';
      return new Response(JSON.stringify(stats), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    let mvUsed = 0;

    for (const lead of leads) {
      const email = String(lead.contact_email || '').trim();
      if (!email) continue;

      let verdict: Verdict | null = null;
      if (MV_KEY) { verdict = await validateMV(email); if (verdict) mvUsed++; }
      if (!verdict) verdict = await validateBuiltIn(email);

      stats.checked = (stats.checked as number) + 1;
      stats[verdict.status] = ((stats[verdict.status] as number) || 0) + 1;

      await supabase.from('leads').update({
        email_status: verdict.status,
        validated_at: new Date().toISOString(),
        validation_provider: verdict.provider,
      }).eq('id', lead.id);

      // Dead or throwaway addresses are suppressed outright so no later code path
      // (cold queue, follow-up, partner base) can pick them up again.
      if (verdict.status === 'invalid' || verdict.status === 'disposable') {
        await supabase.from('suppression_list')
          .upsert({ email: email.toLowerCase(), reason: 'bounce' }, { onConflict: 'email' });
        await supabase.from('send_queue')
          .update({ status: 'skipped', error: `email ${verdict.status}` })
          .eq('lead_id', lead.id).eq('status', 'pending');
        stats.suppressed = (stats.suppressed as number) + 1;
      }
    }

    if (mvUsed > 0) {
      const { data: cur } = await supabase.from('api_usage').select('used').eq('service', 'millionverifier').maybeSingle();
      await supabase.from('api_usage')
        .update({ used: ((cur?.used ?? 0) as number) + mvUsed, updated_at: new Date().toISOString() })
        .eq('service', 'millionverifier');
    }

    await supabase.from('error_log').insert([{
      level: 'info', service: 'validate-emails',
      message: `checked=${stats.checked} valid=${stats.valid} role=${stats.role} invalid=${stats.invalid} disposable=${stats.disposable} unknown=${stats.unknown} provider=${MV_KEY ? 'millionverifier' : 'builtin'}`,
    }]).catch(() => {});

    return new Response(JSON.stringify(stats), { headers: { ...cors, 'Content-Type': 'application/json' } });
  } catch (e: any) {
    return new Response(JSON.stringify({ ...stats, error: String(e.message || e) }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
});
