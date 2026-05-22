// Supabase Edge Function: send-email
// Sends a single email via Gmail SMTP using App Password credentials.
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

import { SMTPClient } from 'https://deno.land/x/denomailer@1.6.0/mod.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

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

  const isLP    = account === 'lp';
  const gmailUser = isLP
    ? Deno.env.get('GMAIL_USER_LP')
    : Deno.env.get('GMAIL_USER_MAIN');
  const gmailPass = isLP
    ? Deno.env.get('GMAIL_PASS_LP')
    : Deno.env.get('GMAIL_PASS_MAIN');

  if (!gmailUser || !gmailPass) {
    const missing = isLP ? 'GMAIL_USER_LP / GMAIL_PASS_LP' : 'GMAIL_USER_MAIN / GMAIL_PASS_MAIN';
    return new Response(JSON.stringify({ error: `Gmail credentials not configured: ${missing}` }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
  }

  const senderName = isLP ? 'Andreas — LuckyPari' : 'Nick — 1xPartners';

  try {
    const client = new SMTPClient({
      connection: {
        hostname: 'smtp.gmail.com',
        port: 465,
        tls: true,
        auth: { username: gmailUser, password: gmailPass },
      },
    });

    await client.send({
      from:    `${senderName} <${gmailUser}>`,
      to,
      replyTo: gmailUser,
      subject,
      content: emailBody,   // plain-text body
    });

    // A failure to close the connection must not fail an already-sent email.
    try { await client.close(); } catch (_) { /* connection cleanup only */ }

    const pseudoId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return new Response(JSON.stringify({ success: true, gmail_message_id: pseudoId }),
      { headers: { ...cors, 'Content-Type': 'application/json' } });

  } catch (e: any) {
    return new Response(JSON.stringify({ error: `SMTP send failed: ${e.message || e}` }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
});
