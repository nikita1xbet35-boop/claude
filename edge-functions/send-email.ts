// Supabase Edge Function: send-email  v2 (2026-05-25)
// Sends a single email via Gmail SMTP (port 465 / TLS) using App Password credentials.
// Uses a minimal hand-rolled SMTP client so we control encoding exactly:
//   - Body: base64, no quoted-printable artifacts
//   - Subject: RFC 2047 base64 encoded-word only when non-ASCII is present
//   - From name: ASCII only
//
// Called by process-queue with: { to, subject, body, account }
// account = 'lp' → LuckyPari Gmail; anything else → main Gmail
//
// Required secrets (set in Supabase dashboard → Settings → Edge Functions):
//   GMAIL_USER_MAIN  — Gmail address for 1xBet/1xCasino outreach
//   GMAIL_PASS_MAIN  — App Password for GMAIL_USER_MAIN
//   GMAIL_USER_LP    — Gmail address for LuckyPari outreach
//   GMAIL_PASS_LP    — App Password for GMAIL_USER_LP
//
// Deploy: supabase functions deploy send-email --no-verify-jwt

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ── Encoding helpers ────────────────────────────────────────────────────────

/** true if every char is printable ASCII (no encoding needed in headers) */
function isAscii(s: string): boolean {
  return /^[\x20-\x7E]*$/.test(s);
}

/** RFC 2047 base64 encoded-word — used for non-ASCII subject/name. */
function rfc2047B(s: string): string {
  // TextEncoder → Uint8Array → base64
  const bytes = new TextEncoder().encode(s);
  let binary  = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return `=?utf-8?B?${btoa(binary)}?=`;
}

/** Encode a header value: leave ASCII alone, wrap non-ASCII in RFC 2047 base64. */
function encodeHeader(s: string): string {
  return isAscii(s) ? s : rfc2047B(s);
}

/**
 * Encode body as base64 per RFC 2045: wrap at 76 chars.
 * This eliminates quoted-printable soft-line-break artifacts completely.
 */
function base64Body(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary  = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  const b64   = btoa(binary);
  return b64.match(/.{1,76}/g)?.join('\r\n') ?? b64;
}

// ── Raw SMTP client ─────────────────────────────────────────────────────────

async function smtpSend(cfg: {
  hostname: string; port: number;
  user: string;     pass: string;
  from: string;     fromName: string;
  to: string;       replyTo: string;
  subject: string;  body: string;
}): Promise<void> {
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  // Wrap buffer so we can read line-by-line across chunks.
  let pending = '';

  // Hard 30-second deadline for the entire SMTP conversation.
  const deadline = Date.now() + 30_000;
  function checkDeadline() {
    if (Date.now() > deadline) throw new Error('SMTP timeout: conversation took >30s');
  }

  const conn = await Deno.connectTls({ hostname: cfg.hostname, port: cfg.port });

  async function readReply(): Promise<{ code: string; text: string }> {
    const lines: string[] = [];
    while (true) {
      checkDeadline();
      // Consume buffered data first.
      while (true) {
        const nl = pending.indexOf('\n');
        if (nl === -1) break;
        lines.push(pending.slice(0, nl).trimEnd());
        pending = pending.slice(nl + 1);
        const last = lines[lines.length - 1];
        // "NNN " = final line; "NNN-" = continuation.
        if (last.length >= 4 && last[3] === ' ') {
          return { code: last.slice(0, 3), text: lines.join(' | ') };
        }
      }
      // Need more data — use a short read timeout so checkDeadline stays active.
      const chunk = new Uint8Array(4096);
      const readPromise = conn.read(chunk);
      const n = await Promise.race([
        readPromise,
        new Promise<null>((_, rej) =>
          setTimeout(() => rej(new Error('SMTP read timeout')), 8_000)),
      ]);
      if (n === null) throw new Error('SMTP connection closed unexpectedly');
      pending += dec.decode(chunk.subarray(0, n as number));
    }
  }

  async function cmd(line: string, expectCode: string): Promise<void> {
    await conn.write(enc.encode(line + '\r\n'));
    const r = await readReply();
    if (r.code !== expectCode) {
      throw new Error(`SMTP: "${line.slice(0, 12)}" → expected ${expectCode}, got ${r.code}: ${r.text}`);
    }
  }

  try {
    // Greeting
    const gr = await readReply();
    if (gr.code !== '220') throw new Error(`SMTP greeting: expected 220, got ${gr.code}`);

    await cmd(`EHLO deno.smtp`, '250');
    await cmd(`AUTH LOGIN`,     '334');
    await cmd(btoa(cfg.user),   '334');
    await cmd(btoa(cfg.pass),   '235');

    await cmd(`MAIL FROM:<${cfg.from}>`, '250');
    await cmd(`RCPT TO:<${cfg.to}>`,     '250');
    await cmd(`DATA`,                    '354');

    // Build the MIME message.
    const msg = [
      `From: ${cfg.fromName} <${cfg.from}>`,
      `To: ${cfg.to}`,
      `Reply-To: ${cfg.replyTo}`,
      `Subject: ${encodeHeader(cfg.subject)}`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset=utf-8`,
      `Content-Transfer-Encoding: base64`,
      ``,
      base64Body(cfg.body),
    ].join('\r\n');

    // RFC 2822: end DATA with CRLF.CRLF
    await conn.write(enc.encode(msg + '\r\n.\r\n'));
    const dataReply = await readReply();
    if (dataReply.code !== '250') {
      throw new Error(`SMTP DATA: expected 250, got ${dataReply.code}: ${dataReply.text}`);
    }

    // Best-effort QUIT (don't wait for reply)
    try { await conn.write(enc.encode('QUIT\r\n')); } catch (_) { /* ignore */ }
  } finally {
    try { conn.close(); } catch (_) { /* ignore */ }
  }
}

// ── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid JSON body' }),
      { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } });
  }

  const { to, subject, body: emailBody, account } = body as {
    to: string; subject: string; body: string; account: string;
  };

  if (!to || !subject || !emailBody) {
    return new Response(JSON.stringify({ error: 'missing required fields: to, subject, body' }),
      { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } });
  }

  // LP account disabled — always use main credentials regardless of `account` param
  const gmailUser = Deno.env.get('GMAIL_USER_MAIN');
  const gmailPass = Deno.env.get('GMAIL_PASS_MAIN');

  if (!gmailUser || !gmailPass) {
    return new Response(JSON.stringify({ error: 'GMAIL_USER_MAIN or GMAIL_PASS_MAIN is not set in Supabase Secrets' }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
  }

  if (gmailPass === 'default' || gmailPass.length < 8) {
    return new Response(JSON.stringify({
      error: `GMAIL_PASS_MAIN looks like a placeholder ("${gmailPass.slice(0,6)}..."). Set a real Gmail App Password in Supabase Secrets.`,
    }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
  }

  const senderName = 'Nick - 1xPartners';

  try {
    await smtpSend({
      hostname: 'smtp.gmail.com',
      port:     465,
      user:     gmailUser,
      pass:     gmailPass,
      from:     gmailUser,
      fromName: senderName,
      to,
      replyTo:  gmailUser,
      subject,
      body:     emailBody,
    });

    const pseudoId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return new Response(JSON.stringify({ success: true, gmail_message_id: pseudoId }),
      { headers: { ...cors, 'Content-Type': 'application/json' } });

  } catch (e: any) {
    return new Response(JSON.stringify({ error: `SMTP send failed: ${e.message || e}` }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
});
