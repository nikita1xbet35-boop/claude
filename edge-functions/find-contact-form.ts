// Supabase Edge Function: find-contact-form
// Second outreach channel (detection phase). For leads WITHOUT an email it
// crawls the site for a contact/advertise form, classifies it as simple or
// complex, and — for simple forms — stores a deterministic field mapping so
// process-form-queue can submit it later.
//
// READ-ONLY: this function never submits anything. It only fetches pages and
// marks leads (form_status / form_url / form_fields). Submission is a separate,
// env-gated function (process-form-queue).
//
// Classification (deterministic, NO AI):
//   simple          — plain HTML <form> in the source, no captcha, recognizable
//                     name/email/subject/message fields, no unknown required field
//   manual_required — captcha (reCAPTCHA/hCaptcha/Turnstile), JS-rendered form,
//                     or an unrecognized required field → a human handles it
//   no_form         — no usable form found anywhere
//
// Deploy: supabase functions deploy find-contact-form --no-verify-jwt
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto), JINA_API_KEY (optional)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const BATCH_SIZE      = 5;
const TIME_BUDGET_MS  = 100_000;
const FETCH_TIMEOUT_MS = 8_000;
const BODY_CAP_BYTES  = 2_500_000;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Pages most likely to host a contact / advertise / partnership form
const FORM_PAGES = [
  '', '/contact', '/contact-us', '/contactus', '/advertise', '/advertising',
  '/advertise-with-us', '/work-with-us', '/write-for-us', '/partner',
  '/partners', '/partnership', '/collaborate', '/about', '/about-us',
];

// Captcha signatures — any of these → manual_required
const CAPTCHA_SIGNATURES = [
  'recaptcha', 'g-recaptcha', 'grecaptcha', 'hcaptcha', 'h-captcha',
  'cf-turnstile', 'turnstile', 'data-sitekey', '/recaptcha/api.js',
  'hcaptcha.com/1/api.js', 'challenges.cloudflare.com',
];
// JS-framework signatures — a form that isn't in the static HTML is likely
// rendered client-side; we can't POST it from an edge function.
const JS_FRAMEWORK_SIGNATURES = [
  '__next_data__', 'data-reactroot', 'window.__nuxt__', 'ng-version',
  'data-v-app', '__svelte', 'wp-json/contact-form-7', 'gravityforms',
];

// ── Page fetch with size cap ────────────────────────────────────────────────
async function readCapped(res: Response, cap = BODY_CAP_BYTES): Promise<string> {
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (ct && !ct.includes('text/') && !ct.includes('html') && !ct.includes('xml')) {
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

// Direct fetch only (no Jina here — Jina returns rendered markdown, not the raw
// <form> HTML we need to parse field names from).
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
  } catch (_) { /* unreachable / timeout */ }
  return null;
}

function normalizeBase(url: string): string | null {
  try {
    return new URL(url.startsWith('http') ? url : 'https://' + url).origin;
  } catch (_) { return null; }
}

function domainOf(url: string): string {
  try {
    return new URL(url.startsWith('http') ? url : 'https://' + url).hostname.replace(/^www\./, '').toLowerCase();
  } catch { return ''; }
}

// ── HTML form parsing (deterministic) ───────────────────────────────────────
interface ParsedField {
  tag: 'input' | 'textarea' | 'select';
  name: string;
  type: string;
  id: string;
  placeholder: string;
  required: boolean;
  value: string;
  role: string | null; // 'name' | 'email' | 'subject' | 'message' | null
}

interface ParsedForm {
  action: string;       // absolute URL
  method: string;       // 'post' | 'get'
  fields: ParsedField[];
}

function getAttr(tag: string, attr: string): string {
  const m = tag.match(new RegExp(`${attr}\\s*=\\s*["']([^"']*)["']`, 'i'))
    || tag.match(new RegExp(`${attr}\\s*=\\s*([^\\s>"']+)`, 'i'));
  return m ? m[1] : '';
}
function hasAttr(tag: string, attr: string): boolean {
  return new RegExp(`(^|\\s)${attr}(\\s|=|>|$)`, 'i').test(tag);
}

// Classify a field's role by name/id/placeholder/type — deterministic keyword match.
function classifyRole(f: { name: string; id: string; placeholder: string; type: string; tag: string }): string | null {
  const hay = `${f.name} ${f.id} ${f.placeholder}`.toLowerCase();
  if (f.type === 'email' || /\be[\-_]?mail\b|your[\-_]?email/.test(hay)) return 'email';
  if (f.tag === 'textarea' || /message|comment|enquir|inquir|\bbody\b|your[\-_]?message|detail/.test(hay)) return 'message';
  if (/subject|topic|reason/.test(hay)) return 'subject';
  if (/\bname\b|your[\-_]?name|full[\-_]?name|first[\-_]?name|fname|lname|last[\-_]?name/.test(hay)) return 'name';
  return null;
}

function parseForms(html: string, pageUrl: string): ParsedForm[] {
  const forms: ParsedForm[] = [];
  const formRe = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
  let fm: RegExpExecArray | null;
  while ((fm = formRe.exec(html)) !== null) {
    const formTag  = fm[1];
    const inner    = fm[2];
    const rawAction = getAttr('<form ' + formTag + '>', 'action') || pageUrl;
    let action: string;
    try { action = new URL(rawAction, pageUrl).href; } catch { action = pageUrl; }
    const method = (getAttr('<form ' + formTag + '>', 'method') || 'get').toLowerCase();

    const fields: ParsedField[] = [];
    // inputs
    const inputRe = /<input\b[^>]*>/gi;
    let im: RegExpExecArray | null;
    while ((im = inputRe.exec(inner)) !== null) {
      const tag = im[0];
      const name = getAttr(tag, 'name');
      const type = (getAttr(tag, 'type') || 'text').toLowerCase();
      if (!name && type !== 'submit') continue;
      const field = {
        tag: 'input' as const, name, type,
        id: getAttr(tag, 'id'), placeholder: getAttr(tag, 'placeholder'),
        required: hasAttr(tag, 'required'), value: getAttr(tag, 'value'),
        role: null as string | null,
      };
      field.role = classifyRole({ ...field, tag: 'input' });
      fields.push(field);
    }
    // textareas
    const taRe = /<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi;
    let tm: RegExpExecArray | null;
    while ((tm = taRe.exec(inner)) !== null) {
      const tag = '<textarea ' + tm[1] + '>';
      const name = getAttr(tag, 'name');
      if (!name) continue;
      const field = {
        tag: 'textarea' as const, name, type: 'textarea',
        id: getAttr(tag, 'id'), placeholder: getAttr(tag, 'placeholder'),
        required: hasAttr(tag, 'required'), value: '',
        role: null as string | null,
      };
      field.role = classifyRole({ ...field, tag: 'textarea' });
      fields.push(field);
    }
    // selects (treated as potentially-required unknowns)
    const selRe = /<select\b([^>]*)>([\s\S]*?)<\/select>/gi;
    let sm: RegExpExecArray | null;
    while ((sm = selRe.exec(inner)) !== null) {
      const tag = '<select ' + sm[1] + '>';
      const name = getAttr(tag, 'name');
      if (!name) continue;
      fields.push({
        tag: 'select', name, type: 'select',
        id: getAttr(tag, 'id'), placeholder: '',
        required: hasAttr(tag, 'required'), value: '', role: null,
      });
    }
    if (fields.length > 0) forms.push({ action, method, fields });
  }
  return forms;
}

interface Classification {
  status: 'simple' | 'manual_required' | 'no_form';
  form_url?: string;
  form_fields?: Record<string, unknown>;
  reason?: string;
}

// Decide whether a parsed form is auto-submittable.
function classifyForm(form: ParsedForm, pageUrl: string): Classification | null {
  // Must be POST — GET "forms" are usually site search, not contact forms.
  if (form.method !== 'post') return null;

  const roles = new Set(form.fields.map(f => f.role).filter(Boolean) as string[]);
  // Need at least a message OR an email field to be a real contact form.
  if (!roles.has('message') && !roles.has('email')) return null;

  // Any required field we couldn't classify (and isn't a hidden/submit/button or
  // an optional checkbox/radio) → don't guess, hand to a human. Required <select>
  // always counts as an unknown we won't guess.
  const IGNORABLE_TYPES = ['hidden', 'submit', 'button', 'checkbox', 'radio'];
  const unknownRequired = form.fields.find(f =>
    f.required && !f.role && (f.tag === 'select' || !IGNORABLE_TYPES.includes(f.type)),
  );
  if (unknownRequired) {
    return { status: 'manual_required', form_url: pageUrl, reason: `unknown required field: ${unknownRequired.name}` };
  }

  // Build the submit mapping: recognized roles get our content (filled later),
  // hidden fields keep their value (tokens, form ids), everything else ignored.
  const mapped = form.fields
    .filter(f => f.role)
    .map(f => ({ name: f.name, role: f.role }));
  const hidden = form.fields
    .filter(f => f.type === 'hidden' && f.name)
    .map(f => ({ name: f.name, value: f.value }));

  return {
    status: 'simple',
    form_url: pageUrl,
    form_fields: { action: form.action, method: form.method, mapped, hidden },
  };
}

function hasCaptcha(html: string): boolean {
  const l = html.toLowerCase();
  return CAPTCHA_SIGNATURES.some(s => l.includes(s));
}
function looksJsRendered(html: string): boolean {
  const l = html.toLowerCase();
  return JS_FRAMEWORK_SIGNATURES.some(s => l.includes(s));
}

// Crawl candidate pages; return the first usable classification.
async function detectForm(siteUrl: string, deadline: number): Promise<Classification> {
  const base = normalizeBase(siteUrl);
  if (!base) return { status: 'no_form', reason: 'bad url' };

  let sawCaptcha = false;
  let sawJsForm  = false;

  for (const path of FORM_PAGES) {
    if (Date.now() > deadline) break;
    const pageUrl = path === '' ? siteUrl : base + path;
    const html = await fetchPage(pageUrl);
    if (!html) continue;

    const captcha = hasCaptcha(html);
    const forms = parseForms(html, pageUrl);

    for (const form of forms) {
      const cls = classifyForm(form, pageUrl);
      if (!cls) continue;
      // A real contact form guarded by captcha → manual.
      if (cls.status === 'simple' && captcha) {
        sawCaptcha = true;
        continue;
      }
      if (cls.status === 'manual_required') { return cls; }
      if (cls.status === 'simple') return cls;
    }

    // No usable <form> in source but the page screams "contact form" + JS framework
    if (forms.length === 0 && looksJsRendered(html) && /contact|message|enquir/i.test(html)) {
      sawJsForm = true;
    }
    if (captcha) sawCaptcha = true;
  }

  if (sawCaptcha) return { status: 'manual_required', reason: 'captcha present' };
  if (sawJsForm)  return { status: 'manual_required', reason: 'js-rendered form' };
  return { status: 'no_form' };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const stats = { processed: 0, simple: 0, manual_required: 0, no_form: 0, skipped: false };
  const startedAt = Date.now();
  const deadline  = startedAt + TIME_BUDGET_MS;

  try {
    // Target: leads with NO email (extraction already failed), not yet form-checked,
    // not telegram, not excluded. Newest first.
    const { data: leads, error } = await supabase
      .from('leads')
      .select('id, url, name')
      .is('contact_email', null)
      .eq('contact_email_type', 'not_found')
      .is('form_status', null)
      .not('stage', 'eq', 'excluded')
      .order('created_at', { ascending: false })
      .limit(BATCH_SIZE);

    if (error) throw new Error(`leads query failed: ${error.message}`);
    if (!leads || leads.length === 0) {
      return new Response(JSON.stringify({ ...stats, reason: 'no leads to check' }),
        { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    // Load the blacklist once — we never touch blacklisted domains.
    let blacklistSet = new Set<string>();
    try {
      const { data: bl } = await supabase.from('blacklist').select('value');
      blacklistSet = new Set((bl || []).map((r: any) => (r.value || '').toLowerCase()));
    } catch (_) { /* blacklist optional */ }

    // Poison-lead protection: mark whole batch 'no_form' up front. A successful
    // detection overwrites it; a site that kills the isolate won't be re-picked forever.
    await supabase.from('leads')
      .update({ form_status: 'no_form' })
      .in('id', leads.map(l => l.id));

    for (const lead of leads) {
      if (Date.now() > deadline) break;
      stats.processed++;
      const url = lead.url as string;

      if (!url || /^https?:\/\/(www\.)?t\.me\//i.test(url)) {
        stats.no_form++;
        continue;
      }

      // Skip blacklisted domains entirely (stays marked no_form).
      const dom = domainOf(url);
      if (dom && blacklistSet.has(dom)) {
        stats.no_form++;
        continue;
      }

      let cls: Classification;
      try {
        cls = await detectForm(url, deadline);
      } catch (e: any) {
        await supabase.from('error_log').insert([{
          level: 'warning', service: 'find-contact-form',
          message: `Lead ${lead.id} form detection error: ${e.message}`, lead_id: lead.id,
        }]);
        stats.no_form++;
        continue;
      }

      const update: Record<string, unknown> = { form_status: cls.status };
      if (cls.form_url)    update.form_url = cls.form_url;
      if (cls.form_fields) update.form_fields = cls.form_fields;
      await supabase.from('leads').update(update).eq('id', lead.id);

      if (cls.status === 'simple')          stats.simple++;
      else if (cls.status === 'manual_required') stats.manual_required++;
      else stats.no_form++;
    }

    await supabase.from('error_log').insert([{
      level: 'info', service: 'find-contact-form',
      message: `Checked ${stats.processed} leads — simple ${stats.simple}, manual ${stats.manual_required}, no_form ${stats.no_form}`,
    }]);

    return new Response(JSON.stringify(stats),
      { headers: { ...cors, 'Content-Type': 'application/json' } });

  } catch (e: any) {
    await supabase.from('error_log').insert([{
      level: 'critical', service: 'find-contact-form', message: e.message,
    }]);
    return new Response(JSON.stringify({ ...stats, error: e.message }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
});
