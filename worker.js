// AffiliateOS — Cloudflare Worker
// fetch()     → serves the static dashboard via Cloudflare Assets
// scheduled() → drives the autonomous pipeline by firing Supabase Edge Functions:
//
//   every 2 min  → process-queue    (send due emails)
//                + generate-queue   (top-up queue — fast refill, 30-90s intervals)
//                + extract-contacts (contact search — runs near-continuously until all leads covered)
//   every 5 min  → find-and-queue   (search → Groq analysis → lead insert — 3x faster than before)
//   every 15 min → check-limits
//                + the Telegram outreach agent (scan/extract/draft/send-tg-*)
//   every 30 min → daily-report
//   06:00 UTC    → daily-report (also fires via */30)
//
// Env vars (optional — sane fallbacks below): SUPABASE_URL, SUPABASE_ANON_KEY
// Secrets updated: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID
//
// Dashboard password gate (optional):
//   DASHBOARD_PASSWORD — set this secret to require a password before the
//     dashboard loads. While UNSET the gate is disabled (dashboard stays open),
//     so deploying this code never locks you out before you configure it.
//   SESSION_SECRET     — optional HMAC key for signing session cookies; falls
//     back to DASHBOARD_PASSWORD when absent.

// Отметка сборки. Поднимается в каждом коммите, который надо уметь опознать на
// живом сайте.
//
// Появилась после часа блужданий вокруг вопроса, на который нечем было
// ответить: «то, что я вижу на экране, — это уже новый код или ещё старый?».
// Отличить непришедшую сборку от ненастроенного секрета было нельзя, и обе
// гипотезы выглядели одинаково правдоподобно. Отдаётся в /__role, а страница
// печатает её в окне смены роли — если цифра не та, дальше можно не гадать.
const BUILD = '2026-08-21.7';

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

// Call the watchdog-agent's apply endpoint to execute an operator decision on
// an L2 proposal. Kept minimal — the safe-action whitelist lives in the function.
async function watchdogApply(id, decision, env) {
  const SUPABASE_URL = env.SUPABASE_URL || DEFAULT_SUPABASE_URL;
  const KEY = env.SUPABASE_ANON_KEY || DEFAULT_ANON_KEY;
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/watchdog-agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': KEY, 'Authorization': 'Bearer ' + KEY },
      body: JSON.stringify({ apply: { id, decision } }),
    });
    const d = await res.json().catch(() => ({}));
    return d?.result || (res.ok ? 'ok' : 'error');
  } catch (e) { return e && e.message; }
}

async function handleTgUpdate(update, env) {
  if (update.callback_query) {
    const cq = update.callback_query;
    const data = cq.data || '';
    // Watchdog L2 approval buttons: "wd:approve:<id>" / "wd:reject:<id>"
    const m = data.match(/^wd:(approve|reject):(\d+)$/);
    if (m && cq.from?.id === TG_MY_USER_ID(env)) {
      const result = await watchdogApply(Number(m[2]), m[1], env);
      await tgCall('answerCallbackQuery', {
        callback_query_id: cq.id,
        text: (m[1] === 'approve' ? '✅ ' : '✖ ') + String(result).slice(0, 190),
      }, env);
      return;
    }
    // Telegram lead cards used to carry take/reject buttons here. They are now
    // decided in the Telegram tab of the dashboard, which owns the whole base —
    // old cards still in the chat may fire "tgl:…", so acknowledge and drop it.
    await tgCall('answerCallbackQuery', { callback_query_id: cq.id }, env);
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

  // Watchdog L2 approval via command (fallback to inline buttons):
  //   /approve <id>  /reject <id>
  const wd = text.match(/^\/(approve|reject)\s+(\d+)$/i);
  if (wd) {
    const decision = wd[1].toLowerCase() === 'approve' ? 'approve' : 'reject';
    const result = await watchdogApply(Number(wd[2]), decision, env);
    await sendTg(chatId, `${decision === 'approve' ? '✅' : '✖'} Watchdog #${wd[2]}: ${result}`, env);
    return;
  }

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

// ── Dashboard password gate ─────────────────────────────────────────────────
// Login page + signed session cookie with a 3h sliding window: every authed
// request refreshes the cookie, so 3h of inactivity (or a new device/browser
// with no cookie) forces a fresh password entry.

const SESSION_TTL_MS = 3 * 60 * 60 * 1000; // 3 hours of inactivity
const COOKIE_NAME = 'aos_session';

// Supabase credentials for rate-limiting login_attempts table
const SUPABASE_URL_W = 'https://lxsyrserfuighwxuymgb.supabase.co';
const SUPABASE_ANON  = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx4c3lyc2VyZnVpZ2h3eHV5bWdiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ5NDUwNDgsImV4cCI6MjA5MDUyMTA0OH0.6SgyPJZ_TKeKJoC_E4mIQhd373UMP8-K1VMSZJJacsM';

// Ключ, которым подписывается сессионная кука.
//
// Знала только про SESSION_SECRET и DASHBOARD_PASSWORD — та же слепота, что и
// у gate(), и с теми же последствиями. Когда оба удалены, а вход настроен на
// AUTH_FULL_HASH / AUTH_STANDARD_HASH, функция возвращала ПУСТУЮ СТРОКУ, и
// куки подписывались пустым ключом. Подпись на пустом ключе воспроизводит кто
// угодно: достаточно собрать payload с role:'full', и /db выдаст по нему
// полноправный JWT к базе. Пароль на входе при этом выглядит рабочим.
//
// Поэтому список источников тот же, что у gateEnabled, и в том же порядке
// приоритета: отдельный SESSION_SECRET, иначе любой из настроенных паролей.
function authSecret(env) {
  return env.SESSION_SECRET || env.DASHBOARD_PASSWORD || env.DASHBOARD_PASSWORD_HASH ||
         env.AUTH_FULL_HASH || env.AUTH_STANDARD_HASH || '';
}

// constant-time string compare (avoids password/signature timing leaks)
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hashPassword(password, salt) {
  const enc = new TextEncoder();
  const keyData = enc.encode(password + salt);
  const hashBuf = await crypto.subtle.digest('SHA-256', keyData);
  const hashArr = Array.from(new Uint8Array(hashBuf));
  return hashArr.map(b => b.toString(16).padStart(2, '0')).join('');
}

// Returns the ROLE the password grants, or null when nothing matched.
// Block 4: two passwords, two access levels. AUTH_FULL_HASH is checked first
// so that if someone ever configures the same value in both, the stronger role
// wins rather than depending on evaluation order.
//
// Unset AUTH_* secrets fall back to the existing single-password behaviour and
// grant 'standard' — a deploy must not lock the dashboard out, and 'standard'
// is the safe default (it is the role that sees LESS).
async function verifyPassword(input, env) {
  // Пробелы по краям срезаются и у введённого, и у хранимого. Причина не
  // косметическая: секрет попадает в Cloudflare копипастой, и прилипший
  // пробел или перевод строки делает safeEqual ложным — длина не совпадает.
  // Снаружи это выглядит как «пароль не подходит», то есть неотличимо от
  // опечатки, и искать причину можно долго. Проверено: "1111 " против
  // введённого "1111" давало ровно тот же 401, что и вовсе не заданный
  // секрет. Пароль, у которого пробел по краям значим, — цена, которую
  // здесь не жалко заплатить.
  const given = String(input == null ? '' : input).trim();
  const matches = async (storedRaw) => {
    const stored = String(storedRaw == null ? '' : storedRaw).trim();
    if (!stored) return false;
    if (stored.includes(':')) {
      const [salt, hash] = stored.split(':');
      return safeEqual(await hashPassword(given, salt || ''), hash);
    }
    return safeEqual(given, stored);
  };

  if (await matches(env.AUTH_FULL_HASH)) return 'full';
  if (await matches(env.AUTH_STANDARD_HASH)) return 'standard';

  const storedHash = env.DASHBOARD_PASSWORD_HASH; // "salt:hash" format
  const plainPw    = env.DASHBOARD_PASSWORD;       // legacy plain fallback
  if (!storedHash && !plainPw) return null;
  if (await matches(storedHash) || await matches(plainPw)) return 'standard';
  return null;
}

// ── Порог и окно защиты от перебора ─────────────────────────────────────────
// Было: 2 промаха → час блокировки. Для четырёхзначного PIN'а, который вводит
// один человек, это ловушка, а не защита — одна опечатка мимо цифры запирала
// на час, что уже случилось на ровном месте.
//
// Кнопка смены роли (⇄ в углу дашборда) делает такое куда вероятнее: она бьёт
// в этот же /__auth и жмётся по несколько раз в день. Оставить порог как есть
// значило бы выкатить фичу, которая регулярно запирает владельца снаружи.
//
// 5 попыток на 15 минут — это 20 в час, то есть перебор 10 000 комбинаций
// занял бы 500 часов. Для приватного дашборда за паролем этого достаточно, а
// цена опечатки падает с часа до четверти часа, причём наступает она только
// на пятой подряд.
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

async function getFailedAttempts(ip) {
  const url = `${SUPABASE_URL_W}/rest/v1/login_attempts?ip=eq.${encodeURIComponent(ip)}&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&select=id`;
  const res = await fetch(url, {
    headers: { 'apikey': SUPABASE_ANON, 'Authorization': `Bearer ${SUPABASE_ANON}` }
  }).catch(() => null);
  if (!res?.ok) return 0;
  const data = await res.json().catch(() => []);
  return Array.isArray(data) ? data.length : 0;
}

async function recordFailedAttempt(ip) {
  await fetch(`${SUPABASE_URL_W}/rest/v1/login_attempts`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_ANON,
      'Authorization': `Bearer ${SUPABASE_ANON}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify({ ip, failed_at: new Date().toISOString(), expires_at: new Date(Date.now() + LOGIN_WINDOW_MS).toISOString() }),
  }).catch(() => null);
}

function b64urlEncode(bytes) {
  const arr = new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return b64urlEncode(sig);
}

// ── Supabase-совместимый JWT (Блок 4) ───────────────────────────────────────
// Ключевое свойство: этот токен НИКОГДА не покидает воркер. Браузер шлёт свои
// запросы на /db, воркер сверяет подписанную сессионную куку, сам подписывает
// JWT нужной роли и подставляет его в Authorization уже по дороге в Supabase.
//
// Отдай мы токен фронту — клиент смог бы его прочитать, сохранить и переиспользовать
// напрямую против supabase.co, и вся серверная проверка роли превратилась бы в
// формальность. Здесь подделать brand_role нельзя: значение берётся из куки,
// подписанной SESSION_SECRET, а сам JWT подписан секретом Supabase, которого у
// браузера нет.
//
// TTL короткий (5 минут): токен и живёт-то только на время одного проксируемого
// запроса, а не хранится.
const SB_JWT_TTL_SEC = 300;

async function mintSupabaseJwt(env, brandRole) {
  const secret = env.SUPABASE_JWT_SECRET;
  if (!secret) return null;   // не настроен — вызывающий откатится на anon-ключ
  const now = Math.floor(Date.now() / 1000);
  const header  = b64urlEncode(new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payload = b64urlEncode(new TextEncoder().encode(JSON.stringify({
    iss: 'supabase',
    // role — это РОЛЬ БАЗЫ, под которой PostgREST выполнит запрос. Именно к ней
    // применяются RLS-политики. brand_role — наш собственный claim, его читают
    // сами политики через auth.jwt().
    role: 'authenticated',
    aud: 'authenticated',
    brand_role: brandRole === 'full' ? 'full' : 'standard',
    iat: now,
    exp: now + SB_JWT_TTL_SEC,
  })));
  const data = `${header}.${payload}`;
  return `${data}.${await hmac(secret, data)}`;
}

async function makeSession(env, role) {
  const payload = b64urlEncode(new TextEncoder().encode(JSON.stringify({
    exp: Date.now() + SESSION_TTL_MS,
    role: role === 'full' ? 'full' : 'standard',
  })));
  return `${payload}.${await hmac(authSecret(env), payload)}`;
}

// Returns the decoded session payload when the signature and expiry check out,
// otherwise null. Callers that only need a yes/no use verifySession below; the
// /db proxy needs the role, which is why this exists separately.
async function readSession(token, env) {
  if (!token) return null;
  // Совсем без ключа сессию не проверяем, а отвергаем. Иначе HMAC считался бы
  // на пустом ключе — то есть проверялся бы тем, что любой может повторить, и
  // «подписанная кука» перестала бы что-либо значить. Отказ здесь означает
  // всего лишь показ формы входа; пропуск означал бы выдачу доступа к базе по
  // самодельной куке.
  if (!authSecret(env)) return null;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  if (!safeEqual(token.slice(dot + 1), await hmac(authSecret(env), payload))) return null;
  try {
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
    if (typeof claims.exp !== 'number' || Date.now() >= claims.exp) return null;
    // Sessions minted before roles existed have no role — treat as standard,
    // never as full: an old cookie must not silently confer more access.
    return { exp: claims.exp, role: claims.role === 'full' ? 'full' : 'standard' };
  } catch {
    return null;
  }
}

async function verifySession(token, env) {
  return (await readSession(token, env)) !== null;
}

function getCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

const sessionCookie = token =>
  `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`;
const clearCookie = () =>
  `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;

function loginPage(error, blocked) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="robots" content="noindex, nofollow">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>AffiliateOS</title>
<style>
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0f1115;color:#e7e9ee}
  .card{width:280px;text-align:center}
  .logo{font-size:38px;margin-bottom:8px}
  h1{font-size:17px;font-weight:600;margin:0 0 4px}
  p{margin:0 0 28px;color:#8b93a3;font-size:13px}
  .pins{display:flex;gap:14px;justify-content:center;margin-bottom:6px}
  .pin{width:54px;height:62px;border-radius:14px;border:2px solid #2c323d;background:#171a21;
    color:#e7e9ee;font-size:26px;font-weight:700;text-align:center;outline:none;
    caret-color:transparent;transition:border-color .15s}
  .pin:focus{border-color:#4c8bf5;background:#1b2030}
  .pin.filled{border-color:#3a4050}
  .pin.shake{animation:shake .3s}
  @keyframes shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-5px)}75%{transform:translateX(5px)}}
  .err{color:#ff6b6b;font-size:13px;height:18px;margin-top:8px;opacity:0;transition:opacity .2s}
  .err.show{opacity:1}
</style></head><body>
<div class="card">
  <div class="logo">🔐</div>
  <h1>AffiliateOS</h1>
  <p>Введите PIN-код</p>
  <form id="f" method="POST" action="/__auth">
    <input type="hidden" name="password" id="pw">
    <div class="pins">
      <input class="pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="1" id="p0">
      <input class="pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="1" id="p1">
      <input class="pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="1" id="p2">
      <input class="pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="1" id="p3">
    </div>
    <div class="err${(error || blocked) ? ' show' : ''}" id="err">${blocked ? `Слишком много попыток. Подождите ${LOGIN_WINDOW_MS / 60000} мин.` : 'Неверный PIN'}</div>
  </form>
</div>
<script>
  const pins = [0,1,2,3].map(i=>document.getElementById('p'+i));
  pins[0].focus();
  pins.forEach((el,i)=>{
    el.addEventListener('input',e=>{
      const v = e.target.value.replace(/\D/g,'');
      el.value = v ? v[0] : '';
      el.classList.toggle('filled', !!el.value);
      if(el.value && i < 3) pins[i+1].focus();
      if(pins.every(p=>p.value)) submit();
    });
    el.addEventListener('keydown',e=>{
      if(e.key==='Backspace' && !el.value && i>0){
        pins[i-1].value=''; pins[i-1].classList.remove('filled'); pins[i-1].focus();
      }
    });
    el.addEventListener('paste',e=>{
      e.preventDefault();
      const d=(e.clipboardData||window.clipboardData).getData('text').replace(/\D/g,'');
      pins.forEach((p,j)=>{ p.value=d[j]||''; p.classList.toggle('filled',!!p.value); });
      const next=pins.findIndex(p=>!p.value);
      (next>-1?pins[next]:pins[3]).focus();
      if(pins.every(p=>p.value)) submit();
    });
  });
  function submit(){
    document.getElementById('pw').value=pins.map(p=>p.value).join('');
    document.getElementById('f').submit();
  }
</script>
</body></html>`;
}

// CORS for the /db proxy. Same-origin in normal use, so this is mostly a
// formality — but supabase-js sends apikey/authorization/prefer as custom
// headers, and a browser will not replay those without an explicit allow list.
const proxyCors = request => ({
  'Access-Control-Allow-Origin': request.headers.get('Origin') || '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS, HEAD',
  'Access-Control-Allow-Headers':
    'authorization, apikey, content-type, prefer, range, x-client-info, accept-profile, content-profile',
  'Access-Control-Max-Age': '86400',
});

const htmlResponse = (body, status) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });

// Включён ли пароль на дашборд.
//
// Раньше это условие было записано прямо в gate() и смотрело ТОЛЬКО на
// DASHBOARD_PASSWORD. Пока он был единственным паролем, разницы не было; с
// появлением AUTH_FULL_HASH / AUTH_STANDARD_HASH она стала опасной. Удаление
// старого пароля — совершенно естественный шаг после перехода на два PIN'а —
// возвращало из gate() null на КАЖДЫЙ запрос, и это значит сразу три вещи:
//
//   1. дашборд открывался вообще без пароля, хотя два PIN'а настроены;
//   2. /__auth переставал обрабатываться и уходил в Assets — там его нет,
//      отсюда «Ошибка 404» при смене роли;
//   3. /__role при выключённом гейте отдаёт 'full' всем подряд.
//
// Ни одно из трёх не выглядит как поломка со стороны: дашборд просто
// открывается. Проверено на воркере в Node — GET / отдавал страницу дашборда
// с кодом 200, без куки и без пароля.
//
// Поэтому проверка одна и живёт в одном месте: гейт включён, если настроен
// ХОТЬ ОДИН пароль.
function gateEnabled(env) {
  return !!(env.DASHBOARD_PASSWORD || env.DASHBOARD_PASSWORD_HASH ||
            env.AUTH_FULL_HASH || env.AUTH_STANDARD_HASH);
}

// Returns null when the request may proceed to the assets, or a Response (login
// page / redirect) when the gate intercepts it. Disabled while no password set.
async function gate(request, env) {
  if (!gateEnabled(env)) return null; // ни одного пароля не настроено — см. gateEnabled

  const url = new URL(request.url);

  if (request.method === 'POST' && url.pathname === '/__auth') {
    const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';

    // Rate limiting — порог и окно см. у LOGIN_MAX_ATTEMPTS.
    if (await getFailedAttempts(ip) >= LOGIN_MAX_ATTEMPTS) {
      return htmlResponse(loginPage(false, true), 429);
    }

    const form = await request.formData();
    const submittedPassword = String(form.get('password') || '');
    const role = await verifyPassword(submittedPassword, env);
    if (role) {
      return new Response(null, {
        status: 303,
        headers: { 'Location': '/', 'Set-Cookie': sessionCookie(await makeSession(env, role)) },
      });
    }
    // Record failed attempt
    await recordFailedAttempt(ip);
    return htmlResponse(loginPage(true, false), 401);
  }

  if (url.pathname === '/__logout') {
    return new Response(null, { status: 303, headers: { 'Location': '/', 'Set-Cookie': clearCookie() } });
  }

  if (!(await verifySession(getCookie(request, COOKIE_NAME), env))) {
    return htmlResponse(loginPage(false, false), 200);
  }

  return null; // authenticated — let the asset serve (cookie refreshed by caller)
}

// ── Main export ───────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    // Serving the dashboard is this worker's one indispensable job. Anything
    // added around it — proxies, gates, webhooks — is a convenience, and a
    // convenience that throws must not take the site down with it. With
    // run_worker_first the worker sees every request, so an unhandled error
    // here is a blank page for everyone, from every network.
    try {
      return await handleRequest(request, env, ctx);
    } catch (e) {
      console.error('fetch handler failed, falling back to assets:', e);
      try { return await env.ASSETS.fetch(request); }
      catch (_) { return new Response('Service temporarily unavailable', { status: 503 }); }
    }
  },

  async scheduled(event, env, ctx) {
    return scheduledHandler(event, env, ctx);
  },
};

// The real request handler. Wrapped by the export above so that a failure in
// any of the conveniences below still falls back to serving the dashboard.
async function handleRequest(request, env, ctx) {
    const url = new URL(request.url);

    // Telegram webhook endpoint.
    //
    // This route sits BEFORE the password gate by necessity — Telegram calls it,
    // and Telegram cannot log in. That makes it the one publicly reachable entry
    // point in the worker, so what it is allowed to do matters.
    //
    // It is not inert: a callback_query matching `wd:approve:<id>` invokes
    // watchdogApply(), which calls the watchdog-agent edge function and applies
    // a system change. The only check on that path was
    // `cq.from?.id === TG_MY_USER_ID(env)` — but `from.id` is a field of the
    // REQUEST BODY, so anyone who knows this URL could send a hand-written
    // "callback" carrying the right id and approve watchdog actions without
    // any credential at all.
    //
    // Telegram signs its deliveries with a secret you register alongside the
    // webhook and it replays on every call in this header. Verifying it is the
    // actual authentication for this route; the from.id check stays as a second
    // condition, not as the boundary.
    if (request.method === 'POST' && url.pathname === '/tg-webhook') {
      const expected = env.TG_WEBHOOK_SECRET;
      if (expected) {
        const got = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
        if (got !== expected) {
          console.error('tg-webhook: bad or missing secret token — rejected');
          // 401, not 403: an unauthenticated caller, and Telegram itself never
          // sees this because it always sends the header once registered.
          return new Response('unauthorized', { status: 401 });
        }
      } else {
        // Unset secret keeps the webhook working rather than silently killing
        // Telegram integration on deploy — but it is a hole, so it is loud in
        // the logs instead of invisible. Register it with setWebhook's
        // secret_token parameter and set TG_WEBHOOK_SECRET to the same value.
        console.error('tg-webhook: TG_WEBHOOK_SECRET is not set — route is UNAUTHENTICATED');
      }
      try {
        const update = await request.json();
        ctx.waitUntil(handleTgUpdate(update, env));
      } catch (e) {
        console.error('tg-webhook error:', e);
      }
      return new Response('OK');
    }

    // Password gate — intercepts with login page / redirect, or returns null
    // to allow the request through. No-op until DASHBOARD_PASSWORD is set.
    const gated = await gate(request, env);
    if (gated) return gated;

    // ── Роль текущей сессии для страницы (Блок 4) ────────────────────────────
    // Единственный способ для дашборда узнать, что ему показывать. Стоит ПОСЛЕ
    // gate(), поэтому неаутентифицированный запрос сюда не доходит — гейт
    // вернёт форму входа раньше.
    //
    // Ответ намеренно бедный: только роль, без самого JWT. Отдай мы токен —
    // страница смогла бы его сохранить и пойти с ним напрямую в supabase.co
    // в обход /db, и граница доступа снова превратилась бы в формальность.
    //
    // Гейт выключен (пароль не настроен) — отдаём 'full': в этом состоянии
    // дашборд и так открыт целиком, и урезать его до 'standard' значило бы
    // спрятать экраны от установки, которая просто ещё не настраивала пароли.
    if (url.pathname === '/__role') {
      const gateOn = gateEnabled(env);
      const sess = gateOn ? await readSession(getCookie(request, COOKIE_NAME), env) : null;
      const role = gateOn ? (sess && sess.role === 'full' ? 'full' : 'standard') : 'full';

      // ── Диагностика конфигурации ──────────────────────────────────────────
      // Только «задан / не задан», никогда сами значения и никогда длина.
      // Появилось из вполне конкретного тупика: смена роли принимала лишь
      // старый DASHBOARD_PASSWORD и всегда выдавала standard, и отличить
      // «секрет не доехал до воркера» от «секрет есть, но введено другое»
      // было нечем — снаружи оба выглядят как молчаливый отказ.
      //
      // Стоит за паролем, и три булева ничего не добавляют тому, кто уже
      // вошёл: существование полного доступа видно по самой кнопке ⇄.
      const configured = {
        full:     !!env.AUTH_FULL_HASH,
        standard: !!env.AUTH_STANDARD_HASH,
        legacy:   !!(env.DASHBOARD_PASSWORD || env.DASHBOARD_PASSWORD_HASH),
      };

      return new Response(JSON.stringify({ role, configured, build: BUILD }), {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          // Роль меняется вместе с сессией — закэшированный ответ пережил бы
          // перелогин под другим PIN и показал бы чужой интерфейс.
          'Cache-Control': 'no-store',
        },
      });
    }

    // ── Same-origin proxies ──────────────────────────────────────────────────
    // The dashboard used to load its library from cdn.jsdelivr.net and talk to
    // *.supabase.co directly from the browser. Both are third-party hosts, and
    // from some networks one or the other simply does not resolve — the page
    // then renders its whole layout with every table empty, because the script
    // dies on the first line that touches an unreachable host. Reported from a
    // Russian IP: page fine, pipeline blank.
    //
    // This worker is served from a host the browser has already reached — it
    // fetched this very page from it. So both dependencies now travel through
    // it. The hop to jsDelivr and Supabase happens from Cloudflare's network
    // rather than from the visitor's, which is exactly the part that was
    // failing.
    //
    // No credentials are injected here: the browser sends its own apikey /
    // Authorization headers, the same anon key that already ships in the page.
    // The proxy is transport, not an authority — it cannot grant access the
    // caller did not already have, and it sits BEHIND the password gate above.
    if (url.pathname === '/vendor/supabase.js') {
      const upstream = await fetch(
        'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js',
        { cf: { cacheEverything: true, cacheTtl: 86400 } },
      );
      if (!upstream.ok) return new Response('// upstream CDN unavailable', { status: 502 });
      // Never pass off an error page as a script. A 200 carrying HTML is worse
      // than a clean failure: the browser accepts it, fails to parse it, and no
      // fallback ever fires because nothing reported an error.
      const ct = upstream.headers.get('content-type') || '';
      if (!/javascript|ecmascript|text\/plain/i.test(ct)) {
        return new Response('// upstream returned ' + (ct || 'no content-type'), { status: 502 });
      }
      return new Response(upstream.body, {
        status: 200,
        headers: {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'public, max-age=86400',
        },
      });
    }

    if (url.pathname === '/db' || url.pathname.startsWith('/db/')) {
      const target = (env.SUPABASE_URL || DEFAULT_SUPABASE_URL)
        + url.pathname.slice('/db'.length) + url.search;

      // Preflight never reaches Supabase — answer it here, or the browser
      // refuses the real request and the table stays empty for a second reason.
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: proxyCors(request) });
      }

      // Hop-by-hop and Cloudflare-added headers must not be replayed upstream.
      const fwd = new Headers();
      for (const [k, v] of request.headers) {
        const lk = k.toLowerCase();
        if (lk === 'host' || lk === 'origin' || lk === 'referer' || lk === 'cookie') continue;
        if (lk.startsWith('cf-') || lk.startsWith('x-forwarded-')) continue;
        fwd.set(k, v);
      }

      // ── Здесь проходит граница доступа (Блок 4) ──────────────────────────
      // Раньше прокси был чистым транспортом: он пересылал наверх тот ключ,
      // который прислал браузер, то есть встроенный в страницу anon-ключ. При
      // выключенном RLS этот ключ даёт полный доступ ко всем таблицам, и
      // пароль на входе защищал только сам HTML-файл, но не данные.
      //
      // Теперь запрос уходит наверх ПОД РОЛЬЮ ИЗ СЕССИИ. Клиентский
      // Authorization отбрасывается целиком — если бы мы его уважали, любой мог
      // бы прислать service_role-ключ и обойти всё разграничение.
      //
      // apikey остаётся anon: его требует шлюз Supabase до всякого PostgREST,
      // и сам по себе, при включённом RLS, он не даёт ничего.
      const sess = await readSession(getCookie(request, COOKIE_NAME), env);
      const jwt  = sess ? await mintSupabaseJwt(env, sess.role) : null;
      if (jwt) {
        fwd.set('apikey', env.SUPABASE_ANON_KEY || DEFAULT_ANON_KEY);
        fwd.set('Authorization', 'Bearer ' + jwt);
      }
      // Если SUPABASE_JWT_SECRET не задан, jwt === null и заголовки клиента
      // идут как раньше. Это сознательный откат: включить RLS до настройки
      // секрета — значит получить пустой дашборд, а деплой не должен ронять
      // рабочую систему. Проверка схемы в CI отдельно следит за тем, чтобы RLS
      // и секрет включались согласованно.

      const upstream = await fetch(target, {
        method: request.method,
        headers: fwd,
        body: (request.method === 'GET' || request.method === 'HEAD') ? undefined : request.body,
        redirect: 'follow',
      });

      const out = new Response(upstream.body, upstream);
      for (const [k, v] of Object.entries(proxyCors(request))) out.headers.set(k, v);
      // PostgREST paginates through this one; without it the client cannot
      // tell a short page from the end of the table.
      out.headers.set('Access-Control-Expose-Headers', 'content-range, content-length');
      return out;
    }

    const assetRes = await env.ASSETS.fetch(request);

    // Refresh the sliding session on every authed asset hit (keeps the 3h
    // inactivity window rolling). Only when the gate is active.
    if (gateEnabled(env)) {
      const res = new Response(assetRes.body, assetRes);
      // Роль переносится из текущей сессии: иначе каждое продление молча
      // понижало бы 'full' до 'standard' на первом же обращении к странице.
      const cur = await readSession(getCookie(request, COOKIE_NAME), env);
      res.headers.append('Set-Cookie', sessionCookie(await makeSession(env, cur?.role)));
      return res;
    }
    return assetRes;
}

async function scheduledHandler(event, env, ctx) {
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
        // Partner bases: per-base auto-send (own template + own daily limit + own
        // toggle). Sends nothing unless a base has sending_enabled = true.
        call('process-partner-queue', {}),
        // DataForSEO pipeline queue filler. Separate function, disjoint lead set,
        // own ceiling in pipeline_limits — process-queue drains both queues but
        // enforces each pipeline's limit and pause switch independently.
        call('generate-queue-dfs', {}),
      ]);
      return;
    }

    if (cron === '*/3 * * * *') {
      // Search pipeline + form channel, all in parallel (independent Supabase fns).
      // The form functions used to live on a dedicated */10 trigger, but Cloudflare's
      // free plan caps cron triggers at 5 — the 6th silently never fired, so
      // find-contact-form never ran and no forms were ever submitted. Folding them
      // into this proven tick guarantees they run (and detection is now 3x faster).
      //   find-contact-form  — detect + classify contact forms (read-only)
      //   process-form-queue — submit simple forms (armed via FORM_SENDING_ENABLED)
      //
      // DataForSEO pipeline stages 2 and 3 ride this tick too. Stage 1
      // (dfs-harvest) is deliberately NOT scheduled: every call costs real money
      // and it is meant to run in large, infrequent batches, fired by hand from
      // the DataForSEO tab.
      //   dfs-qualify — judges raw domains from the link graph, LLM-batched
      //   dfs-enrich  — fetches contacts + analytics ids for promoted leads
      await Promise.all([
        call('find-and-queue', {}),
        call('find-contact-form', {}),
        call('process-form-queue', {}),
        call('dfs-qualify', {}),
        call('dfs-enrich', {}),
      ]);
      return;
    }

    if (cron === '*/15 * * * *') {
      // Quota checks + the v5 background brains. (Watchdog agent disabled — no
      // Anthropic key; the function stays deployed but is not scheduled.)
      //   run-sequences   — P0.3 follow-up engine. Enqueues the next touch for
      //                     leads whose next_action_at is due. Safe to run more
      //                     often than hourly: it only acts on due rows and drops
      //                     anyone who replied/bounced/unsubscribed.
      //   validate-emails — P0.1 gate. Verifies addresses in bulk BEFORE they can
      //                     reach send_queue, so dead ones never burn domain rep.
      //   score-leads     — P1.1. Scores + hard-filters new leads so the queue
      //                     goes out best-first instead of in import order.
      //
      // Telegram outreach agent (discovery only — nothing is ever sent to a
      // channel owner automatically). All four stages ride this tick because the
      // free plan caps cron triggers at 5 and all 5 are taken:
      //   scan-tg-channels   — 6 queries/run, rotating pages, every tick
      //   extract-tg-contact — reads public channel pages for an owner contact
      //   draft-tg-message   — writes the message the operator will paste
      //   send-tg-leads      — delivers lead cards to the operator's own chat
      // All four run round the clock: this is search, and the operator works the
      // resulting base by hand. Each self-limits on a ~110s internal deadline so
      // a long run ends cleanly instead of being killed mid-batch.
      await Promise.all([
        call('check-limits', { cron }),
        call('run-sequences', {}),
        call('validate-emails', {}),
        call('score-leads', {}),
        call('scan-tg-channels', {}),
        call('extract-tg-contact', {}),
        call('draft-tg-message', {}),
        call('send-tg-leads', {}),
      ]);
      return;
    }

    if (cron === '0 7 * * *') {
      // 10:00 MSK — one morning report per day.
      // archive-keywords rides this tick and self-gates to Mondays: it retires
      // keywords whose yield died and alerts when a preset's pool runs thin, so
      // the search pool can't silently burn out the way the v5 one did.
      await Promise.all([
        call('daily-report', {}),
        call('archive-keywords', {}),
      ]);
      return;
    }

    if (cron === '*/7 * * * *') {
      // LuckyPari outreach — separate brand, own quota. Fires ~9x/hour and sends
      // one email per tick, spreading 100/day evenly across working hours (no bursts).
      // find-appstore rides this tick too (Africa-focus week): armed via APPSTORE_ENABLED,
      // it mines one African store slot per run for app-developer leads (new source, no
      // extra cron trigger — free plan caps at 5).
      await Promise.all([
        call('process-queue-lp', {}),
        call('find-appstore', {}),
        // YouTube base auto-fill — one rotating African GEO per tick, self-capped at
        // 72 searches/day (7200 quota units) so it never burns the 10k/day budget.
        call('youtube-search', { cron: true }),
        // Salvage pass over the ~4000 qualified leads that came back with no
        // contact: archive.org snapshots, open WordPress author endpoints, and
        // footer socials. Rides this slower tick because archive.org is donated
        // infrastructure and is polled at ~1 req/s out of courtesy.
        call('recover-contacts', {}),
        // Reply listening (P0.2). Every 7 min matches the 5–10 min target and
        // reuses this tick because the free plan caps cron triggers at 5.
        // Reads INBOX over IMAP, classifies, and drops a Telegram alert on a
        // hot lead. Idempotent — it advances a UID cursor in app_state.
        call('poll-replies', {}),
      ]);
      return;
    }
}

