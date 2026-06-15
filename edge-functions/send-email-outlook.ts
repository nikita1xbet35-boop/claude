// Supabase Edge Function: send-email-outlook
// Sends a single email via Outlook SMTP (smtp-mail.outlook.com:587 / STARTTLS).
// Unlike Gmail (port 465 / implicit TLS), Outlook uses STARTTLS: connect plain,
// then upgrade mid-conversation with the STARTTLS command + Deno.startTls().
//
// Called by process-queue-lp with: { to, subject, body }
//
// Required secrets (Supabase → Settings → Edge Functions → Secrets):
//   OUTLOOK_USER  — full Outlook address, e.g. nick@outlook.com
//   OUTLOOK_PASS  — App Password (if 2FA enabled) OR regular password
//
// Deploy: supabase functions deploy send-email-outlook --no-verify-jwt

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function isAscii(s: string): boolean {
  return /^[\x20-\x7E]*$/.test(s);
}
function rfc2047B(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `=?utf-8?B?${btoa(bin)}?=`;
}
function encodeHeader(s: string): string {
  return isAscii(s) ? s : rfc2047B(s);
}
function base64Body(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = btoa(bin);
  return b64.match(/.{1,76}/g)?.join('\r\n') ?? b64;
}

async function smtpSendStartTls(cfg: {
  hostname: string; port: number;
  user: string;     pass: string;
  from: string;     fromName: string;
  to: string;       replyTo: string;
  subject: string;  body: string;
}): Promise<void> {
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  let pending = '';
  const deadline = Date.now() + 40_000;

  function checkDeadline() {
    if (Date.now() > deadline) throw new Error('SMTP timeout: conversation took >40s');
  }

  type AnyConn = Deno.TcpConn | Deno.TlsConn;

  async function readReply(conn: AnyConn): Promise<{ code: string; text: string }> {
    const lines: string[] = [];
    while (true) {
      checkDeadline();
      while (true) {
        const nl = pending.indexOf('\n');
        if (nl === -1) break;
        lines.push(pending.slice(0, nl).trimEnd());
        pending = pending.slice(nl + 1);
        const last = lines[lines.length - 1];
        if (last.length >= 4 && last[3] === ' ') {
          return { code: last.slice(0, 3), text: lines.join(' | ') };
        }
      }
      const chunk = new Uint8Array(4096);
      const n = await Promise.race([
        conn.read(chunk),
        new Promise<null>((_, rej) => setTimeout(() => rej(new Error('SMTP read timeout')), 8_000)),
      ]);
      if (n === null) throw new Error('SMTP connection closed unexpectedly');
      pending += dec.decode(chunk.subarray(0, n as number));
    }
  }

  async function cmd(conn: AnyConn, line: string, expectCode: string): Promise<void> {
    await conn.write(enc.encode(line + '\r\n'));
    const r = await readReply(conn);
    if (r.code !== expectCode) {
      throw new Error(`SMTP "${line.slice(0, 20)}" → expected ${expectCode}, got ${r.code}: ${r.text}`);
    }
  }

  // Phase 1 — plain TCP + STARTTLS negotiation
  const tcpConn = await Deno.connect({ hostname: cfg.hostname, port: cfg.port });

  let tlsConn: Deno.TlsConn | null = null;
  try {
    const gr = await readReply(tcpConn);
    if (gr.code !== '220') throw new Error(`SMTP greeting: ${gr.code}: ${gr.text}`);

    await cmd(tcpConn, `EHLO deno.smtp`, '250');
    await cmd(tcpConn, `STARTTLS`, '220');

    // Phase 2 — upgrade to TLS in-place (Deno takes ownership of tcpConn)
    pending = '';
    tlsConn = await Deno.startTls(tcpConn, { hostname: cfg.hostname });

    await cmd(tlsConn, `EHLO deno.smtp`, '250');
    await cmd(tlsConn, `AUTH LOGIN`, '334');
    await cmd(tlsConn, btoa(cfg.user), '334');
    await cmd(tlsConn, btoa(cfg.pass), '235');

    await cmd(tlsConn, `MAIL FROM:<${cfg.from}>`, '250');
    await cmd(tlsConn, `RCPT TO:<${cfg.to}>`, '250');
    await cmd(tlsConn, `DATA`, '354');

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

    await tlsConn.write(enc.encode(msg + '\r\n.\r\n'));
    const dataReply = await readReply(tlsConn);
    if (dataReply.code !== '250') {
      throw new Error(`SMTP DATA: expected 250, got ${dataReply.code}: ${dataReply.text}`);
    }

    try { await tlsConn.write(enc.encode('QUIT\r\n')); } catch (_) { /* best-effort */ }
  } finally {
    try { tlsConn?.close(); } catch (_) { /* ignore */ }
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid JSON body' }),
      { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } });
  }

  const { to, subject, body: emailBody } = body as {
    to: string; subject: string; body: string;
  };

  if (!to || !subject || !emailBody) {
    return new Response(JSON.stringify({ error: 'missing required fields: to, subject, body' }),
      { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } });
  }

  const outlookUser = Deno.env.get('OUTLOOK_USER');
  const outlookPass = Deno.env.get('OUTLOOK_PASS');

  if (!outlookUser || !outlookPass) {
    return new Response(JSON.stringify({ error: 'OUTLOOK_USER or OUTLOOK_PASS not set in Supabase Secrets' }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
  }

  try {
    await smtpSendStartTls({
      hostname: 'smtp-mail.outlook.com',
      port:     587,
      user:     outlookUser,
      pass:     outlookPass,
      from:     outlookUser,
      fromName: 'Nick - LuckyPari Partners',
      to,
      replyTo:  outlookUser,
      subject,
      body:     emailBody,
    });

    const pseudoId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return new Response(JSON.stringify({ success: true, message_id: pseudoId }),
      { headers: { ...cors, 'Content-Type': 'application/json' } });

  } catch (e: any) {
    return new Response(JSON.stringify({ error: `SMTP send failed: ${e.message || e}` }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
});
