// Supabase Edge Function: watchdog-agent (Block 3)
// A Claude-based system watchdog with three autonomy levels:
//   L1 Observer  — detects anomalies deterministically, writes a Claude-authored
//                  diagnosis, and alerts Telegram. Read-only.
//   L3 Autopilot — for a small, explicit whitelist of SAFE operational actions
//                  (retry stuck sends, reschedule stale queue items) it acts on
//                  its own and reports "I did X" to Telegram + agent_log.
//   L2 Advisor   — for changes that need judgment (e.g. raising a send limit) it
//                  proposes the fix with Telegram Yes/No buttons and does NOTHING
//                  until the operator approves (button or /approve <id> command).
//
// HARD LIMITS (never crossed): the agent cannot deploy code, change the DB schema,
// mass-delete data, edit templates, or alter send logic. L3 is confined to the
// AUTO_ACTIONS whitelist; L2 execution is confined to the APPROVAL_ACTIONS
// whitelist. Anything outside both is escalated to a human (L1 alert only).
//
// Diagnosis text uses the Claude API (Haiku) when ANTHROPIC_API_KEY is set; it
// falls back to a deterministic template otherwise — the function never depends
// on the model to decide what to DO, only to phrase the WHY.
//
// Deploy: supabase functions deploy watchdog-agent --no-verify-jwt
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto), ALERTS_BOT_TOKEN,
//      ALERTS_CHAT_ID, ANTHROPIC_API_KEY (optional)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const BOT_TOKEN    = Deno.env.get('ALERTS_BOT_TOKEN') || '';
const CHAT_ID      = Deno.env.get('ALERTS_CHAT_ID') || '';
const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY') || '';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Thresholds ──────────────────────────────────────────────────────────────
const BOUNCE_WARN_PCT   = 12;   // bounce rate that triggers an alert
const REPEAT_ERR_COUNT  = 5;    // same error N times in 1h = a stuck function
const STALL_HOURS       = 3;    // 0 sends in this many work hours = stalled
const NO_LEADS_HOURS    = 3;    // 0 new leads in this many hours = search stalled
const GMAIL_LIMIT_STEP  = 50;   // how much an approved raise adds
const GMAIL_LIMIT_CAP   = 500;  // never propose above this

function nowGmt3() {
  const g = new Date(Date.now() + 3 * 60 * 60 * 1000);
  return { hour: g.getUTCHours(), dateStr: g.toISOString().slice(0, 10) };
}
const isWorkHours = () => { const h = nowGmt3().hour; return h >= 8 && h < 20; };

// ── Telegram ────────────────────────────────────────────────────────────────
async function tg(method: string, payload: Record<string, unknown>): Promise<any> {
  if (!BOT_TOKEN || !CHAT_ID) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return await res.json().catch(() => null);
  } catch { return null; }
}
async function tgSend(html: string, buttons?: any): Promise<number | null> {
  const r = await tg('sendMessage', {
    chat_id: CHAT_ID, text: html, parse_mode: 'HTML',
    ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
  });
  return r?.result?.message_id ?? null;
}

// ── Claude diagnosis (optional; deterministic fallback) ─────────────────────
async function diagnose(kind: string, facts: string): Promise<string> {
  const fallback: Record<string, string> = {
    sending_stalled: 'Отправка встала в рабочее время. Вероятно, очередь забита failed/дублями или process-queue не находит валидных адресов.',
    no_new_leads:    'Поиск не приносит новых лидов. Вероятно, find-and-queue упирается в Groq 429 или выдача по ключам исчерпана.',
    high_bounce:     'Вырос bounce rate. Вероятно, в очередь попали битые/устаревшие адреса — стоит проверить источник.',
    repeating_error: 'Функция стабильно падает с одной и той же ошибкой — нужен разбор конкретного стектрейса.',
    gmail_near_limit:'Gmail близок к дневному лимиту при большом бэклоге — часть писем не уйдёт сегодня.',
  };
  if (!ANTHROPIC_KEY) return fallback[kind] || facts;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 220,
        system: 'Ты SRE-агент, следящий за автономной email/форм-рассылкой AffiliateOS '
          + '(Supabase Edge Functions + Cloudflare Worker). По сухим фактам напиши КОРОТКИЙ '
          + 'диагноз на русском (2-3 предложения): что сломалось, вероятная причина, что проверить. '
          + 'Без воды, без markdown-заголовков.',
        messages: [{ role: 'user', content: `Аномалия: ${kind}\nФакты:\n${facts}` }],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return fallback[kind] || facts;
    const d = await res.json();
    return (d?.content?.[0]?.text || '').trim() || fallback[kind] || facts;
  } catch { return fallback[kind] || facts; }
}

// Skip re-alerting/re-acting on the same kind within a cooldown window.
async function recentlyHandled(kind: string, hours: number): Promise<boolean> {
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const { data } = await supabase.from('agent_log').select('id')
    .eq('kind', kind).gte('created_at', since)
    .in('status', ['alerted', 'auto_done', 'pending_approval', 'approved']).limit(1);
  return !!(data && data.length);
}
async function logAgent(row: Record<string, unknown>): Promise<number | null> {
  const { data } = await supabase.from('agent_log').insert([row]).select('id').single();
  return (data as any)?.id ?? null;
}

// ── L1 alert ────────────────────────────────────────────────────────────────
async function alertL1(kind: string, summary: string, facts: string) {
  if (await recentlyHandled(kind, STALL_HOURS)) return;
  const diagnosis = await diagnose(kind, facts);
  const mid = await tgSend(`🔴 <b>Watchdog</b> — ${kind}\n\n${summary}\n\n🧠 ${diagnosis}`);
  await logAgent({ level: 1, kind, summary, diagnosis, status: 'alerted', tg_message_id: mid });
}

// ── L3 autopilot whitelist (SAFE ops only; no code/schema/template/logic) ────
const AUTO_ACTIONS: Record<string, () => Promise<string>> = {
  // Reset failed send_queue rows back to pending so a transient failure doesn't
  // strand them. Bounded batch; only touches status/retry_count/error.
  requeue_failed: async () => {
    const { data } = await supabase.from('send_queue')
      .select('id').eq('status', 'failed').limit(100);
    const ids = (data || []).map((r: any) => r.id);
    if (!ids.length) return 'нет failed-записей';
    await supabase.from('send_queue')
      .update({ status: 'pending', retry_count: 0, error: null }).in('id', ids);
    return `сброшено ${ids.length} failed → pending`;
  },
  // Reschedule long-overdue pending items to fire now (backstop for generate-queue).
  unstick_pending: async () => {
    const twoHAgo = new Date(Date.now() - 2 * 3600_000).toISOString();
    const { data } = await supabase.from('send_queue')
      .select('id').eq('status', 'pending').lt('scheduled_at', twoHAgo).limit(100);
    const ids = (data || []).map((r: any) => r.id);
    if (!ids.length) return 'нет зависших pending';
    await supabase.from('send_queue')
      .update({ scheduled_at: new Date().toISOString() }).in('id', ids);
    return `перепланировано ${ids.length} зависших pending`;
  },
};

async function autopilot(kind: string, action: keyof typeof AUTO_ACTIONS, summary: string) {
  if (await recentlyHandled(kind, 1)) return;
  let result = '', status = 'auto_done';
  try { result = await AUTO_ACTIONS[action](); }
  catch (e: any) { result = e.message; status = 'failed'; }
  const mid = await tgSend(`🤖 <b>Watchdog — авто-действие</b>\n\n${summary}\n\n✅ Сделал сам: <b>${action}</b> — ${result}`);
  await logAgent({ level: 3, kind, summary, action, status, result, tg_message_id: mid });
}

// ── L2 approval whitelist (executed ONLY after operator "Да") ────────────────
const APPROVAL_ACTIONS: Record<string, () => Promise<string>> = {
  raise_gmail_limit: async () => {
    const { data } = await supabase.from('api_usage')
      .select('limit_value').eq('service', 'gmail_main').single();
    const cur = (data?.limit_value as number) ?? 300;
    const next = Math.min(cur + GMAIL_LIMIT_STEP, GMAIL_LIMIT_CAP);
    if (next <= cur) return `лимit уже на максимуме (${cur})`;
    await supabase.from('api_usage')
      .update({ limit_value: next, updated_at: new Date().toISOString() })
      .eq('service', 'gmail_main');
    return `лимit gmail_main поднят ${cur} → ${next}/день`;
  },
};

async function proposeL2(kind: string, action: keyof typeof APPROVAL_ACTIONS, summary: string, facts: string) {
  if (await recentlyHandled(kind, 6)) return;
  const diagnosis = await diagnose(kind, facts);
  const id = await logAgent({ level: 2, kind, summary, diagnosis, action, status: 'pending_approval' });
  if (!id) return;
  const buttons = [[
    { text: '✅ Да', callback_data: `wd:approve:${id}` },
    { text: '✖ Нет', callback_data: `wd:reject:${id}` },
  ]];
  const mid = await tgSend(
    `🟡 <b>Watchdog — нужен фикс</b>\n\n${summary}\n\n🧠 ${diagnosis}\n\n`
    + `Предлагаю: <b>${action}</b>.\nПрименить? Нажми кнопку или ответь <code>/approve ${id}</code> / <code>/reject ${id}</code>`,
    buttons,
  );
  if (mid) await supabase.from('agent_log').update({ tg_message_id: mid }).eq('id', id);
}

// ── Apply an operator decision on an L2 proposal ────────────────────────────
async function applyDecision(id: number, decision: string): Promise<string> {
  const { data: row } = await supabase.from('agent_log').select('*').eq('id', id).single();
  if (!row) return 'proposal not found';
  if (row.status !== 'pending_approval') return `уже обработано (${row.status})`;

  if (decision !== 'approve') {
    await supabase.from('agent_log').update({ status: 'rejected' }).eq('id', id);
    await tgSend(`✖ Отклонено: <b>${row.action}</b> (#${id})`);
    return 'rejected';
  }
  const fn = APPROVAL_ACTIONS[row.action as string];
  if (!fn) {
    await supabase.from('agent_log').update({ status: 'failed', result: 'unknown action' }).eq('id', id);
    return 'unknown action';
  }
  let result = '', status = 'approved';
  try { result = await fn(); }
  catch (e: any) { result = e.message; status = 'failed'; }
  await supabase.from('agent_log').update({ status, result }).eq('id', id);
  await tgSend(`${status === 'approved' ? '✅' : '⚠️'} <b>${row.action}</b> (#${id}) — ${result}`);
  return result;
}

// ── Detection cycle ─────────────────────────────────────────────────────────
async function runCycle() {
  const acted: string[] = [];
  const dayStart = new Date(`${nowGmt3().dateStr}T00:00:00+03:00`).toISOString();

  // 1. Sending stalled (work hours, no sends in STALL_HOURS but work is available)
  if (isWorkHours()) {
    const stallSince = new Date(Date.now() - STALL_HOURS * 3600_000).toISOString();
    const { count: sentRecently } = await supabase.from('email_log')
      .select('id', { count: 'exact', head: true }).gte('sent_at', stallSince);
    if ((sentRecently ?? 0) === 0) {
      const { count: pendingDue } = await supabase.from('send_queue')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending').lte('scheduled_at', new Date().toISOString());
      const { count: failedCnt } = await supabase.from('send_queue')
        .select('id', { count: 'exact', head: true }).eq('status', 'failed');
      if ((failedCnt ?? 0) > 0) {
        // Safe auto-fix: stuck failed items are the likely cause → requeue them.
        await autopilot('sending_stalled', 'requeue_failed',
          `0 отправок за ${STALL_HOURS}ч, ${failedCnt} failed в очереди.`);
        acted.push('sending_stalled→requeue_failed');
      } else if ((pendingDue ?? 0) > 0) {
        await autopilot('pending_overdue', 'unstick_pending',
          `0 отправок за ${STALL_HOURS}ч, ${pendingDue} pending просрочены.`);
        acted.push('pending_overdue→unstick_pending');
      } else {
        await alertL1('sending_stalled', `0 отправок за ${STALL_HOURS}ч в рабочее время.`,
          `sent_${STALL_HOURS}h=0 pending_due=${pendingDue ?? 0} failed=${failedCnt ?? 0}`);
        acted.push('sending_stalled→alert');
      }
    }
  }

  // 2. No new leads (search stalled)
  {
    const since = new Date(Date.now() - NO_LEADS_HOURS * 3600_000).toISOString();
    const { count: newLeads } = await supabase.from('leads')
      .select('id', { count: 'exact', head: true }).gte('created_at', since);
    if ((newLeads ?? 0) === 0) {
      await alertL1('no_new_leads', `0 новых лидов за ${NO_LEADS_HOURS}ч.`,
        `new_leads_${NO_LEADS_HOURS}h=0`);
      acted.push('no_new_leads→alert');
    }
  }

  // 3. Bounce rate today
  {
    const { data: todayEmails } = await supabase.from('email_log')
      .select('bounced').gte('sent_at', dayStart);
    const sent = (todayEmails || []).length;
    const bounced = (todayEmails || []).filter((e: any) => e.bounced).length;
    const pct = sent > 0 ? (bounced / sent) * 100 : 0;
    if (sent >= 20 && pct >= BOUNCE_WARN_PCT) {
      await alertL1('high_bounce', `Bounce rate ${pct.toFixed(1)}% (${bounced}/${sent}) сегодня.`,
        `sent=${sent} bounced=${bounced} pct=${pct.toFixed(1)}`);
      acted.push('high_bounce→alert');
    }
  }

  // 4. Repeating error in error_log (a function stuck in a crash loop)
  {
    const since = new Date(Date.now() - 3600_000).toISOString();
    const { data: errs } = await supabase.from('error_log')
      .select('service, message').neq('level', 'info').gte('created_at', since);
    const counts: Record<string, number> = {};
    for (const e of (errs || [])) {
      const key = `${(e as any).service}: ${((e as any).message || '').slice(0, 80)}`;
      counts[key] = (counts[key] || 0) + 1;
    }
    const worst = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    if (worst && worst[1] >= REPEAT_ERR_COUNT) {
      await alertL1('repeating_error', `Повтор ошибки ×${worst[1]} за час: ${worst[0]}`,
        `count=${worst[1]} error="${worst[0]}"`);
      acted.push('repeating_error→alert');
    }
  }

  // 5. Gmail near daily limit with a large backlog → L2 proposal (raise limit)
  if (isWorkHours()) {
    const { data: gm } = await supabase.from('api_usage')
      .select('used, limit_value').eq('service', 'gmail_main').single();
    const used = (gm?.used as number) ?? 0;
    const lim  = (gm?.limit_value as number) ?? 300;
    if (lim > 0 && used >= lim * 0.9 && lim < GMAIL_LIMIT_CAP) {
      const { count: backlog } = await supabase.from('send_queue')
        .select('id', { count: 'exact', head: true }).eq('status', 'pending');
      if ((backlog ?? 0) > 50) {
        await proposeL2('gmail_near_limit', 'raise_gmail_limit',
          `Gmail ${used}/${lim} (≥90%), в очереди ещё ${backlog} писем.`,
          `used=${used} limit=${lim} backlog=${backlog}`);
        acted.push('gmail_near_limit→propose');
      }
    }
  }

  return acted;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    let body: any = {};
    try { body = await req.json(); } catch { /* cron call: no body */ }

    // Operator decision on an L2 proposal (called by the Telegram bot).
    if (body?.apply?.id) {
      const result = await applyDecision(Number(body.apply.id), String(body.apply.decision || 'reject'));
      return new Response(JSON.stringify({ ok: true, result }),
        { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    const acted = await runCycle();
    return new Response(JSON.stringify({ ok: true, acted }),
      { headers: { ...cors, 'Content-Type': 'application/json' } });
  } catch (e: any) {
    await supabase.from('error_log').insert([{ level: 'critical', service: 'watchdog-agent', message: e.message }]);
    return new Response(JSON.stringify({ ok: false, error: e.message }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
});
