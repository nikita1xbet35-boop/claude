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
    system_config: [{ key: 'geo_pdf_url', value: '' }],
    // Вымышленные строки: проверяем механику, а не содержимое справочника —
    // настоящие данные приходят из PDF. Niger рядом с Nigeria здесь намеренно:
    // именно эта пара ловит подмену при опечатке.
    geo_availability: [
      { id:1, geo_en:'Nigeria', geo_ru:'Нигерия', iso_code:'NG', region:'Africa',
        availability:'available', note:'Special commission scale — confirm with manager' },
      { id:2, geo_en:'Niger', geo_ru:'Нигер', iso_code:'NE', region:'Africa',
        availability:'not_available', note:null },
      { id:3, geo_en:'United Arab Emirates', geo_ru:'ОАЭ', iso_code:'AE', region:'MENA',
        availability:'local_program_only', note:'Local licence' },
      { id:4, geo_en:'Uzbekistan', geo_ru:'Узбекистан', iso_code:'UZ', region:'CIS',
        availability:'confirm_with_manager', note:null },
    ],
    geo_aliases: [{ alias:'uae', iso_code:'AE' }],
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

// NOT NULL из схемы 048/051. Заглушка обязана это проверять: без проверки
// пропущена настоящая авария — setAwaiting вставлял строку bot_user_prefs без
// lang, и /start молча падал у каждого, кто ещё не менял язык.
const NOT_NULL = {
  bot_user_prefs: ['bot_slug','tg_user_id','lang'],
  bot_leads: ['bot_slug','tg_user_id','lang','ref_code'],
  geo_availability: ['geo_en','geo_ru','iso_code','region','availability'],
};

// Ключи, по которым строка считается той же самой (аналог UNIQUE в 048).
const PK = {
  bot_leads: ['bot_slug','tg_user_id'],
  bot_user_prefs: ['bot_slug','tg_user_id'],
  bot_faq: ['lang','key'],
  bot_configs: ['slug'],
  system_config: ['key'],
  geo_availability: ['id'],
  geo_aliases: ['alias'],
};

// Триграммное сходство — грубая реализация ровно для тестов. Настоящий поиск
// живёт в Postgres (fn_find_geo / fn_suggest_geo, миграция 051); здесь важно
// воспроизвести ПОРЯДОК «точное → синоним → кандидаты», а не сами числа.
function trigrams(x) {
  const p = '  ' + x + ' ';
  const out = new Set();
  for (let i = 0; i < p.length - 2; i++) out.add(p.slice(i, i + 3));
  return out;
}
function similarity(a, b) {
  const A = trigrams(a), B = trigrams(b);
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}

function fakeRpc(db, fn, body) {
  const q = String(body.q || '').trim().toLowerCase();
  if (!q) return [];

  if (fn === 'fn_find_geo') {
    const exact = db.geo_availability.find(g =>
      g.geo_en.toLowerCase() === q || g.geo_ru.toLowerCase() === q || g.iso_code.toLowerCase() === q);
    if (exact) return [{ ...exact, match: 'exact' }];
    const alias = db.geo_aliases.find(a => a.alias === q);
    if (alias) {
      const g = db.geo_availability.find(x => x.iso_code.toLowerCase() === alias.iso_code.toLowerCase());
      if (g) return [{ ...g, match: 'alias' }];
    }
    return [];   // приблизительное совпадение ответом НЕ становится
  }

  if (fn === 'fn_suggest_geo') {
    return db.geo_availability
      .map(g => ({ id:g.id, geo_en:g.geo_en, iso_code:g.iso_code,
                   score: Math.max(similarity(g.geo_en.toLowerCase(), q),
                                   similarity(g.geo_ru.toLowerCase(), q)),
                   pref: g.geo_en.toLowerCase().startsWith(q) || g.geo_ru.toLowerCase().startsWith(q) }))
      .filter(x => x.score > 0.25 || x.pref)
      .sort((a,b) => (b.pref - a.pref) || (b.score - a.score))
      .slice(0, body.n || 3);
  }
  throw new Error(`тест: RPC ${fn} не реализован`);
}

function fakeSupabase(db, url, init) {
  const u = new URL(url);
  const table = u.pathname.replace('/rest/v1/', '');
  const params = [...u.searchParams.entries()];
  const method = init.method || 'GET';
  if (table.startsWith('rpc/')) {
    const out = fakeRpc(db, table.slice(4), JSON.parse(init.body || '{}'));
    return new Response(JSON.stringify(out), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

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
    // NOT NULL проверяется только на ВСТАВКЕ: upsert существующей строки
    // обновляет лишь переданные колонки, остальные сохраняются.
    if (!existing) {
      for (const col of (NOT_NULL[table] || [])) {
        if (body[col] === undefined || body[col] === null) {
          return new Response(
            JSON.stringify({ code:'23502', message:`null value in column "${col}" violates not-null constraint` }),
            { status: 400 });
        }
      }
    }
    if (existing) {
      if (!merge) return new Response('duplicate key', { status: 409 });
      Object.assign(existing, body);          // как ON CONFLICT DO UPDATE
    } else {
      rows.push({ id: db._seq++, reminder_sent: false, status: 'link_issued',
                  link_issued_at: new Date().toISOString(), ...body });
    }
    // PostgREST на POST-upsert отвечает 201 и ПУСТЫМ телом, а не 204.
    // Заглушка возвращала 204, и из-за этого тесты не ловили самую дорогую
    // ошибку сессии: sb() звал res.json() на пустом теле, падал с
    // «Unexpected end of JSON input», и /start молчал во всех шести ботах.
    return new Response('', { status: 201 });
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

// Регрессия. /start молча переставал отвечать всем, у кого не было строки в
// bot_user_prefs — то есть всем, кто не менял язык. setAwaiting вставлял строку
// без lang (NOT NULL), запрос падал, ошибку глотал обработчик, Telegram получал
// 200, приветствие не уходило. Заглушка тогда NOT NULL не проверяла и всё
// пропустила; теперь проверяет, а эти два теста стоят на страже.
test('/start отвечает человеку, которого ещё нет в bot_user_prefs', async () => {
  const h = await harness();
  assert.strictEqual(h.db.bot_user_prefs.length, 0, 'предпосылка: строки нет');
  await h.post('india', h.msg('/start'));
  assert.strictEqual(h.sent.length, 1, '/start обязан ответить, а не молчать');
  assert.match(h.last().text, /Welcome to the 1xBet/);
});

test('повторный /start работает и после диалога', async () => {
  const h = await harness();
  await h.post('india', h.msg('/start'));
  await h.post('india', h.msg('🌍 Check GEO'));
  await h.post('india', h.cb('geo:country'));
  await h.post('india', h.msg('Nigeria'));
  h.sent.length = 0;
  await h.post('india', h.msg('/start'));
  assert.strictEqual(h.sent.length, 1);
  assert.match(h.last().text, /Welcome to the 1xBet/);
});

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

test('шаблон без {ref} отдаётся как есть и лид всё равно пишется', async () => {
  const h = await harness();
  // Реальная конфигурация после 050: сокращённая реф-ссылка, к которой ничего
  // дописывать не нужно.
  h.db.bot_configs[0].signup_url_tpl = 'https://1xaffiliate.org/newreg';
  await h.post('india', h.msg('🔗 Get Registration Link'));
  assert.match(h.last().text, /https:\/\/1xaffiliate\.org\/newreg/);
  assert.doesNotMatch(h.last().text, /\{ref\}|\?ref=/,
    'ни плейсхолдер, ни самодельный параметр не должны попасть в ссылку');
  // Привязка «кому выдали» живёт в bot_leads, а не в адресе.
  assert.strictEqual(h.db.bot_leads.length, 1);
  assert.strictEqual(h.db.bot_leads[0].ref_code, 'tg_india_42');
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

// Регрессия на самую дорогую ошибку сессии: PostgREST отвечает на upsert
// 201 с ПУСТЫМ телом, sb() звал res.json() и падал, ошибку глотал обработчик,
// Telegram получал 200 — и все шесть ботов молчали, не оставив следа.
test('пустое тело ответа Supabase не роняет обработчик', async () => {
  const h = await harness();
  const real = globalThis.fetch;
  // Отвечаем пустым телом на ВСЕ коды, какие PostgREST реально использует.
  for (const status of [200, 201, 204]) {
    globalThis.fetch = async (input, init = {}) => {
      const u = typeof input === 'string' ? input : input.url;
      if (u.startsWith(SUPA) && (init.method || 'GET') !== 'GET') {
        // 204 по спецификации не может нести тело — Response с телом и 204
        // бросает TypeError ещё в самом тесте.
        return new Response(status === 204 ? null : '', { status });
      }
      return real(input, init);
    };
    h.sent.length = 0;
    await h.post('india', h.msg('/start'));
    assert.strictEqual(h.sent.length, 1, `статус ${status}: бот обязан ответить`);
    assert.match(h.last().text, /Welcome to the 1xBet/, `статус ${status}`);
  }
  globalThis.fetch = real;
});

test('нечитаемое тело даёт понятную ошибку, а не «Unexpected end of JSON»', async () => {
  const h = await harness();
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const u = typeof input === 'string' ? input : input.url;
    if (u.includes('/rest/v1/bot_configs')) return new Response('<html>502</html>', { status: 200 });
    return real(input, init);
  };
  const res = await h.worker.fetch(new Request('https://x.test/selftest/india', {
    method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'shh' },
    body: JSON.stringify({ text: '/start' }),
  }), h.env, { waitUntil: p => p });
  globalThis.fetch = real;
  const j = await res.json();
  assert.match(j.error, /не разобралось как JSON/, j.error);
});

// ── Сквозной самотест ───────────────────────────────────────────────────────
// Проверяем сам инструмент проверки: если /selftest врёт, он хуже, чем ничего.

test('/selftest прогоняет настоящий /start и возвращает отправленное', async () => {
  const h = await harness();
  const res = await h.worker.fetch(new Request('https://x.test/selftest/india', {
    method: 'POST',
    headers: { 'X-Telegram-Bot-Api-Secret-Token': 'shh' },
    body: JSON.stringify({ text: '/start' }),
  }), h.env, { waitUntil: p => p });
  assert.strictEqual(res.status, 200);
  const j = await res.json();
  assert.strictEqual(j.ok, true, JSON.stringify(j));
  assert.strictEqual(j.sent[0].method, 'sendMessage');
  assert.match(j.sent[0].text, /Welcome to the 1xBet/);
  assert.strictEqual(j.sent[0].reply_markup.keyboard.flat().length, 4, 'четыре кнопки');
});

test('/selftest НЕ отправляет ничего в Telegram по-настоящему', async () => {
  const h = await harness();
  await h.worker.fetch(new Request('https://x.test/selftest/india', {
    method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'shh' },
    body: JSON.stringify({ text: '/start' }),
  }), h.env, { waitUntil: p => p });
  assert.strictEqual(h.sent.length, 0, 'приёмник должен перехватывать, а не слать');
});

test('/selftest закрыт секретом', async () => {
  const h = await harness();
  const res = await h.worker.fetch(new Request('https://x.test/selftest/india', {
    method: 'POST', body: JSON.stringify({ text: '/start' }),
  }), h.env, { waitUntil: p => p });
  assert.strictEqual(res.status, 401);
});

test('/selftest сообщает об ошибке, а не глотает её', async () => {
  const h = await harness();
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const u = typeof input === 'string' ? input : input.url;
    if (u.includes('/rest/v1/bot_user_prefs')) return new Response('boom', { status: 500 });
    return real(input, init);
  };
  const res = await h.worker.fetch(new Request('https://x.test/selftest/india', {
    method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'shh' },
    body: JSON.stringify({ text: '/start' }),
  }), h.env, { waitUntil: p => p });
  globalThis.fetch = real;
  assert.strictEqual(res.status, 500);
  const j = await res.json();
  assert.strictEqual(j.ok, false);
  assert.match(j.error, /bot_user_prefs/, 'в ответе должна быть причина: ' + j.error);
});

test('/selftest умеет прогонять и кнопки', async () => {
  const h = await harness();
  const res = await h.worker.fetch(new Request('https://x.test/selftest/india', {
    method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'shh' },
    body: JSON.stringify({ callback_data: 'geo:country' }),
  }), h.env, { waitUntil: p => p });
  const j = await res.json();
  assert.strictEqual(j.ok, true, JSON.stringify(j));
  assert.ok(j.sent.some(m => /Type the country name/.test(m.text || '')), JSON.stringify(j.sent));
});

// ── Check GEO ───────────────────────────────────────────────────────────────

test('меню содержит все четыре кнопки в порядке из ТЗ', async () => {
  const h = await harness();
  await h.post('india', h.msg('/start'));
  const kb = h.last().reply_markup.keyboard;
  assert.deepStrictEqual(kb.map(r => r.map(b => b.text)), [
    ['🔗 Get Registration Link', '🌍 Check GEO'],
    ['❓ FAQ', '👤 Talk to Manager'],
  ]);
});

test('Check GEO предлагает выбор: страна или полный список', async () => {
  const h = await harness();
  await h.post('india', h.msg('🌍 Check GEO'));
  const kb = h.last().reply_markup.inline_keyboard[0];
  assert.deepStrictEqual(kb.map(b => b.callback_data), ['geo:country', 'geo:pdf']);
});

test('/check_geo работает как команда, не только кнопкой', async () => {
  const h = await harness();
  await h.post('india', h.msg('/check_geo'));
  assert.match(h.last().text, /check a specific country/i);
});

test('точное совпадение: статус и примечание из справочника', async () => {
  const h = await harness();
  await h.post('india', h.cb('geo:country'));
  await h.post('india', h.msg('Nigeria'));
  assert.match(h.last().text, /✅ Nigeria — available\./);
  assert.match(h.last().text, /Special commission scale/, 'note должен попасть в ответ');
});

test('три остальных статуса формулируются по-разному', async () => {
  const h = await harness();
  await h.post('india', h.cb('geo:country'));
  await h.post('india', h.msg('Niger'));
  assert.match(h.last().text, /❌ Niger — not available\./);
  await h.post('india', h.msg('United Arab Emirates'));
  assert.match(h.last().text, /⚠️.*local affiliate program/);
  assert.match(h.last().text, /Local licence/);
  await h.post('india', h.msg('Uzbekistan'));
  assert.match(h.last().text, /❓ Uzbekistan availability depends on current terms/);
  assert.match(h.last().text, /@aff_manager_xbet/);
});

test('поиск по ISO-коду и по русскому названию', async () => {
  const h = await harness();
  await h.post('india', h.cb('geo:country'));
  await h.post('india', h.msg('NG'));
  assert.match(h.last().text, /✅ Nigeria/);
  await h.post('india', h.msg('Нигерия'));
  assert.match(h.last().text, /✅ Nigeria/);
});

test('синоним UAE находит United Arab Emirates', async () => {
  const h = await harness();
  await h.post('india', h.cb('geo:country'));
  await h.post('india', h.msg('UAE'));
  assert.match(h.last().text, /United Arab Emirates/);
});

test('ОПЕЧАТКА НЕ ДАЁТ УВЕРЕННОГО ОТВЕТА — бот переспрашивает', async () => {
  const h = await harness();
  await h.post('india', h.cb('geo:country'));
  await h.post('india', h.msg('Nigeira'));
  // Главное: НЕ утверждение про Нигер, к которому опечатка ближе по триграммам.
  assert.doesNotMatch(h.last().text, /not available|available\./,
    'приблизительное совпадение не должно превращаться в ответ о доступности');
  assert.match(h.last().text, /Did you mean/);
  const opts = h.last().reply_markup.inline_keyboard.flat().map(b => b.text);
  assert.ok(opts.includes('Nigeria') && opts.includes('Niger'),
    'оба кандидата должны быть предложены: ' + opts.join(', '));
});

test('выбор кандидата даёт точный ответ', async () => {
  const h = await harness();
  await h.post('india', h.cb('geo:country'));
  await h.post('india', h.msg('Nigeira'));
  const btn = h.last().reply_markup.inline_keyboard.flat().find(b => b.text === 'Nigeria');
  await h.post('india', h.cb(btn.callback_data));
  assert.match(h.last().text, /✅ Nigeria — available/);
});

test('неизвестная страна: вежливый отказ, а не падение', async () => {
  const h = await harness();
  await h.post('india', h.cb('geo:country'));
  await h.post('india', h.msg('qwerty123'));
  assert.match(h.last().text, /Couldn't find "qwerty123"/);
});

test('пустой справочник отличается от ненайденной страны', async () => {
  const h = await harness();
  h.db.geo_availability.length = 0;
  h.db.geo_aliases.length = 0;
  await h.post('india', h.cb('geo:country'));
  await h.post('india', h.msg('Nigeria'));
  assert.match(h.last().text, /directory hasn't been uploaded yet/);
  assert.match(h.last().text, /@aff_manager_xbet/);
});

test('режим проверки не сбрасывается после одного ответа', async () => {
  const h = await harness();
  await h.post('india', h.cb('geo:country'));
  await h.post('india', h.msg('Nigeria'));
  await h.post('india', h.msg('Niger'));
  assert.match(h.last().text, /❌ Niger/, 'вторая страна должна искаться без повторного входа в режим');
});

test('кнопка меню выводит из режима проверки', async () => {
  const h = await harness();
  await h.post('india', h.cb('geo:country'));
  await h.post('india', h.cb('geo:exit'));
  assert.match(h.last().text, /Welcome to the 1xBet/);
  await h.post('india', h.msg('Nigeria'));
  assert.match(h.last().text, /Welcome to the 1xBet/,
    'после выхода текст снова трактуется как «не понял», а не как страна');
});

test('кнопки меню работают, даже когда ждём название страны', async () => {
  const h = await harness();
  await h.post('india', h.cb('geo:country'));
  await h.post('india', h.msg('👤 Talk to Manager'));
  assert.match(h.last().text, /Message your manager directly/,
    'нажатие кнопки не должно искаться как страна');
});

test('PDF по умолчанию берётся со своего же адреса', async () => {
  const h = await harness();
  await h.post('india', h.cb('geo:pdf'));
  assert.strictEqual(h.last().method, 'sendDocument');
  assert.strictEqual(h.last().document, 'https://x.test/geo.pdf',
    'адрес должен строиться из origin запроса, а не угадываться по имени воркера');
});

test('настроенный URL важнее адреса по умолчанию', async () => {
  const h = await harness();
  h.db.system_config[0].value = 'https://files.example/geo.pdf';
  await h.post('india', h.cb('geo:pdf'));
  assert.strictEqual(h.last().method, 'sendDocument');
  assert.strictEqual(h.last().document, 'https://files.example/geo.pdf');
});

test('Check GEO говорит на языке бота', async () => {
  const h = await harness();
  await h.post('afrique', h.msg('/check_geo'));
  assert.match(h.last().text, /Souhaitez-vous vérifier un pays/);
  await h.post('uzbekistan', h.msg('/check_geo'));
  assert.match(h.last().text, /davlatni tekshirmoqchimisiz/i);
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
