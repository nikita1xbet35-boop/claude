// Supabase Edge Function: send-alert
// Sends Telegram notifications at three levels: warning (⚠️), critical (🔴), info (ℹ️)
// Deploy: supabase functions deploy send-alert
// Env vars needed: ALERTS_BOT_TOKEN, ALERTS_CHAT_ID, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const BOT_TOKEN    = Deno.env.get('ALERTS_BOT_TOKEN')!;
const CHAT_ID      = Deno.env.get('ALERTS_CHAT_ID')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function sendTelegram(text: string): Promise<boolean> {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML' })
  });
  return res.ok;
}

async function logEvent(level: string, service: string, message: string) {
  await supabase.from('error_log').insert([{ level, service, message }]);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    const { level, service, message, custom_text } = await req.json();

    let text = custom_text;

    if (!text) {
      if (level === 'warning') {
        text = `⚠️ <b>AffiliateOS Warning</b>\n\n<b>${service}</b>: ${message}\n\nAction: prepare backup key or upgrade tier.`;
      } else if (level === 'critical') {
        text = `🔴 <b>AffiliateOS Critical</b>\n\n<b>${service}</b>: ${message}\n\nAction: Settings → API Keys → Update key, then press Resume.`;
      } else {
        text = `ℹ️ <b>AffiliateOS</b>\n\n${message}`;
      }
    }

    const ok = await sendTelegram(text);
    await logEvent(level || 'info', service || 'system', message || custom_text);

    return new Response(JSON.stringify({ success: ok }), {
      headers: { ...cors, 'Content-Type': 'application/json' }
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ success: false, error: e.message }), {
      status: 500, headers: { ...cors, 'Content-Type': 'application/json' }
    });
  }
});
