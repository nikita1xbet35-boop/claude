// AffiliateOS Telegram Bot — Cloudflare Worker
// Secrets (wrangler secret put): TELEGRAM_TOKEN, MY_USER_ID, SUPABASE_URL, SUPABASE_KEY, GROQ_API_KEY, AFFILIATEOS_URL

const ALLOWED_UPDATES = ["message", "callback_query"];

export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("OK");

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    try {
      await handleUpdate(body, env);
    } catch (e) {
      console.error("handleUpdate error:", e);
    }

    return new Response("OK");
  },
};

async function handleUpdate(update, env) {
  const MY_USER_ID = Number(env.MY_USER_ID);

  // ── callback_query (кнопки inline) ───────────────────────────────────────
  if (update.callback_query) {
    const cq = update.callback_query;
    await answerCallbackQuery(cq.id, env);
    return;
  }

  const msg = update.message;
  if (!msg || !msg.text) return;

  const chatId = msg.chat.id;
  const userId = msg.from?.id;

  // Проверка доступа
  if (userId !== MY_USER_ID) {
    await sendMessage(chatId, "⛔ Нет доступа.", env);
    return;
  }

  const text = msg.text.trim();

  if (text === "/start" || text === "/help") {
    await sendHelp(chatId, env);
    return;
  }

  // Всё остальное — парсим как лид
  await processLead(chatId, text, env);
}

// ── Парсинг лида через Groq ──────────────────────────────────────────────────
async function processLead(chatId, text, env) {
  await sendMessage(chatId, "⏳ Парсю...", env);

  const prompt = `
Ты — парсер лидов для affiliate-менеджера iGaming.
Из вольного текста извлеки JSON-объект со строго этими полями:
{
  "url": string,           // ссылка или username (t.me/x, @x → "https://t.me/x"; домен → "https://домен")
  "partner_type": string,  // tipster | seo_site | arbitrage_team | aviator_predictor | casino_channel
  "brand": string,         // "1xBet" | "1xCasino" | "Lucky Pari"
  "geo": string | null,    // страна на английском (нигерия→Nigeria, индия→India) или null
  "channel_kind": string   // "telegram" | "website"
}

Правила бренда: бет/bet → "1xBet"; каз/cas/casino → "1xCasino"; lucky/пари → "Lucky Pari".
Правила типа: авиатор/aviator → "aviator_predictor"; арбитраж/arbitrage → "arbitrage_team"; сео/seo → "seo_site"; казино-канал → "casino_channel"; всё остальное (типстер, предиктор, сигналы, тг-канал) → "tipster".
Правила url: @name или t.me/name → "https://t.me/name"; если уже https:// — оставить; иначе добавить "https://".

Верни ТОЛЬКО валидный JSON, без markdown, без пояснений.

Текст: "${text.replace(/"/g, '\\"')}"
`.trim();

  let parsed;
  try {
    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
        max_tokens: 256,
      }),
    });

    const groqData = await groqRes.json();
    const raw = groqData.choices?.[0]?.message?.content?.trim();

    if (!raw) throw new Error("Groq вернул пустой ответ");

    // Вырезаем JSON из возможного markdown-блока
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error(`Groq не вернул JSON: ${raw}`);

    parsed = JSON.parse(jsonMatch[0]);
  } catch (e) {
    await sendMessage(chatId, `❌ Ошибка парсинга: ${e.message}`, env);
    return;
  }

  const { url, partner_type, brand, geo, channel_kind } = parsed;

  if (!url || !partner_type || !brand) {
    await sendMessage(chatId, "❌ Groq не смог распознать лид. Попробуй уточнить.", env);
    return;
  }

  // ── INSERT в Supabase ──────────────────────────────────────────────────────
  try {
    const sbRes = await fetch(`${env.SUPABASE_URL}/rest/v1/leads`, {
      method: "POST",
      headers: {
        "apikey": env.SUPABASE_KEY,
        "Authorization": `Bearer ${env.SUPABASE_KEY}`,
        "Content-Type": "application/json",
        "Prefer": "return=representation",
      },
      body: JSON.stringify({
        url,
        partner_type,
        brand,
        geo: geo || null,
        channel_kind,
        status: "waiting",
        name: url,
      }),
    });

    if (!sbRes.ok) {
      const err = await sbRes.text();
      throw new Error(`Supabase ${sbRes.status}: ${err}`);
    }
  } catch (e) {
    await sendMessage(chatId, `❌ Ошибка записи в БД: ${e.message}`, env);
    return;
  }

  const geoStr = geo || "—";
  await sendMessage(
    chatId,
    `✅ Добавлено в pipeline\n\n🔗 ${url}\n📂 ${partner_type}\n🎯 ${brand}\n🌍 ${geoStr}`,
    env
  );
}

// ── Справка ──────────────────────────────────────────────────────────────────
async function sendHelp(chatId, env) {
  const text = `
*AffiliateOS Bot* — быстрый захват лидов

*Формат (вольный, AI сам поймёт):*
\`@channelname тг бет\`
\`t.me/channel тг каз\`
\`eaglepredict.com сео бет нигерия\`
\`t.me/team арбитраж бет индия\`
\`@signals авиатор каз\`

*Бренды:* бет → 1xBet | каз → 1xCasino | lucky → Lucky Pari
*Гео:* пишешь по-русски, бот переведёт

Просто пришли строку — лид сразу падает в Supabase со статусом \`waiting\`.
`.trim();

  await sendMessage(chatId, text, env, { parse_mode: "Markdown" });
}

// ── Telegram API helpers ──────────────────────────────────────────────────────
async function sendMessage(chatId, text, env, extra = {}) {
  const affiliateUrl = env.AFFILIATEOS_URL;

  const reply_markup = {
    inline_keyboard: [[
      {
        text: "📊 Открыть AffiliateOS",
        web_app: { url: affiliateUrl },
      },
    ]],
  };

  await tgCall("sendMessage", {
    chat_id: chatId,
    text,
    reply_markup,
    ...extra,
  }, env);
}

async function answerCallbackQuery(id, env) {
  await tgCall("answerCallbackQuery", { callback_query_id: id }, env);
}

async function tgCall(method, payload, env) {
  const res = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }
  );
  if (!res.ok) {
    const err = await res.text();
    console.error(`TG ${method} failed:`, err);
  }
  return res;
}
