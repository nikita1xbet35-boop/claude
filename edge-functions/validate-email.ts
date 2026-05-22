// Supabase Edge Function: validate-email
// Validates an email address before adding a lead to the send queue.
// Steps: format check → MX record check → disposable domain check → duplicate send check.
// Deploy: supabase functions deploy validate-email
// Env vars needed: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Constants ────────────────────────────────────────────────────────────────

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com',
  'guerrillamail.com',
  'tempmail.com',
  'throwam.com',
  'yopmail.com',
  'sharklasers.com',
  'guerrillamailblock.com',
  'grr.la',
  'guerrillamail.info',
  'spam4.me',
  'trashmail.com',
  'trashmail.me',
  'trashmail.net',
  'dispostable.com',
  'fakeinbox.com',
  'mailnull.com',
  'spamgourmet.com',
  'maildrop.cc',
  'discard.email',
  'spamherelots.com',
  'tempr.email',
  'getnada.com',
  'tnef.com',
  'spamhero.com',
]);

// ── Types ────────────────────────────────────────────────────────────────────

type ValidationReason =
  | 'ok'
  | 'invalid_format'
  | 'no_mx'
  | 'disposable'
  | 'already_contacted_30d';

interface ValidationResult {
  valid: boolean;
  reason: ValidationReason;
  detail?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Step 1: Basic format check via regex. */
function checkFormat(email: string): boolean {
  return EMAIL_REGEX.test(email);
}

/** Step 2: MX record lookup via DNS-over-HTTPS. */
async function checkMX(domain: string): Promise<{ ok: boolean; detail?: string }> {
  const url = `https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=MX`;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      return { ok: false, detail: `DNS query failed with HTTP ${res.status}` };
    }
    const data = await res.json();
    const hasAnswers = Array.isArray(data?.Answer) && data.Answer.length > 0;
    return {
      ok: hasAnswers,
      detail: hasAnswers ? undefined : 'No MX records found for domain',
    };
  } catch (err) {
    return { ok: false, detail: `DNS lookup error: ${(err as Error).message}` };
  }
}

/** Step 3: Disposable domain check. */
function checkDisposable(domain: string): boolean {
  return DISPOSABLE_DOMAINS.has(domain.toLowerCase());
}

/** Step 4: Check if this email was contacted in the last 30 days. */
async function checkRecentContact(email: string): Promise<{ contacted: boolean; detail?: string }> {
  const { count, error } = await supabase
    .from('email_log')
    .select('id', { count: 'exact', head: true })
    .eq('email', email)
    .gt('sent_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());

  if (error) {
    // Treat DB errors as non-blocking to avoid false rejections; surface in detail.
    return { contacted: false, detail: `DB check error: ${error.message}` };
  }

  return { contacted: typeof count === 'number' && count > 0 };
}

/** Mark lead email as invalid in the leads table. */
async function markLeadInvalid(leadId: string): Promise<void> {
  await supabase
    .from('leads')
    .update({ contact_email_type: 'invalid' })
    .eq('id', leadId);
}

// ── Main handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: cors });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  let body: { email?: unknown; lead_id?: unknown };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : null;
  const leadId = typeof body.lead_id === 'string' ? body.lead_id.trim() : null;

  if (!email) {
    return new Response(
      JSON.stringify({ error: 'Missing required field: email' }),
      { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } },
    );
  }

  const respond = async (result: ValidationResult): Promise<Response> => {
    if (!result.valid && leadId) {
      await markLeadInvalid(leadId);
    }
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  };

  // ── Step 1: Format check ────────────────────────────────────────────────────
  if (!checkFormat(email)) {
    return respond({ valid: false, reason: 'invalid_format', detail: 'Email does not match required format' });
  }

  const domain = email.split('@')[1];

  // ── Step 2: MX record check ─────────────────────────────────────────────────
  const mx = await checkMX(domain);
  if (!mx.ok) {
    return respond({ valid: false, reason: 'no_mx', detail: mx.detail });
  }

  // ── Step 3: Disposable domain check ────────────────────────────────────────
  if (checkDisposable(domain)) {
    return respond({ valid: false, reason: 'disposable', detail: `Domain '${domain}' is a known disposable email provider` });
  }

  // ── Step 4: Duplicate send check ────────────────────────────────────────────
  const contact = await checkRecentContact(email);
  if (contact.contacted) {
    return respond({ valid: false, reason: 'already_contacted_30d', detail: 'Email was contacted within the last 30 days' });
  }

  // All checks passed
  return respond({ valid: true, reason: 'ok' });
});
