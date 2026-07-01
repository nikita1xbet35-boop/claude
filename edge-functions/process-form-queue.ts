// Supabase Edge Function: process-form-queue
// Second outreach channel (submission phase). Submits our message through the
// simple contact forms that find-contact-form detected.
//
// SAFETY GATE: this function only submits when env FORM_SENDING_ENABLED === 'true'.
// While the flag is unset it runs in DRY-RUN mode — it reports how many leads it
// *would* submit but POSTs nothing. This keeps the outward-facing action off until
// detection numbers are reviewed and sending is explicitly turned on.
//
// Per run it submits at most one form (human-like pacing), respects a daily cap
// (api_usage 'form_main'), working hours (08:00–20:00 GMT+3), one-domain-once, and
// logs every attempt to form_submissions.
//
// Deploy: supabase functions deploy process-form-queue --no-verify-jwt
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto), FORM_SENDING_ENABLED ('true' to arm)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SENDING_ENABLED = (Deno.env.get('FORM_SENDING_ENABLED') || '').toLowerCase() === 'true';

const FROM_NAME      = 'Nick';
const REPLY_EMAIL    = 'nick.adflow@gmail.com';
const MAX_ATTEMPTS   = 2;
const FETCH_TIMEOUT_MS = 12_000;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function toGMT3(date: Date) {
  const g = new Date(date.getTime() + 3 * 60 * 60 * 1000);
  return { hour: g.getUTCHours(), dayOfWeek: g.getUTCDay(), dateStr: g.toISOString().slice(0, 10) };
}

// ── Message template (short — forms often cap length) ───────────────────────
const GEO_NAMES: Record<string, string> = {
  ID: 'Indonesia', BD: 'Bangladesh', IN: 'India', CI: "Côte d'Ivoire", EG: 'Egypt',
  MY: 'Malaysia', UZ: 'Uzbekistan', NP: 'Nepal', PK: 'Pakistan', TR: 'Turkey',
  AR: 'Argentina', CL: 'Chile', PH: 'Philippines', BF: 'Burkina Faso', SN: 'Senegal',
  CM: 'Cameroun', MA: 'Morocco', VN: 'Vietnam', MM: 'Myanmar', ZA: 'South Africa',
  NG: 'Nigeria', KE: 'Kenya', GH: 'Ghana', TZ: 'Tanzania', KG: 'Kyrgyzstan',
};
function geoName(code: string): string {
  if (!code) return '';
  return GEO_NAMES[code.trim().toUpperCase()] || GEO_NAMES[code.trim()] || '';
}
function siteNameFromUrl(url: string): string {
  try {
    const h = new URL(url.startsWith('http') ? url : 'https://' + url).hostname.replace(/^www\./, '');
    return h.split('.')[0].replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim();
  } catch { return 'your site'; }
}

function buildSubject(site: string): string {
  return `Partnership for ${site}`;
}
function buildMessage(url: string, geo: string): string {
  const site = siteNameFromUrl(url);
  const place = geoName(geo);
  const geoClause = place ? ` in ${place}` : '';
  return `Hi, I came across ${site} — you've built real trust with your audience${geoClause}. `
    + `I'm Nick from 1xPartners. You're already monetising this traffic; I can make it pay you more — `
    + `clean RevShare on 1xBet, no admin fee, no hidden cuts, terms built around your actual numbers. `
    + `You deal with me directly, not a support desk. Want me to send a short proposal? `
    + `Reach me at ${REPLY_EMAIL} or Telegram @aff_manager_xbet.`;
}

// ── Build the POST body from the stored field mapping ───────────────────────
interface FormFields {
  action: string;
  method: string;
  mapped: Array<{ name: string; role: string }>;
  hidden: Array<{ name: string; value: string }>;
}

function buildFormBody(ff: FormFields, content: { name: string; email: string; subject: string; message: string }): URLSearchParams {
  const body = new URLSearchParams();
  for (const h of ff.hidden || []) body.set(h.name, h.value ?? '');
  for (const f of ff.mapped || []) {
    if (f.role === 'name')    body.set(f.name, content.name);
    else if (f.role === 'email')   body.set(f.name, content.email);
    else if (f.role === 'subject') body.set(f.name, content.subject);
    else if (f.role === 'message') body.set(f.name, content.message);
  }
  return body;
}

// Heuristic success detection: 2xx with a thank-you cue, or a 3xx redirect.
function looksSuccessful(status: number, text: string): boolean {
  if (status >= 300 && status < 400) return true;
  if (status >= 200 && status < 300) {
    const l = text.toLowerCase();
    if (/thank|received|success|we'?ll be in touch|message sent|got your message|sent successfully|gracias|merci/.test(l)) return true;
    // A 200 with no obvious error is treated as accepted (many forms just re-render).
    if (!/error|invalid|required|captcha|try again/.test(l)) return true;
  }
  return false;
}

function domainOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); }
  catch { return ''; }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const stats = { processed: 0, sent: 0, failed: 0, skipped: 0, dry_run: !SENDING_ENABLED, reason: '' };

  try {
    const now = new Date();
    const { hour, dayOfWeek, dateStr } = toGMT3(now);
    if (hour < 8 || hour >= 20) {
      stats.reason = 'outside working hours';
      return new Response(JSON.stringify(stats), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    // Human-like jitter: skip ~1 in 4 runs so submissions don't land on a perfectly
    // regular 10-minute grid. (50/day cap still reachable across ~72 daily slots.)
    if (SENDING_ENABLED && Math.random() < 0.25) {
      stats.reason = 'jitter skip';
      return new Response(JSON.stringify(stats), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    // Daily cap from api_usage('form_main')
    const dayStart = new Date(`${dateStr}T00:00:00+03:00`);
    const dayEnd   = new Date(`${dateStr}T23:59:59+03:00`);
    const { data: usage } = await supabase.from('api_usage')
      .select('limit_value').eq('service', 'form_main').single();
    const dailyLimit = (usage?.limit_value as number) ?? 50;
    const { count: sentToday } = await supabase.from('form_submissions')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'sent')
      .gte('submitted_at', dayStart.toISOString())
      .lte('submitted_at', dayEnd.toISOString());
    if ((sentToday ?? 0) >= dailyLimit) {
      stats.reason = `daily form cap reached (${sentToday}/${dailyLimit})`;
      return new Response(JSON.stringify(stats), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    // One simple-form lead, oldest detection first.
    const { data: leads, error } = await supabase
      .from('leads')
      .select('id, url, geo, form_url, form_fields, form_attempts, source')
      .eq('form_status', 'simple')
      .lt('form_attempts', MAX_ATTEMPTS)
      .order('created_at', { ascending: true })
      .limit(1);
    if (error) throw new Error(`leads query failed: ${error.message}`);
    if (!leads || leads.length === 0) {
      stats.reason = 'no simple-form leads';
      return new Response(JSON.stringify(stats), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    const lead = leads[0];
    stats.processed++;
    const ff = lead.form_fields as unknown as FormFields | null;
    if (!ff || !ff.action) {
      await supabase.from('leads').update({ form_status: 'failed' }).eq('id', lead.id);
      stats.skipped++;
      stats.reason = 'missing form mapping';
      return new Response(JSON.stringify(stats), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    const dom = domainOf(lead.url as string);

    // Blacklist guard — never submit to a blacklisted domain.
    if (dom) {
      const { data: bl } = await supabase.from('blacklist').select('value').eq('value', dom).limit(1);
      if (bl && bl.length > 0) {
        await supabase.from('leads').update({ form_status: 'no_form' }).eq('id', lead.id);
        stats.skipped++;
        stats.reason = 'domain blacklisted';
        return new Response(JSON.stringify(stats), { headers: { ...cors, 'Content-Type': 'application/json' } });
      }
    }

    // One-domain-once: never submit a domain we've already submitted to.
    if (dom) {
      const { data: prior } = await supabase.from('form_submissions')
        .select('id').eq('status', 'sent').ilike('url', `%${dom}%`).limit(1);
      if (prior && prior.length > 0) {
        await supabase.from('leads').update({ form_status: 'submitted' }).eq('id', lead.id);
        stats.skipped++;
        stats.reason = 'domain already submitted';
        return new Response(JSON.stringify(stats), { headers: { ...cors, 'Content-Type': 'application/json' } });
      }
    }

    // DRY-RUN: gate is off — report intent, submit nothing.
    if (!SENDING_ENABLED) {
      stats.reason = 'dry-run (FORM_SENDING_ENABLED not set) — would submit ' + (lead.form_url || lead.url);
      await supabase.from('error_log').insert([{
        level: 'info', service: 'process-form-queue',
        message: `DRY-RUN — would submit form for lead ${lead.id} (${lead.form_url})`, lead_id: lead.id,
      }]);
      return new Response(JSON.stringify(stats), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    // ── Live submit ──────────────────────────────────────────────────────────
    const content = {
      name: FROM_NAME,
      email: REPLY_EMAIL,
      subject: buildSubject(siteNameFromUrl(lead.url as string)),
      message: buildMessage(lead.url as string, (lead.geo as string) || ''),
    };
    const body = buildFormBody(ff, content);

    let httpStatus = 0;
    let respText = '';
    let ok = false;
    try {
      const res = await fetch(ff.action, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0 (compatible; AffiliateOS/1.0)',
          'Referer': lead.form_url || lead.url,
        },
        body: body.toString(),
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      httpStatus = res.status;
      respText = (await res.text().catch(() => '')).slice(0, 2000);
      ok = looksSuccessful(httpStatus, respText);
    } catch (e: any) {
      respText = `fetch error: ${e.message}`;
    }

    await supabase.from('form_submissions').insert([{
      lead_id: lead.id, channel: 'form',
      url: lead.url, form_url: lead.form_url, form_action: ff.action,
      status: ok ? 'sent' : 'failed',
      http_status: httpStatus, response_snippet: respText.slice(0, 500),
      source: (lead as any).source || 'seo',
    }]);

    if (ok) {
      await supabase.from('leads').update({ form_status: 'submitted', stage: 'waiting' }).eq('id', lead.id);
      const { data: cur } = await supabase.from('api_usage').select('used').eq('service', 'form_main').single();
      await supabase.from('api_usage')
        .update({ used: ((cur?.used ?? 0) as number) + 1, updated_at: new Date().toISOString() })
        .eq('service', 'form_main');
      stats.sent++;
    } else {
      const attempts = ((lead.form_attempts as number) ?? 0) + 1;
      await supabase.from('leads')
        .update({ form_status: attempts >= MAX_ATTEMPTS ? 'failed' : 'simple', form_attempts: attempts })
        .eq('id', lead.id);
      stats.failed++;
    }

    await supabase.from('error_log').insert([{
      level: 'info', service: 'process-form-queue',
      message: `sent=${stats.sent} failed=${stats.failed} (${sentToday ?? 0}/${dailyLimit} today) lead=${lead.id} http=${httpStatus}`,
      lead_id: lead.id,
    }]);

    return new Response(JSON.stringify(stats), { headers: { ...cors, 'Content-Type': 'application/json' } });

  } catch (e: any) {
    await supabase.from('error_log').insert([{
      level: 'critical', service: 'process-form-queue', message: e.message,
    }]);
    return new Response(JSON.stringify({ ...stats, error: e.message }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
});
