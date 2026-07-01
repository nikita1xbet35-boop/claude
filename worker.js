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
//
// Dashboard password gate (optional):
//   DASHBOARD_PASSWORD — set this secret to require a password before the
//     dashboard loads. While UNSET the gate is disabled (dashboard stays open),
//     so deploying this code never locks you out before you configure it.
//   SESSION_SECRET     — optional HMAC key for signing session cookies; falls
//     back to DASHBOARD_PASSWORD when absent.

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

function authSecret(env) {
  return env.SESSION_SECRET || env.DASHBOARD_PASSWORD || '';
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

async function verifyPassword(input, env) {
  const storedHash = env.DASHBOARD_PASSWORD_HASH; // "salt:hash" format
  const plainPw    = env.DASHBOARD_PASSWORD;       // legacy plain fallback
  if (!storedHash && !plainPw) return false;
  if (storedHash) {
    const [salt, hash] = storedHash.split(':');
    const inputHash = await hashPassword(input, salt || '');
    return safeEqual(inputHash, hash);
  }
  // Legacy plain text fallback (still works if only DASHBOARD_PASSWORD is set)
  return safeEqual(input, plainPw);
}

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
    body: JSON.stringify({ ip, failed_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600_000).toISOString() }),
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

async function makeSession(env) {
  const payload = b64urlEncode(new TextEncoder().encode(JSON.stringify({ exp: Date.now() + SESSION_TTL_MS })));
  return `${payload}.${await hmac(authSecret(env), payload)}`;
}

async function verifySession(token, env) {
  if (!token) return false;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return false;
  const payload = token.slice(0, dot);
  if (!safeEqual(token.slice(dot + 1), await hmac(authSecret(env), payload))) return false;
  try {
    const { exp } = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
    return typeof exp === 'number' && Date.now() < exp;
  } catch {
    return false;
  }
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
    <div class="err${(error || blocked) ? ' show' : ''}" id="err">${blocked ? 'Слишком много попыток. Подождите 1 час.' : 'Неверный PIN'}</div>
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

const htmlResponse = (body, status) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });

// Returns null when the request may proceed to the assets, or a Response (login
// page / redirect) when the gate intercepts it. Disabled while no password set.
async function gate(request, env) {
  const password = env.DASHBOARD_PASSWORD;
  const passwordHash = env.DASHBOARD_PASSWORD_HASH;
  if (!password && !passwordHash) return null; // gate disabled until the secret is configured

  const url = new URL(request.url);

  if (request.method === 'POST' && url.pathname === '/__auth') {
    const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';

    // Rate limiting: block after 2 failed attempts
    if (await getFailedAttempts(ip) >= 2) {
      return htmlResponse(loginPage(false, true), 429);
    }

    const form = await request.formData();
    const submittedPassword = String(form.get('password') || '');
    if (await verifyPassword(submittedPassword, env)) {
      return new Response(null, {
        status: 303,
        headers: { 'Location': '/', 'Set-Cookie': sessionCookie(await makeSession(env)) },
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

    // Password gate — intercepts with login page / redirect, or returns null
    // to allow the request through. No-op until DASHBOARD_PASSWORD is set.
    const gated = await gate(request, env);
    if (gated) return gated;

    const assetRes = await env.ASSETS.fetch(request);

    // Refresh the sliding session on every authed asset hit (keeps the 3h
    // inactivity window rolling). Only when the gate is active.
    if (env.DASHBOARD_PASSWORD) {
      const res = new Response(assetRes.body, assetRes);
      res.headers.append('Set-Cookie', sessionCookie(await makeSession(env)));
      return res;
    }
    return assetRes;
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
      // Search pipeline + form channel, all in parallel (independent Supabase fns).
      // The form functions used to live on a dedicated */10 trigger, but Cloudflare's
      // free plan caps cron triggers at 5 — the 6th silently never fired, so
      // find-contact-form never ran and no forms were ever submitted. Folding them
      // into this proven tick guarantees they run (and detection is now 3x faster).
      //   find-contact-form  — detect + classify contact forms (read-only)
      //   process-form-queue — submit simple forms (armed via FORM_SENDING_ENABLED)
      await Promise.all([
        call('find-and-queue', {}),
        call('find-contact-form', {}),
        call('process-form-queue', {}),
      ]);
      return;
    }

    if (cron === '*/15 * * * *') {
      // Quota checks + the Claude watchdog agent (L1 observe / L3 auto-fix /
      // L2 propose). Both are independent — run in parallel.
      await Promise.all([
        call('check-limits', { cron }),
        call('watchdog-agent', {}),
      ]);
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
