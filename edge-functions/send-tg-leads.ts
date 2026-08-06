// Supabase Edge Function: send-tg-leads
// ════════════════════════════════════════════════════════════════════════════
// Stage 4 of the Telegram outreach pipeline: DELIVERY TO THE OPERATOR.
//
// Sends a lead card — channel facts + the ready-to-paste draft — to ONE chat:
// ALERTS_CHAT_ID, the operator's own chat with the notification bot. The card
// carries two buttons ("Беру" / "Отклонить") which come back through the Worker
// webhook as { decide: { id, action } } on this same function.
//
// This is the only place in the pipeline that talks to Telegram, and it only
// ever talks to the operator. It never messages a channel owner: the draft is
// delivered to the operator to send by hand.
//
// Volume mode: runs round the clock, up to DAILY_CAP cards a day. Quiet hours
// are opt-in via TG_LEADS_QUIET=true. The daily cap is the one hard stop, and it
// exists to stay clear of Telegram's per-chat flood limits rather than to ration
// the operator's attention.
//
// Rides the existing */15 Cloudflare tick.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ALERTS_BOT_TOKEN, ALERTS_CHAT_ID

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const BOT_TOKEN    = Deno.env.get('ALERTS_BOT_TOKEN') || '';
const CHAT_ID      = Deno.env.get('ALERTS_CHAT_ID') || '';

const SEND_BATCH = 8;
const DAILY_CAP  = Number(Deno.env.get('TG_LEADS_DAILY_CAP') || 200);
// Round the clock. These are search results, not messages to partners — the
// operator works the base by hand whenever they get to it, so there is nothing
// to hold back for business hours. Set TG_LEADS_QUIET=true to restore a
// 22:00–08:00 GMT+3 window.
const QUIET      = (Deno.env.get('TG_LEADS_QUIET') || '').toLowerCase() === 'true';
const QUIET_FROM = 22;   // GMT+3
const QUIET_TO   = 8;
const DELAY_MS   = 900;  // Telegram tolerates ~20 msg/min to one chat
const STATE_KEY  = 'tg_leads_sent';   // "YYYY-MM-DD|N"

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Best-effort await. A Supabase query builder is a thenable WITHOUT .catch, so
// `builder.catch(...)` throws TypeError instead of swallowing anything — a
// bookkeeping write has to be wrapped like this to stay non-fatal.
async function quiet(p: PromiseLike<unknown>): Promise<void> {
  try { await p; } catch { /* bookkeeping is best-effort */ }
}

function gmt3() {
  const g = new Date(Date.now() + 3 * 60 * 60 * 1000);
  return { hour: g.getUTCHours(), date: g.toISOString().slice(0, 10) };
}

const esc = (s: unknown) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function tg(method: string, payload: Record<string, unknown>): Promise<any> {
  if (!BOT_TOKEN || !CHAT_ID) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    return await res.json().catch(() => null);
  } catch { return null; }
}

interface Row {
  id: number; channel_url: string; channel_name: string | null;
  subscribers: number | null; geo: string | null; language: string | null;
  niche: string | null; ai_score: number | null; ai_reasoning: string | null;
  owner_contact: string | null; contact_type: string | null; draft_message: string | null;
}

function card(ch: Row): string {
  const subs = ch.subscribers ? ch.subscribers.toLocaleString('en-US') : '—';
  const contact = ch.contact_type === 'email'
    ? `<code>${esc(ch.owner_contact)}</code>`
    : `<a href="https://t.me/${esc(String(ch.owner_contact).replace(/^@/, ''))}">${esc(ch.owner_contact)}</a>`;

  return [
    `🎯 <b>Telegram-лид #${ch.id}</b> — ${ch.ai_score ?? '?'}/100`,
    '',
    `📣 <b>${esc(ch.channel_name || ch.channel_url)}</b>`,
    `🔗 ${esc(ch.channel_url)}`,
    `👥 ${subs}   🌍 ${esc(ch.geo || '—')}   🗣 ${esc(ch.language || '—')}   📂 ${esc(ch.niche || '—')}`,
    `✉️ Контакт: ${contact}`,
    ch.ai_reasoning ? `\n🧠 ${esc(ch.ai_reasoning)}` : '',
    '',
    '<b>Черновик (нажми, чтобы скопировать):</b>',
    // <pre> renders as a tap-to-copy block in Telegram clients.
    `<pre>${esc(ch.draft_message || '')}</pre>`,
  ].filter(Boolean).join('\n');
}

// ── Operator decision (comes from the Worker's callback_query handler) ───────
async function decide(id: number, action: string, userId?: string): Promise<string> {
  const { data: row } = await supabase.from('tg_outreach_channels')
    .select('id, status, channel_url, channel_name').eq('id', id).maybeSingle();
  if (!row) return 'лид не найден';
  if (row.status === 'contacted' || row.status === 'rejected') {
    return `уже обработан (${row.status})`;
  }

  const now = new Date().toISOString();
  if (action === 'take') {
    await supabase.from('tg_outreach_channels')
      .update({ status: 'contacted', reviewed_at: now, contacted_at: now }).eq('id', id);
    await quiet(supabase.from('tg_outreach_log')
      .insert([{ channel_id: id, action: 'taken', user_id: userId ?? null }]));
    return `✅ Взят: ${row.channel_name || row.channel_url}`;
  }

  await supabase.from('tg_outreach_channels')
    .update({ status: 'rejected', reviewed_at: now }).eq('id', id);
  await quiet(supabase.from('tg_outreach_log')
    .insert([{ channel_id: id, action: 'rejected', user_id: userId ?? null }]));
  return `✖ Отклонён: ${row.channel_name || row.channel_url}`;
}

// ── Main ────────────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const stats = { sent: 0, reason: '' };
  const json = (s: unknown, code = 200) => new Response(JSON.stringify(s),
    { status: code, headers: { ...cors, 'Content-Type': 'application/json' } });

  try {
    const body = await req.json().catch(() => ({})) as Record<string, any>;

    // Operator pressed a button on a card.
    if (body?.decide?.id) {
      const result = await decide(
        Number(body.decide.id), String(body.decide.action || 'reject'),
        body.decide.user_id ? String(body.decide.user_id) : undefined,
      );
      return json({ result });
    }

    if (!BOT_TOKEN || !CHAT_ID) return json({ ...stats, reason: 'telegram not configured' });

    const { hour, date } = gmt3();
    const force = !!body.force;
    if (QUIET && !force && (hour >= QUIET_FROM || hour < QUIET_TO)) {
      stats.reason = 'quiet hours';
      return json(stats);
    }

    // Daily cap, stored as "date|count" so the counter resets itself on a new day
    // without needing a separate cleanup job.
    const { data: st } = await supabase.from('app_state')
      .select('value').eq('key', STATE_KEY).maybeSingle();
    const [stDate, stCount] = String(st?.value || '').split('|');
    let sentToday = stDate === date ? (Number(stCount) || 0) : 0;
    if (!force && sentToday >= DAILY_CAP) {
      stats.reason = `daily cap reached (${sentToday}/${DAILY_CAP})`;
      return json(stats);
    }

    const room = Math.max(0, DAILY_CAP - sentToday);
    const { data: rows, error } = await supabase.from('tg_outreach_channels')
      .select('id, channel_url, channel_name, subscribers, geo, language, niche, '
        + 'ai_score, ai_reasoning, owner_contact, contact_type, draft_message')
      .eq('status', 'ready')
      .order('ai_score', { ascending: false, nullsFirst: false })
      .limit(Math.min(SEND_BATCH, room));
    if (error) throw new Error(error.message);
    if (!rows?.length) { stats.reason = 'no ready leads'; return json(stats); }

    for (const ch of rows as Row[]) {
      const res = await tg('sendMessage', {
        chat_id: CHAT_ID,
        text: card(ch),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Беру',      callback_data: `tgl:take:${ch.id}` },
            { text: '❌ Отклонить', callback_data: `tgl:rej:${ch.id}` },
          ]],
        },
      });
      // Only mark as delivered if Telegram actually accepted it — otherwise the
      // lead would silently vanish from the queue without ever being seen.
      if (!res?.ok) continue;

      await supabase.from('tg_outreach_channels')
        .update({ status: 'sent_to_bot' }).eq('id', ch.id);
      await quiet(supabase.from('tg_outreach_log')
        .insert([{ channel_id: ch.id, action: 'sent', metadata: { message_id: res?.result?.message_id } }]));
      stats.sent++;
      sentToday++;
      await sleep(DELAY_MS);
    }

    if (stats.sent) {
      await supabase.from('app_state').upsert({
        key: STATE_KEY, value: `${date}|${sentToday}`, updated_at: new Date().toISOString(),
      });
    }

    await quiet(supabase.from('error_log').insert([{
      level: 'info', service: 'send-tg-leads',
      message: `sent=${stats.sent} today=${sentToday}/${DAILY_CAP} ${stats.reason}`,
    }]));

    return json(stats);
  } catch (e: any) {
    return json({ ...stats, error: String(e?.message || e) }, 500);
  }
});
