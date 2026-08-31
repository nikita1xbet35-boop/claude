// Тесты воркера партнёрских ботов. Запуск: node partner-bots/test.mjs
//
// Сеть подменяется целиком: Supabase отвечает мини-реализацией PostgREST на
// объектах в памяти, Telegram — журналом отправленных сообщений. Смысл в том,
// чтобы проверять поведение (что записалось в bot_leads, что ушло человеку), а
// не вызовы — вызовы можно сверить и глазами, а вот «повторное нажатие создаёт
// вторую строку» глазами не видно.

import assert from 'node:assert';

const SUPA = 'https://db.test';

// ── Мини-PostgREST ──────────────────────────────────────────────────────────
function makeDb() {
  return {
    bot_configs: [
      { slug:'india', geo_label:'India', default_lang:'en', manager_contact:'@aff_manager_xbet', signup_url_tpl:'', active:true },
      { slug:'afrique', geo_label:'Francophone Africa', default_lang:'fr', manager_contact:'@aff_manager_xbet', signup_url_tpl:'', active:true },
      { slug:'uzbekistan', geo_label:'Uzbekistan', default_lang:'uz', manager_contact:'@aff_manager_xbet', signup_url_tpl:'', active:true },
      { slug:'worldwide', geo_label:'Worldwide', default_lang:'en', manager_contact:'@aff_manager_xbet', signup_url_tpl:'', active:false },
    ],
    bot_leads: [],
    bot_user_prefs: [],
    bot_faq: [
      { lang:'en', key:'payouts',  question:'💵 Payouts',        answer:'', sort_order:1 },
      { lang:'en', key:'revshare', question:'📊 RevShare terms', answer:'', sort_order:2 },
      { lang:'fr', key:'payouts',  question:'💵 Paiements',      answer:'', sort_order:1 },
      { lang:'uz', key:'payouts',  question:"💵 To'lovlar",      answer:'', sort_order:1 },
    ],
    _seq: 1,
  };
}

const OPS = { eq: (a,b) => String(a) === b, lt: (a,b) => String(a) < b, gt: (a,b) => String(a) > b };

function applyFilters(rows, params) {
  let out = rows;
  for (const [k, v] of params) {
    if (['select','order','limit','on_conflict'].includes(k)) continue;
    const dot = v.indexOf('.');
    const op = v.slice(0, dot), val = v.slice(dot + 1);
    if (!OPS[op]) throw new Error(`тест: оператор ${op} не реализован`);
    out = out.filter(r => OPS[op](r[k], val));
  }
  return out;
}

// Ключи, по которым строка считается той же самой (аналог UNIQUE в 048).
const PK = {
  bot_leads: ['bot_slug','tg_user_id'],
  bot_user_prefs: ['bot_slug','tg_user_id'],
  bot_faq: ['lang','key'],
  bot_configs: ['slug'],
};

function fakeSupabase(db, url, init) {
  const u = new URL(url);
  const table = u.pathname.replace('/rest/v1/', '');
  const params = [...u.searchParams.entries()];
  const method = init.method || 'GET';
  const rows = db[table];
  if (!rows) throw new Error(`тест: нет таблицы ${table}`);

  if (method === 'GET') {
    let out = applyFilters(rows, params);
    const order = u.searchParams.get('order');
    if (order) out = [...out].sort((a,b) => (a[order] > b[order] ? 1 : -1));
    const limit = u.searchParams.get('limit');
    if (limit) out = out.slice(0, Number(limit));
    return new Response(JSON.stringify(out), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (method === 'POST') {
    const body = JSON.parse(init.body);
    const merge = (init.headers?.Prefer || '').includes('merge-duplicates');
    const keys = PK[table];
    const existing = rows.find(r => keys.every(k => String(r[k]) === String(body[k])));
    if (existing) {
      if (!merge) return new Response('duplicate key', { status: 409 });
      Object.assign(existing, body);          // как ON CONFLICT DO UPDATE
    } else {
      rows.push({ id: db._seq++, reminder_sent: false, status: 'link_issued',
                  link_issued_at: new Date().toISOString(), ...body });
    }
    return new Response(null, { status: 204 });
  }

  if (method === 'PATCH') {
    const body = JSON.parse(init.body);
    for (const r of applyFilters(rows, params)) Object.assign(r, body);
    return new Response(null, { status: 204 });
  }
  throw new Error(`тест: метод ${method} не реализован`);
}

// ── Стенд ───────────────────────────────────────────────────────────────────
async function harness() {
  const db = makeDb();
  const sent = [];       // всё, что ушло в Telegram
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith(SUPA)) return fakeSupabase(db, url, init);
    if (url.startsWith('https://api.telegram.org/')) {
      const method = url.split('/').pop();
      const payload = JSON.parse(init.body);
      sent.push({ method, ...payload });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    throw new Error(`тест: неожиданный запрос ${url}`);
  };

  const { default: worker } = await import('./worker.js?v=' + Date.now());
  const env = {
    SUPABASE_URL: SUPA, SUPABASE_SERVICE_KEY: 'svc',
    BOT_WEBHOOK_SECRET: 'shh',
    BOT_TOKEN_INDIA: 'tok-in', BOT_TOKEN_AFRIQUE: 'tok-fr',
    BOT_TOKEN_UZBEKISTAN: 'tok-uz', BOT_TOKEN_WORLDWIDE: 'tok-ww',
  };

  const post = (slug, update, secret = 'shh') =>
    worker.fetch(new Request(`https://x.test/bot/${slug}`, {
      method: 'POST',
      headers: secret === null ? {} : { 'X-Telegram-Bot-Api-Secret-Token': secret },
      body: JSON.stringify(update),
    }), env, { waitUntil: p => p });

  const msg = (text, userId = 42, username = 'nick') =>
    ({ message: { chat: { id: userId }, from: { id: userId, username }, text } });
  const cb = (data, userId = 42) =>
    ({ callback_query: { id: 'c1', from: { id: userId }, data, message: { chat: { id: userId } } } });

  // scheduled() отдаёт работу в waitUntil и возвращается немедленно — так
  // устроен Cloudflare. Тест обязан дождаться этой работы, иначе проверяет
  // состояние до того, как реминдер вообще отправлен (а асинхронный хвост
  // потом доедет уже в следующем тесте, с чужой базой).
  const runCron = async () => {
    const waits = [];
    await worker.scheduled({}, env, { waitUntil: p => waits.push(p) });
    await Promise.all(waits);
  };

  return { db, sent, env, worker, post, msg, cb, runCron, last: () => sent[sent.length - 1] };
}

// ── Проверки ────────────────────────────────────────────────────────────────
let failed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('вебхук без секрета отклоняется 401', async () => {
  const h = await harness();
  const res = await h.post('india', h.msg('/start'), null);
  assert.strictEqual(res.status, 401);
  assert.strictEqual(h.sent.length, 0, 'ничего не должно быть отправлено');
});

test('вебхук с чужим секретом отклоняется 401', async () => {
  const h = await harness();
  assert.strictEqual((await h.post('india', h.msg('/start'), 'wrong')).status, 401);
});

test('неизвестный бот — 404, чужой путь — 404', async () => {
  const h = await harness();
  assert.strictEqual((await h.post('nosuchbot', h.msg('/start'))).status, 404);
  const res = await h.worker.fetch(new Request('https://x.test/'), h.env, {});
  assert.strictEqual(res.status, 404);
});

test('GET на вебхук — 405', async () => {
  const h = await harness();
  const res = await h.worker.fetch(
    new Request('https://x.test/bot/india', { method: 'GET' }), h.env, {});
  assert.strictEqual(res.status, 405);
});

test('/start отвечает на языке бота: en / fr / uz', async () => {
  const h = await harness();
  await h.post('india', h.msg('/start'));
  assert.match(h.last().text, /Welcome to the 1xBet Affiliate Program/);
  await h.post('afrique', h.msg('/start'));
  assert.match(h.last().text, /Bienvenue dans le programme/);
  await h.post('uzbekistan', h.msg('/start'));
  assert.match(h.last().text, /xush kelibsiz/);
});

test('/start показывает контакт менеджера сразу, без кликов', async () => {
  const h = await harness();
  await h.post('india', h.msg('/start'));
  assert.match(h.last().text, /@aff_manager_xbet/);
  assert.strictEqual(h.last().reply_markup.keyboard.length, 2, 'меню из трёх кнопок в двух рядах');
});

test('выключенный бот молчит', async () => {
  const h = await harness();
  const res = await h.post('worldwide', h.msg('/start'));   // active:false
  assert.strictEqual(res.status, 200);
  assert.strictEqual(h.sent.length, 0);
});

test('ссылка не настроена → честный ответ и НЕТ записи в bot_leads', async () => {
  const h = await harness();
  await h.post('india', h.msg('🔗 Get Registration Link'));
  assert.match(h.last().text, /isn't configured yet/);
  assert.match(h.last().text, /@aff_manager_xbet/);
  assert.strictEqual(h.db.bot_leads.length, 0,
    'счётчик выдач не должен расти, когда ссылка не выдана');
});

test('ссылка настроена → выдаётся с ref_code и пишется лид', async () => {
  const h = await harness();
  h.db.bot_configs[0].signup_url_tpl = 'https://p.example/signup?ref={ref}';
  await h.post('india', h.msg('🔗 Get Registration Link'));
  assert.match(h.last().text, /https:\/\/p\.example\/signup\?ref=tg_india_42/);
  assert.strictEqual(h.db.bot_leads.length, 1);
  const lead = h.db.bot_leads[0];
  assert.strictEqual(lead.ref_code, 'tg_india_42');
  assert.strictEqual(lead.tg_username, 'nick');
  assert.strictEqual(lead.status, 'link_issued');
});

test('повторное нажатие не плодит вторую строку', async () => {
  const h = await harness();
  h.db.bot_configs[0].signup_url_tpl = 'https://p.example/signup?ref={ref}';
  await h.post('india', h.msg('🔗 Get Registration Link'));
  await h.post('india', h.msg('🔗 Get Registration Link'));
  await h.post('india', h.msg('🔗 Get Registration Link'));
  assert.strictEqual(h.db.bot_leads.length, 1);
});

test('повторное нажатие не сдвигает link_issued_at (иначе реминдер не придёт)', async () => {
  const h = await harness();
  h.db.bot_configs[0].signup_url_tpl = 'https://p.example/signup?ref={ref}';
  await h.post('india', h.msg('🔗 Get Registration Link'));
  const first = h.db.bot_leads[0].link_issued_at;
  h.db.bot_leads[0].link_issued_at = '2020-01-01T00:00:00.000Z';   // «давно»
  await h.post('india', h.msg('🔗 Get Registration Link'));
  assert.strictEqual(h.db.bot_leads[0].link_issued_at, '2020-01-01T00:00:00.000Z',
    'дата выдачи переписана — окно реминдера сбрасывалось бы при каждом нажатии');
  assert.notStrictEqual(first, undefined);
});

test('повторное нажатие не откатывает contacted_manager в link_issued', async () => {
  const h = await harness();
  h.db.bot_configs[0].signup_url_tpl = 'https://p.example/signup?ref={ref}';
  await h.post('india', h.msg('🔗 Get Registration Link'));
  await h.post('india', h.msg('👤 Talk to Manager'));
  assert.strictEqual(h.db.bot_leads[0].status, 'contacted_manager');
  await h.post('india', h.msg('🔗 Get Registration Link'));
  assert.strictEqual(h.db.bot_leads[0].status, 'contacted_manager',
    'откат статуса снова взвёл бы реминдер тому, кто уже общается с менеджером');
});

test('после повторного нажатия реминдер по-прежнему не уходит', async () => {
  const h = await harness();
  h.db.bot_configs[0].signup_url_tpl = 'https://p.example/signup?ref={ref}';
  await h.post('india', h.msg('🔗 Get Registration Link'));
  await h.post('india', h.msg('👤 Talk to Manager'));
  await h.post('india', h.msg('🔗 Get Registration Link'));
  h.db.bot_leads[0].link_issued_at = new Date(Date.now() - 7*24*3600*1000).toISOString();
  h.sent.length = 0;
  await h.runCron();
  assert.strictEqual(h.sent.length, 0);
});

test('лиды разных ботов не смешиваются', async () => {
  const h = await harness();
  h.db.bot_configs[0].signup_url_tpl = 'https://p.example/signup?ref={ref}';
  h.db.bot_configs[1].signup_url_tpl = 'https://p.example/signup?ref={ref}';
  await h.post('india', h.msg('🔗 Get Registration Link'));
  await h.post('afrique', h.msg('🔗 Obtenir le lien d\'inscription'));
  assert.strictEqual(h.db.bot_leads.length, 2, 'один человек в двух ботах — две записи');
  assert.deepStrictEqual(h.db.bot_leads.map(l => l.ref_code).sort(),
    ['tg_afrique_42', 'tg_india_42']);
});

test('«Talk to Manager» отдаёт контакт и НЕ создаёт лида', async () => {
  const h = await harness();
  await h.post('india', h.msg('👤 Talk to Manager'));
  assert.match(h.last().text, /@aff_manager_xbet/);
  assert.strictEqual(h.db.bot_leads.length, 0, 'ТЗ §3.4: записи нет — не создавать');
});

test('«Talk to Manager» переводит существующего лида в contacted_manager', async () => {
  const h = await harness();
  h.db.bot_configs[0].signup_url_tpl = 'https://p.example/signup?ref={ref}';
  await h.post('india', h.msg('🔗 Get Registration Link'));
  await h.post('india', h.msg('👤 Talk to Manager'));
  assert.strictEqual(h.db.bot_leads[0].status, 'contacted_manager');
});

test('FAQ показывает кнопки, пустой ответ отдаёт контакт вместо выдумки', async () => {
  const h = await harness();
  await h.post('india', h.msg('❓ FAQ'));
  const kb = h.last().reply_markup.inline_keyboard;
  assert.strictEqual(kb.length, 2);
  assert.strictEqual(kb[0][0].text, '💵 Payouts');

  await h.post('india', h.cb('faq:payouts'));
  assert.match(h.last().text, /isn't published yet/);
  assert.match(h.last().text, /@aff_manager_xbet/);
});

test('FAQ отдаёт согласованный текст, когда он заполнен', async () => {
  const h = await harness();
  h.db.bot_faq.find(f => f.lang==='en' && f.key==='payouts').answer = 'Weekly payouts.';
  await h.post('india', h.cb('faq:payouts'));
  assert.strictEqual(h.last().text, 'Weekly payouts.');
});

test('/lang переключает язык и он переживает следующий /start', async () => {
  const h = await harness();
  await h.post('india', h.msg('/lang'));
  assert.match(h.last().text, /Choose language/);
  await h.post('india', h.cb('lang:fr'));
  assert.match(h.last().text, /Langue définie/);
  await h.post('india', h.msg('/start'));
  assert.match(h.last().text, /Bienvenue dans le programme/,
    'выбор языка должен пережить перезаход');
});

test('язык хранится до первого лида и не создаёт пустую запись', async () => {
  const h = await harness();
  await h.post('india', h.cb('lang:uz'));
  assert.strictEqual(h.db.bot_user_prefs.length, 1);
  assert.strictEqual(h.db.bot_leads.length, 0, 'выбор языка — не выдача ссылки');
});

test('кнопка на прежнем языке продолжает работать после смены', async () => {
  const h = await harness();
  h.db.bot_configs[0].signup_url_tpl = 'https://p.example/signup?ref={ref}';
  await h.post('india', h.cb('lang:fr'));
  // Клавиатура у человека на экране всё ещё английская — Telegram её не
  // перерисовывает сам.
  await h.post('india', h.msg('🔗 Get Registration Link'));
  assert.strictEqual(h.db.bot_leads.length, 1, 'нажатие не должно провалиться в «не понял»');
  assert.match(h.last().text, /lien d'inscription personnel/, 'ответ уже на новом языке');
});

test('произвольный текст возвращает меню, а не молчание', async () => {
  const h = await harness();
  await h.post('india', h.msg('привет, как дела'));
  assert.match(h.last().text, /Welcome to the 1xBet/);
});

test('реминдер уходит через 6 дней и ровно один раз', async () => {
  const h = await harness();
  h.db.bot_configs[0].signup_url_tpl = 'https://p.example/signup?ref={ref}';
  await h.post('india', h.msg('🔗 Get Registration Link'));
  h.sent.length = 0;

  await h.runCron();
  assert.strictEqual(h.sent.length, 0, 'свежему лиду реминдер не нужен');

  h.db.bot_leads[0].link_issued_at = new Date(Date.now() - 7*24*3600*1000).toISOString();
  await h.runCron();
  assert.strictEqual(h.sent.length, 1);
  assert.match(h.sent[0].text, /Just checking in/);
  assert.match(h.sent[0].text, /ref=tg_india_42/);
  assert.strictEqual(h.db.bot_leads[0].reminder_sent, true);

  h.sent.length = 0;
  await h.runCron();
  assert.strictEqual(h.sent.length, 0, 'второй раз реминдер слать нельзя');
});

test('реминдер не уходит тому, кто уже написал менеджеру', async () => {
  const h = await harness();
  h.db.bot_configs[0].signup_url_tpl = 'https://p.example/signup?ref={ref}';
  await h.post('india', h.msg('🔗 Get Registration Link'));
  await h.post('india', h.msg('👤 Talk to Manager'));
  h.db.bot_leads[0].link_issued_at = new Date(Date.now() - 7*24*3600*1000).toISOString();
  h.sent.length = 0;
  await h.runCron();
  assert.strictEqual(h.sent.length, 0, 'человек уже на связи — напоминание лишнее');
});

test('реминдер на языке лида', async () => {
  const h = await harness();
  h.db.bot_configs[2].signup_url_tpl = 'https://p.example/signup?ref={ref}';
  await h.post('uzbekistan', h.msg("🔗 Ro'yxatdan o'tish havolasi"));
  h.db.bot_leads[0].link_issued_at = new Date(Date.now() - 7*24*3600*1000).toISOString();
  h.sent.length = 0;
  await h.runCron();
  assert.match(h.sent[0].text, /Eslatma/);
});

test('падение Supabase не роняет вебхук: Telegram получает 200', async () => {
  const h = await harness();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith(SUPA)) return new Response('boom', { status: 500 });
    return realFetch(input, init);
  };
  const res = await h.post('india', h.msg('/start'));
  assert.strictEqual(res.status, 200,
    'не-200 заставил бы Telegram повторять апдейт бесконечно');
  globalThis.fetch = realFetch;
});

// ── Запуск ──────────────────────────────────────────────────────────────────
const quiet = console.error;
console.error = () => {};                    // ожидаемые логи ошибок не мешают выводу
for (const [name, fn] of tests) {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message.split('\n')[0]}`); }
}
console.error = quiet;
console.log(failed ? `\n${failed} из ${tests.length} провалено` : `\nвсе ${tests.length} проверок пройдены`);
process.exit(failed ? 1 : 0);
