// Supabase Edge Function: poll-replies
// ════════════════════════════════════════════════════════════════════════════
// P0.2 — Reply listening. Closes the loop: until now the system could send and
// detect bounces, but was blind to actual answers.
//
// Transport note: the mailbox is driven over SMTP with a Gmail App Password, so
// there is no OAuth token available for the Gmail API. An App Password *does*
// authorise IMAP, so this polls imap.gmail.com:993 directly with a minimal
// hand-rolled client, mirroring the style of the existing SMTP client in
// send-email.ts (no third-party IMAP dependency to audit or keep alive).
//
// Flow per run:
//   1. LOGIN + SELECT INBOX
//   2. UID SEARCH for messages newer than the last processed UID
//   3. UID FETCH (partial — first 16KB is plenty for a reply)
//   4. Match the reply to a lead via In-Reply-To / References -> the Message-ID
//      we stamped on the original send; fall back to sender address
//   5. Classify with an LLM into the eight ТЗ categories
//   6. Apply consequences: stop the sequence, suppress, alert on hot leads
//
// Idempotent: replies.imap_uid is uniquely indexed, and the UID cursor only
// advances after a successful pass, so a re-run cannot double-insert.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GMAIL_USER_MAIN, GMAIL_PASS_MAIN,
//      GROQ_API_KEY (+ GROQ_KEY_2/3), ANTHROPIC_API_KEY (optional, preferred),
//      ALERTS_BOT_TOKEN, ALERTS_CHAT_ID

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const GMAIL_USER   = Deno.env.get('GMAIL_USER_MAIN') || '';
const GMAIL_PASS   = Deno.env.get('GMAIL_PASS_MAIN') || '';
const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY') || '';
const TG_TOKEN     = Deno.env.get('ALERTS_BOT_TOKEN') || '';
const TG_CHAT      = Deno.env.get('ALERTS_CHAT_ID') || '';

const GROQ_KEYS = [
  Deno.env.get('GROQ_API_KEY') || '',
  Deno.env.get('GROQ_KEY_2')   || '',
  Deno.env.get('GROQ_KEY_3')   || '',
].filter(Boolean);

const IMAP_HOST = 'imap.gmail.com';
const IMAP_PORT = 993;
const MAX_PER_RUN = 25;          // messages processed per invocation
const FETCH_BYTES = 16384;       // partial fetch — a reply never needs more
const BODY_FOR_LLM = 2500;       // chars of cleaned body sent to the classifier

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Encoding helpers ────────────────────────────────────────────────────────
// The IMAP conversation is read as latin1 so that string offsets equal byte
// offsets (literal lengths in IMAP are byte counts). Real text is converted to
// UTF-8 only once we have isolated the field we care about.
const L1 = new TextDecoder('iso-8859-1');
const ENC = new TextEncoder();

function toUtf8(latin1: string): string {
  const bytes = Uint8Array.from(latin1, c => c.charCodeAt(0) & 0xff);
  return new TextDecoder('utf-8').decode(bytes);
}

function b64decode(s: string): string {
  try { return atob(s.replace(/\s+/g, '')); } catch { return ''; }
}

function qpDecode(s: string): string {
  return s
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

// RFC 2047 encoded words: =?utf-8?B?...?= / =?utf-8?Q?...?=
function decodeMimeWords(s: string): string {
  return s.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_m, charset, enc, text) => {
    const raw = enc.toUpperCase() === 'B' ? b64decode(text) : qpDecode(text.replace(/_/g, ' '));
    return /utf-?8/i.test(charset) ? toUtf8(raw) : raw;
  }).replace(/\?=\s+=\?/g, '');
}

// ── Minimal IMAP client ─────────────────────────────────────────────────────
class Imap {
  private conn!: Deno.TlsConn;
  private buf = '';
  private tagN = 0;
  private deadline = Date.now() + 60_000;

  async connect() {
    this.conn = await Deno.connectTls({ hostname: IMAP_HOST, port: IMAP_PORT });
    await this.readUntilGreeting();
  }

  close() { try { this.conn.close(); } catch { /* ignore */ } }

  private async readChunk(): Promise<boolean> {
    if (Date.now() > this.deadline) throw new Error('IMAP timeout');
    const b = new Uint8Array(65536);
    const n = await Promise.race([
      this.conn.read(b),
      new Promise<null>((_, rej) => setTimeout(() => rej(new Error('IMAP read timeout')), 15_000)),
    ]);
    if (n === null) return false;
    this.buf += L1.decode(b.subarray(0, n as number));
    return true;
  }

  private async readUntilGreeting() {
    while (!/^\* (OK|PREAUTH)/m.test(this.buf)) {
      if (!await this.readChunk()) throw new Error('IMAP closed before greeting');
    }
    this.buf = '';
  }

  // Walks the buffer honouring {n} literals, so a literal containing something
  // that looks like a tagged completion line cannot end the read early.
  private findEnd(tag: string): number {
    let i = 0;
    while (i < this.buf.length) {
      const nl = this.buf.indexOf('\r\n', i);
      if (nl === -1) return -1;
      const line = this.buf.slice(i, nl);
      const lit = line.match(/\{(\d+)\}$/);
      if (lit) {
        const skip = parseInt(lit[1], 10);
        i = nl + 2 + skip;
        if (i > this.buf.length) return -1;
        continue;
      }
      if (line.startsWith(tag + ' ')) return nl + 2;
      i = nl + 2;
    }
    return -1;
  }

  async cmd(command: string): Promise<string> {
    const tag = 'A' + (++this.tagN).toString().padStart(3, '0');
    await this.conn.write(ENC.encode(`${tag} ${command}\r\n`));
    let end = this.findEnd(tag);
    while (end === -1) {
      if (!await this.readChunk()) throw new Error('IMAP connection closed mid-response');
      end = this.findEnd(tag);
    }
    const resp = this.buf.slice(0, end);
    this.buf = this.buf.slice(end);
    const status = resp.slice(resp.lastIndexOf(tag + ' ') + tag.length + 1, end).trim().split(' ')[0];
    if (status !== 'OK') {
      throw new Error(`IMAP ${command.split(' ')[0]} failed: ${resp.slice(-250).trim()}`);
    }
    return resp;
  }
}

// ── RFC822 parsing ──────────────────────────────────────────────────────────
interface ParsedMail {
  from: string; subject: string; date: string;
  messageId: string; inReplyTo: string; references: string;
  body: string;
}

function unfoldHeaders(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const unfolded = raw.replace(/\r\n[ \t]+/g, ' ');
  for (const line of unfolded.split('\r\n')) {
    const i = line.indexOf(':');
    if (i < 1) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    const v = line.slice(i + 1).trim();
    if (!(k in out)) out[k] = v;
  }
  return out;
}

function decodeBodyPart(raw: string, cte: string, charset: string): string {
  let s = raw;
  const enc = (cte || '').toLowerCase();
  if (enc.includes('base64'))            s = b64decode(s);
  else if (enc.includes('quoted-print')) s = qpDecode(s);
  return /utf-?8/i.test(charset || '') ? toUtf8(s) : s;
}

function parseMail(raw: string): ParsedMail {
  const split = raw.indexOf('\r\n\r\n');
  const headRaw = split === -1 ? raw : raw.slice(0, split);
  const bodyRaw = split === -1 ? ''  : raw.slice(split + 4);
  const h = unfoldHeaders(headRaw);

  const ctype = h['content-type'] || '';
  let body = '';

  const boundary = ctype.match(/boundary="?([^";]+)"?/i)?.[1];
  if (boundary) {
    // Take the first text/plain part; fall back to the first part at all.
    const parts = bodyRaw.split('--' + boundary);
    let chosen = '';
    for (const p of parts) {
      const ps = p.indexOf('\r\n\r\n');
      if (ps === -1) continue;
      const ph = unfoldHeaders(p.slice(0, ps));
      const pct = ph['content-type'] || '';
      if (/text\/plain/i.test(pct)) {
        chosen = decodeBodyPart(p.slice(ps + 4), ph['content-transfer-encoding'] || '',
          pct.match(/charset="?([^";]+)"?/i)?.[1] || '');
        break;
      }
      if (!chosen && /text\/html/i.test(pct)) {
        chosen = decodeBodyPart(p.slice(ps + 4), ph['content-transfer-encoding'] || '',
          pct.match(/charset="?([^";]+)"?/i)?.[1] || '').replace(/<[^>]+>/g, ' ');
      }
    }
    body = chosen;
  } else {
    body = decodeBodyPart(bodyRaw, h['content-transfer-encoding'] || '',
      ctype.match(/charset="?([^";]+)"?/i)?.[1] || '');
    if (/text\/html/i.test(ctype)) body = body.replace(/<[^>]+>/g, ' ');
  }

  return {
    from:       decodeMimeWords(h['from'] || ''),
    subject:    decodeMimeWords(h['subject'] || ''),
    date:       h['date'] || '',
    messageId:  h['message-id'] || '',
    inReplyTo:  h['in-reply-to'] || '',
    references: h['references'] || '',
    body,
  };
}

function emailOf(addr: string): string {
  const m = addr.match(/<([^>]+)>/);
  return (m ? m[1] : addr).trim().toLowerCase();
}

function bareIds(s: string): string[] {
  return [...(s || '').matchAll(/<([^>]+)>/g)].map(m => m[1].trim());
}

// Strip the quoted original so the classifier judges only what the human wrote.
function cleanBody(s: string): string {
  const lines = (s || '').replace(/\r/g, '').split('\n');
  const out: string[] = [];
  for (const ln of lines) {
    if (/^\s*>/.test(ln)) continue;
    if (/^\s*(On .+ wrote:|Le .+ a écrit\s*:|-{2,}\s*Original Message|_{5,})/i.test(ln)) break;
    out.push(ln);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ── Classification ──────────────────────────────────────────────────────────
const CATEGORIES = ['interested','soft_no','hard_no','asks_fixed_fee','question','auto_reply','ooo','unsubscribe'];

const CLASSIFY_SYSTEM = `You classify replies to B2B affiliate-partnership outreach for a sportsbook brand.
Return STRICT JSON only, no prose, with exactly these keys:
{"category":"...","sentiment":"positive|neutral|negative","lang":"<ISO 639-1>","extracted_terms":{"rs_ask":null|number,"fix_ask":null|number,"geo":[],"questions":[]}}
category MUST be one of: ${CATEGORIES.join(' | ')}.
Rules:
- interested: wants to proceed, asks for terms/rates, positive intent.
- asks_fixed_fee: explicitly wants a fixed fee / CPM / flat payment instead of revenue share.
- question: asks something specific without committing.
- soft_no: not now / maybe later / busy.
- hard_no: clear refusal.
- unsubscribe: asks to stop being contacted, remove, opt out.
- auto_reply: automatic acknowledgement, no human wrote it.
- ooo: out-of-office autoresponder.
rs_ask = requested revenue-share percent as a number. fix_ask = requested fixed amount in USD.`;

async function groqChat(system: string, user: string): Promise<string> {
  for (let i = 0; i < GROQ_KEYS.length; i++) {
    const key = GROQ_KEYS[i];
    try {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
        body: JSON.stringify({
          model: 'llama-3.1-8b-instant',
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        }),
      });
      if (r.status === 429 || r.status >= 500) continue;   // rotate to next key
      const j = await r.json();
      const txt = j?.choices?.[0]?.message?.content;
      if (txt) return txt;
    } catch (_) { /* try next key */ }
  }
  return '';
}

async function claudeChat(system: string, user: string): Promise<string> {
  if (!ANTHROPIC_KEY) return '';
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 700,
        system,                                  // stable prefix — cache-friendly
        messages: [{ role: 'user', content: user }],
      }),
    });
    if (!r.ok) return '';
    const j = await r.json();
    return j?.content?.[0]?.text || '';
  } catch { return ''; }
}

function parseJsonLoose(s: string): Record<string, unknown> | null {
  if (!s) return null;
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// Deterministic fallback so a classifier outage never silently drops a hot lead.
function heuristicCategory(subject: string, body: string): string {
  const t = (subject + ' ' + body).toLowerCase();
  if (/out of office|congé|abwesen|automatic reply|autoreply/.test(t)) return 'ooo';
  if (/unsubscribe|desabonner|remove me|stop contacting|отписат/.test(t)) return 'unsubscribe';
  if (/fixed fee|flat fee|cpm|fixe|фикс/.test(t)) return 'asks_fixed_fee';
  if (/not interested|no thanks|pas intéressé|не интересно/.test(t)) return 'hard_no';
  if (/\?/.test(body)) return 'question';
  return 'question';
}

async function classify(subject: string, body: string): Promise<Record<string, any>> {
  const user = `Subject: ${subject}\n\nBody:\n${body.slice(0, BODY_FOR_LLM)}`;
  let raw = await claudeChat(CLASSIFY_SYSTEM, user);
  if (!raw) raw = await groqChat(CLASSIFY_SYSTEM, user);
  const parsed = parseJsonLoose(raw);
  const category = parsed && CATEGORIES.includes(String(parsed.category))
    ? String(parsed.category)
    : heuristicCategory(subject, body);
  return {
    category,
    sentiment: String(parsed?.sentiment || 'neutral'),
    lang: String(parsed?.lang || '').slice(0, 5) || null,
    extracted_terms: parsed?.extracted_terms ?? null,
    llm: !!parsed,
  };
}

// ── P1.2  Auto-draft replies ────────────────────────────────────────────────
// A draft is prepared for every reply worth answering and parked for approval.
// Nothing is ever sent automatically — approval happens in the Hot Inbox.
const DRAFT_SYSTEM = `You draft replies for a 1xBet affiliate partnership manager named Nick.
Write ONLY the email body — no subject line, no signature block, no placeholders in brackets.
Hard rules:
- Reply in the SAME language the incoming message used (French -> French, Russian -> Russian, otherwise English).
- Never open with "I came across" or similar cold-outreach filler; this is an ongoing conversation.
- No em dashes. Confident, concise, peer-to-peer tone. 60-120 words.
- We offer revenue share, not fixed fees. Never disparage a competitor or ask anyone to switch.
Category guidance:
- interested: warm confirmation plus one concrete next step (share terms / arrange a call).
- question: answer directly, then one light nudge toward next step.
- asks_fixed_fee: counter-anchor. Decline the fixed fee politely, argue that revenue share compounds
  in licensed GEOs where the audience keeps playing, and note that a strong RevShare beats a flat rate
  once volume builds. Offer to model their numbers.`;

async function buildDraft(category: string, lang: string | null, subject: string, body: string): Promise<string> {
  const user =
    `Category: ${category}\nLanguage of incoming message: ${lang || 'unknown'}\n` +
    `Their subject: ${subject}\n\nTheir message:\n${body.slice(0, BODY_FOR_LLM)}`;
  let out = await claudeChat(DRAFT_SYSTEM, user);
  if (!out) {
    // Groq is JSON-forced elsewhere; ask for prose here via a plain schema.
    const raw = await groqChat(DRAFT_SYSTEM + '\nReturn JSON: {"reply":"<the email body>"}', user);
    out = String(parseJsonLoose(raw)?.reply || '');
  }
  return (out || '').trim();
}

// ── Telegram ────────────────────────────────────────────────────────────────
async function tg(text: string) {
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
  } catch { /* alerting is best-effort */ }
}

async function logInfo(message: string, level = 'info') {
  await supabase.from('error_log').insert([{ level, service: 'poll-replies', message }]).catch(() => {});
}

// ── Handler ─────────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const stats = { fetched: 0, saved: 0, skipped: 0, interested: 0, notified: 0, drafted: 0, orphan: 0, reason: '' };

  if (!GMAIL_USER || !GMAIL_PASS) {
    return new Response(JSON.stringify({ ...stats, error: 'GMAIL_USER_MAIN / GMAIL_PASS_MAIN not set' }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
  }

  const imap = new Imap();
  try {
    await imap.connect();
    // Literal form avoids quoting problems with App Password characters.
    await imap.cmd(`LOGIN "${GMAIL_USER}" "${GMAIL_PASS.replace(/"/g, '\\"')}"`);
    await imap.cmd('SELECT INBOX');

    const { data: cursorRow } = await supabase.from('app_state')
      .select('value').eq('key', 'imap_last_uid').maybeSingle();
    const lastUid = parseInt(cursorRow?.value || '0', 10) || 0;

    // First ever run: only look at the last two days rather than the whole
    // mailbox history, then let the UID cursor take over.
    let searchResp: string;
    if (lastUid > 0) {
      searchResp = await imap.cmd(`UID SEARCH UID ${lastUid + 1}:*`);
    } else {
      const since = new Date(Date.now() - 2 * 864e5);
      const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][since.getUTCMonth()];
      searchResp = await imap.cmd(`UID SEARCH SINCE ${since.getUTCDate()}-${mon}-${since.getUTCFullYear()}`);
    }

    const uids = (searchResp.match(/^\* SEARCH([^\r]*)/m)?.[1] || '')
      .trim().split(/\s+/).filter(Boolean).map(Number)
      .filter(u => Number.isFinite(u) && u > lastUid)
      .sort((a, b) => a - b);

    if (!uids.length) {
      imap.close();
      stats.reason = 'no new messages';
      return new Response(JSON.stringify(stats), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    const batch = uids.slice(0, MAX_PER_RUN);
    let maxUid = lastUid;

    for (const uid of batch) {
      let mail: ParsedMail;
      try {
        const resp = await imap.cmd(`UID FETCH ${uid} (BODY.PEEK[]<0.${FETCH_BYTES}>)`);
        // Response carries the message inside a {n} literal.
        const lit = resp.match(/\{(\d+)\}\r\n/);
        if (!lit) { stats.skipped++; maxUid = Math.max(maxUid, uid); continue; }
        const start = resp.indexOf(lit[0]) + lit[0].length;
        mail = parseMail(resp.slice(start, start + parseInt(lit[1], 10)));
      } catch (_) {
        stats.skipped++;
        continue;                                   // leave cursor so it retries
      }

      stats.fetched++;
      maxUid = Math.max(maxUid, uid);

      const fromEmail = emailOf(mail.from);
      // Our own outgoing copies and Gmail's own notices are not replies.
      if (!fromEmail || fromEmail === GMAIL_USER.toLowerCase()) { stats.skipped++; continue; }

      // ── Match to the send this answers ──────────────────────────────────
      const refIds = [...bareIds(mail.inReplyTo), ...bareIds(mail.references)];
      let leadId: string | null = null;
      let emailLogId: number | null = null;
      let threadId: string | null = refIds[0] || null;

      if (refIds.length) {
        const { data: logRow } = await supabase.from('email_log')
          .select('id, lead_id, gmail_message_id')
          .in('gmail_message_id', refIds).limit(1).maybeSingle();
        if (logRow) {
          leadId = logRow.lead_id;
          emailLogId = logRow.id;
          threadId = logRow.gmail_message_id;
        }
      }
      if (!leadId) {
        // Fallback: sender address. Covers replies whose client dropped the
        // threading headers, and everything sent before Message-ID was stamped.
        const { data: leadRow } = await supabase.from('leads')
          .select('id').ilike('contact_email', fromEmail).limit(1).maybeSingle();
        if (leadRow) leadId = leadRow.id;
      }
      if (!leadId) stats.orphan++;

      const cleaned = cleanBody(mail.body);
      const cls = await classify(mail.subject, cleaned);

      const receivedAt = (() => {
        const d = new Date(mail.date);
        return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
      })();

      const { error: insErr } = await supabase.from('replies').insert([{
        lead_id: leadId,
        email_log_id: emailLogId,
        thread_id: threadId,
        imap_uid: uid,
        from_email: fromEmail,
        subject: mail.subject.slice(0, 500),
        body: cleaned.slice(0, 8000),
        lang: cls.lang,
        received_at: receivedAt,
        category: cls.category,
        sentiment: cls.sentiment,
        extracted_terms: cls.extracted_terms,
        handled: ['auto_reply', 'ooo'].includes(cls.category),   // nothing to do for these
      }]);

      if (insErr) {
        // Unique violation = already stored on an earlier pass.
        if (!String(insErr.message || '').includes('duplicate')) {
          await logInfo(`insert failed uid=${uid}: ${insErr.message}`, 'warning');
        }
        stats.skipped++;
        continue;
      }
      stats.saved++;

      // ── Consequences ────────────────────────────────────────────────────
      const cat = cls.category;
      const isAuto = cat === 'auto_reply' || cat === 'ooo';

      if (leadId && !isAuto) {
        // A human answered: the lead leaves the follow-up sequence.
        await supabase.from('leads').update({
          replied_at: receivedAt,
          reply_category: cat,
          sequence_status: 'replied',
          next_action_at: null,
        }).eq('id', leadId);
      }

      if (cat === 'unsubscribe' || cat === 'hard_no') {
        await supabase.from('suppression_list')
          .upsert({ email: fromEmail, reason: cat }, { onConflict: 'email' });
        // Pull anything already queued for this address.
        if (leadId) {
          await supabase.from('send_queue')
            .update({ status: 'skipped', error: `suppressed: ${cat}` })
            .eq('lead_id', leadId).eq('status', 'pending');
        }
        await supabase.from('partner_leads')
          .update({ status: 'stopped' })
          .ilike('email', fromEmail).eq('status', 'new');
      }

      // ── P1.2 draft on approval queue ────────────────────────────────────
      let draftMade = false;
      if (['interested', 'question', 'asks_fixed_fee'].includes(cat)) {
        const replyRow = await supabase.from('replies')
          .select('id').eq('imap_uid', uid).maybeSingle();
        const draft = await buildDraft(cat, cls.lang, mail.subject, cleaned);
        if (draft && replyRow.data?.id) {
          await supabase.from('draft_replies').insert([{
            reply_id: replyRow.data.id,
            lead_id: leadId,
            draft_body: draft,
            subject: mail.subject.toLowerCase().startsWith('re:') ? mail.subject : `Re: ${mail.subject}`,
            lang: cls.lang,
            status: 'pending',
          }]).catch(() => {});
          stats.drafted++;
          draftMade = true;
        }
      }

      // ── Telegram: notify on EVERY human reply ───────────────────────────
      // The operator answers from the mailbox, so every real answer gets mirrored
      // to TG. Autoresponders (auto_reply/ooo) are not answers and stay silent —
      // they were already marked handled above.
      if (cat !== 'auto_reply' && cat !== 'ooo') {
        stats.notified++;
        if (cat === 'interested' || cat === 'asks_fixed_fee') stats.interested++;
        const CAT_TG: Record<string, string> = {
          interested:     '🔥 Заинтересован',
          asks_fixed_fee: '💰 Просит фикс',
          question:       '❓ Вопрос',
          soft_no:        '🟡 Мягкий отказ',
          hard_no:        '⛔ Отказ',
          unsubscribe:    '🚫 Отписка',
        };
        const terms = cls.extracted_terms || {};
        await tg(
          `<b>${CAT_TG[cat] || '✉️ Ответ'}</b>\n` +
          `От: <code>${fromEmail}</code>\n` +
          `Тема: ${(mail.subject || '—').slice(0, 120)}\n` +
          (terms.rs_ask ? `Просит RS: ${terms.rs_ask}%\n` : '') +
          (terms.fix_ask ? `Просит фикс: $${terms.fix_ask}\n` : '') +
          (draftMade ? '📝 Черновик готов в разделе «Инбокс»\n' : '') +
          `\n${cleaned.slice(0, 400)}`
        );
      }
    }

    imap.close();

    if (maxUid > lastUid) {
      await supabase.from('app_state').upsert(
        { key: 'imap_last_uid', value: String(maxUid), updated_at: new Date().toISOString() },
        { onConflict: 'key' },
      );
    }

    await logInfo(`fetched=${stats.fetched} saved=${stats.saved} interested=${stats.interested} drafted=${stats.drafted} orphan=${stats.orphan} uid<=${maxUid} remaining=${Math.max(0, uids.length - batch.length)}`);
    return new Response(JSON.stringify(stats), { headers: { ...cors, 'Content-Type': 'application/json' } });

  } catch (e: any) {
    imap.close();
    await logInfo(`error: ${e.message || e}`, 'warning');
    return new Response(JSON.stringify({ ...stats, error: String(e.message || e) }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
});
