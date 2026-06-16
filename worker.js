// AffiliateOS — Cloudflare Worker
// fetch()     → serves the static dashboard via Cloudflare Assets
// scheduled() → drives the autonomous pipeline by firing Supabase Edge Functions:
//
//   every 2 min  → process-queue    (send due emails)
//                + generate-queue   (top-up queue — fast refill, 30-90s intervals)
//                + extract-contacts (contact search — runs near-continuously until all leads covered)
//   every 5 min  → find-and-queue   (search → Groq analysis → lead insert — 3x faster than before)
//   every 15 min → check-limits
//   every 30 min → daily-report
//   06:00 UTC    → daily-report (also fires via */30)
//
// Env vars (optional — sane fallbacks below): SUPABASE_URL, SUPABASE_ANON_KEY
// Secrets updated: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID

const DEFAULT_SUPABASE_URL = 'https://lxsyrserfuighwxuymgb.supabase.co';
const DEFAULT_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx4c3lyc2VyZnVpZ2h3eHV5bWdiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ5NDUwNDgsImV4cCI6MjA5MDUyMTA0OH0.6SgyPJZ_TKeKJoC_E4mIQhd373UMP8-K1VMSZJJacsM';

// ── Telegram Bot ─────────────────────────────────────────────────────────────

const TG_MY_USER_ID = env => Number(env.TG_MY_USER_ID);

async function tgCall(method, payload, env) {
  const res = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) console.error(`TG ${method} failed:`, await res.text());
  return res;
}

async function sendTg(chatId, text, env, extra = {}) {
  await tgCall('sendMessage', {
    chat_id: chatId,
    text,
    reply_markup: {
      inline_keyboard: [[{
        text: '📊 Открыть AffiliateOS',
        web_app: { url: 'https://claude.nikita1xbet35.workers.dev/' },
      }]],
    },
    ...extra,
  }, env);
}


async function parseLead(text, env) {
  const prompt = `Ты парсер лидов для affiliate-менеджера iGaming.
Из вольного текста извлеки JSON с полями:
{"url":string,"partner_type":string,"brand":string,"geo":string|null,"channel_kind":string}
partner_type: tipster|seo_site|arbitrage_team|aviator_predictor|casino_channel
brand: "1xBet"|"1xCasino"|"Lucky Pari" (бет→1xBet, каз→1xCasino, lucky/пари→Lucky Pari)
channel_kind: "telegram"|"website"
url: @name или t.me/name → "https://t.me/name"; домен → "https://домен"
Верни ТОЛЬКО валидный JSON без markdown.
Текст: "${text.replace(/"/g, '\\"')}"`;

  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'llama-3.1-8b-instant', messages: [{ role: 'user', content: prompt }], temperature: 0, max_tokens: 256 }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`Groq API ${r.status}: ${data.error?.message || JSON.stringify(data)}`);
  const raw = data.choices?.[0]?.message?.content?.trim() || '';
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Groq: ' + (raw.slice(0, 200) || '(пустой ответ)'));
  return JSON.parse(m[0]);
}

async function deleteMsg(chatId, messageId, env) {
  await tgCall('deleteMessage', { chat_id: chatId, message_id: messageId }, env);
}

async function sendTgRaw(chatId, text, env, extra = {}) {
  const res = await tgCall('sendMessage', {
    chat_id: chatId,
    text,
    reply_markup: {
      inline_keyboard: [[{
        text: '📊 Открыть AffiliateOS',
        web_app: { url: 'https://claude.nikita1xbet35.workers.dev/' },
      }]],
    },
    ...extra,
  }, env);
  const data = await res.json();
  return data.result?.message_id;
}

async function handleTgUpdate(update, env) {
  if (update.callback_query) {
    await tgCall('answerCallbackQuery', { callback_query_id: update.callback_query.id }, env);
    return;
  }
  const msg = update.message;
  if (!msg?.text) return;

  const chatId = msg.chat.id;
  const userMsgId = msg.message_id;

  if (msg.from?.id !== TG_MY_USER_ID(env)) {
    await sendTg(chatId, '⛔ Нет доступа.', env);
    return;
  }

  const text = msg.text.trim();
  if (text === '/start' || text === '/help') {
    await sendTg(chatId, `*AffiliateOS Bot* — быстрый захват лидов\n\nПросто кинь строку:\n\`@channelname тг бет\`\n\`t.me/ch тг каз\`\n\`site.com сео бет нигерия\`\n\`t.me/team арбитраж бет индия\`\n\`@signals авиатор каз\`\n\nЛид сразу падает в Supabase со статусом \`waiting\`.`, env, { parse_mode: 'Markdown' });
    return;
  }

  // Отправляем "Парсю...", запоминаем id
  const loadingMsgId = await sendTgRaw(chatId, '⏳ Парсю...', env);

  let parsed;
  try {
    parsed = await parseLead(text, env);
  } catch (e) {
    await deleteMsg(chatId, loadingMsgId, env);
    await deleteMsg(chatId, userMsgId, env);
    await sendTg(chatId, `❌ Ошибка парсинга: ${e.message}`, env);
    return;
  }

  const { url, partner_type, brand, geo, channel_kind } = parsed;
  if (!url || !partner_type || !brand) {
    await deleteMsg(chatId, loadingMsgId, env);
    await deleteMsg(chatId, userMsgId, env);
    await sendTg(chatId, '❌ Не удалось распознать. Уточни запрос.', env);
    return;
  }

  const SUPABASE_URL = env.SUPABASE_URL || DEFAULT_SUPABASE_URL;
  const SUPABASE_KEY = env.SUPABASE_SERVICE_KEY;

  const sb = await fetch(`${SUPABASE_URL}/rest/v1/leads`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify({ url, type: partner_type, brand, geo: geo || null, channel_kind, status: 'waiting', name: url }),
  });

  // Удаляем "Парсю..." и сообщение пользователя
  await deleteMsg(chatId, loadingMsgId, env);
  await deleteMsg(chatId, userMsgId, env);

  if (!sb.ok) {
    await sendTg(chatId, `❌ Ошибка БД: ${sb.status} ${await sb.text()}`, env);
    return;
  }

  await sendTg(chatId, `✅ Добавлено в pipeline\n\n🔗 ${url}\n📂 ${partner_type}\n🎯 ${brand}\n🌍 ${geo || '—'}`, env);
}

// ── Main export ───────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Telegram webhook endpoint
    if (request.method === 'POST' && url.pathname === '/tg-webhook') {
      try {
        const update = await request.json();
        ctx.waitUntil(handleTgUpdate(update, env));
      } catch (e) {
        console.error('tg-webhook error:', e);
      }
      return new Response('OK');
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    const SUPABASE_URL  = env.SUPABASE_URL || DEFAULT_SUPABASE_URL;
    const SUPABASE_KEY  = env.SUPABASE_ANON_KEY || DEFAULT_ANON_KEY;
    const FUNCTIONS_URL = SUPABASE_URL + '/functions/v1';

    const headers = {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
    };

    // Fire an edge function, log failures (don't throw — one failure must not
    // block the rest of the pipeline).
    const call = async (name, body) => {
      try {
        const res = await fetch(FUNCTIONS_URL + '/' + name, {
          method: 'POST',
          headers,
          body: JSON.stringify(body || {}),
        });
        if (!res.ok) {
          console.error(name + ' failed:', res.status, await res.text());
        }
      } catch (e) {
        console.error(name + ' error:', e && e.message);
      }
    };

    const cron = event.cron;

    if (cron === '*/2 * * * *') {
      // Fast tick — send emails + top-up queue + extract contacts near-continuously.
      // PARALLEL: sequential awaits starved extract-contacts whenever process-queue
      // ran long (it produced zero run logs for weeks until this was caught).
      await Promise.all([
        call('process-queue', {}),
        call('generate-queue', {}),
        call('extract-contacts', {}),
      ]);
      return;
    }

    if (cron === '*/3 * * * *') {
      await call('find-and-queue', {});
      return;
    }

    if (cron === '*/15 * * * *') {
      await call('check-limits', { cron });
      return;
    }

    if (cron === '0 7 * * *') {
      // 10:00 MSK — one morning report per day
      await call('daily-report', {});
      return;
    }

    if (cron === '*/7 * * * *') {
      // LuckyPari outreach — separate brand, own quota. Fires ~9x/hour and sends
      // one email per tick, spreading 100/day evenly across working hours (no bursts).
      await call('process-queue-lp', {});
      return;
    }
  },
};
