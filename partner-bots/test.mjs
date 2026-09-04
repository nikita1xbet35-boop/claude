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
      { slug:'ru', geo_label:'Russian-speaking', default_lang:'ru', manager_contact:'@aff_manager_xbet', signup_url_tpl:'', active:true },
      { slug:'latam', geo_label:'Latin America', default_lang:'es', manager_contact:'@aff_manager_xbet', signup_url_tpl:'', active:true },
    ],
    bot_leads: [],
    bot_user_prefs: [],
    bot_user_events: [],
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
      { lang:'ru', key:'payouts',  question:'💵 Выплаты',        answer:'', sort_order:1 },
      { lang:'es', key:'payouts',  question:'💵 Pagos',          answer:'', sort_order:1 },
    ],
    _seq: 1,
  };
}

const OPS = {
  eq:  (a,b) => String(a) === b,
  neq: (a,b) => String(a) !== b,
  lt:  (a,b) => String(a) < b,
  // gt сравнивает ЧИСЛА, когда обе стороны числовые: воркер фильтрует
  // tg_user_id=gt.0, чтобы выкинуть из статистики самотест с id -1, а строковое
  // сравнение '-1' > '0' даёт не тот ответ по случайности, а не по смыслу.
  gt:  (a,b) => (isFinite(a) && isFinite(b) ? Number(a) > Number(b) : String(a) > String(b)),
};

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
  bot_user_events: ['bot_slug','tg_user_id','event'],
  bot_leads: ['bot_slug','tg_user_id','lang','ref_code'],
  geo_availability: ['geo_en','geo_ru','iso_code','region','availability'],
};

// Ключи, по которым строка считается той же самой (аналог UNIQUE в 048).
const PK = {
  bot_leads: ['bot_slug','tg_user_id'],
  bot_user_prefs: ['bot_slug','tg_user_id'],
  bot_faq: ['lang','key'],
  bot_configs: ['slug'],
  bot_user_events: ['id'],
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
  return null;   // не гео-RPC — разбирается ниже
}

function fakeFunnelRpc(db, body) {
  const since = body.p_since ? new Date(body.p_since).getTime() : null;
  return db.bot_configs.map(c => {
    const ev = db.bot_user_events.filter(e =>
      e.bot_slug === c.slug && e.tg_user_id > 0 &&
      (since === null || new Date(e.created_at || Date.now()).getTime() >= since));
    const uniq = (name) => new Set(ev.filter(e => e.event === name).map(e => e.tg_user_id)).size;
    return { bot_slug: c.slug, geo_label: c.geo_label,
             starts: uniq('start'), links: uniq('link_issued'), managers: uniq('manager_clicked') };
  }).sort((a,b) => b.starts - a.starts);
}

function fakeSupabase(db, url, init) {
  const u = new URL(url);
  const table = u.pathname.replace('/rest/v1/', '');
  const params = [...u.searchParams.entries()];
  const method = init.method || 'GET';
  if (table.startsWith('rpc/')) {
    const fn = table.slice(4);
    const body = JSON.parse(init.body || '{}');
    const out = fn === 'fn_bot_funnel' ? fakeFunnelRpc(db, body) : fakeRpc(db, fn, body);
    if (out === null) throw new Error(`тест: RPC ${fn} не реализован`);
    return new Response(JSON.stringify(out), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  const rows = db[table];
  if (!rows) throw new Error(`тест: нет таблицы ${table}`);

  if (method === 'GET') {
    let out = applyFilters(rows, params);
    const order = u.searchParams.get('order');
    if (order) {
      // PostgREST пишет order=col.desc — без разбора суффикса заглушка
      // сортировала по несуществующей колонке 'created_at.desc' и возвращала
      // произвольный порядок, а /last именно порядком и ценен.
      const [col, dir] = order.split('.');
      const sign = dir === 'desc' ? -1 : 1;
      out = [...out].sort((a,b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * sign);
    }
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
                  admin_status: 'new', created_at: new Date().toISOString(),
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
      sent.push({ method, __admin: url.includes('/bottok-admin/'), ...payload });
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
    BOT_TOKEN_RU: 'tok-ru', BOT_TOKEN_LATAM: 'tok-es',
    ADMIN_BOT_TOKEN: 'tok-admin', ADMIN_CHAT_ID: '777', ADMIN_TZ_OFFSET: '2',
  };

  const post = (slug, update, secret = 'shh') =>
    worker.fetch(new Request(`https://x.test/bot/${slug}`, {
      method: 'POST',
      headers: secret === null ? {} : { 'X-Telegram-Bot-Api-Secret-Token': secret },
      body: JSON.stringify(update),
    }), env, { waitUntil: p => p });

  // Апдейт админ-боту. from.id по умолчанию совпадает с ADMIN_CHAT_ID.
  const admin = (update, secret = 'shh') =>
    worker.fetch(new Request('https://x.test/admin-bot', {
      method: 'POST',
      headers: secret === null ? {} : { 'X-Telegram-Bot-Api-Secret-Token': secret },
      body: JSON.stringify(update),
    }), env, { waitUntil: p => p });
  const acmd = (text, fromId = 777) => ({ message: { chat: { id: fromId }, from: { id: fromId }, text } });

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

  // Сообщения админ-бота отличаются по токену в адресе: в общий журнал sent
  // они попадают вперемешку с пользовательскими, и без разделения проверки
  // цеплялись бы не за те строки.
  const adminSent = () => sent.filter(m => m.__admin);
  return { db, sent, env, worker, post, msg, cb, runCron, admin, acmd, adminSent,
           last: () => sent[sent.length - 1] };
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
  // Считать штуки больше нельзя: на /start теперь уходит ещё и уведомление
  // админ-боту. Проверяем не количество, а факт — человек получил приветствие.
  const toUser = h.sent.filter(m => !m.__admin);
  assert.strictEqual(toUser.length, 1, '/start обязан ответить, а не молчать');
  assert.match(toUser[0].text, /Welcome to the 1xBet/);
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

test('/start отвечает на языке бота: en / fr / uz / ru / es', async () => {
  const h = await harness();
  await h.post('india', h.msg('/start'));
  assert.match(h.last().text, /Welcome to the 1xBet Affiliate Program/);
  await h.post('afrique', h.msg('/start'));
  assert.match(h.last().text, /Bienvenue dans le programme/);
  await h.post('uzbekistan', h.msg('/start'));
  assert.match(h.last().text, /xush kelibsiz/);
  await h.post('ru', h.msg('/start'));
  assert.match(h.last().text, /партнёрскую программу 1xBet/);
  await h.post('latam', h.msg('/start'));
  assert.match(h.last().text, /programa de afiliados de 1xBet/);
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
    // Считаем только адресованное человеку: рядом идёт уведомление админ-боту,
    // и его наличие или отсутствие к этой регрессии отношения не имеет.
    const toUser = h.sent.filter(m => !m.__admin);
    assert.strictEqual(toUser.length, 1, `статус ${status}: бот обязан ответить`);
    assert.match(toUser[0].text, /Welcome to the 1xBet/, `статус ${status}`);
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
  // В приёмник попадает и уведомление админ-боту, поэтому ищем сообщение
  // пользователю по признаку, а не по номеру.
  const greet = j.sent.find(m => m.method === 'sendMessage' && !m.admin);
  assert.ok(greet, 'приветствие пользователю не отправлено: ' + JSON.stringify(j.sent));
  assert.match(greet.text, /Welcome to the 1xBet/);
  assert.strictEqual(greet.reply_markup.keyboard.flat().length, 4, 'четыре кнопки');
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

// ── Два новых бота: ru и latam ──────────────────────────────────────────────
// Кода они не добавляют, поэтому проверяется не «работает ли обработчик», а
// ровно то, что при добавлении языка ломается: неполный словарь и забытая
// кнопка в /lang.

test('русский бот: меню, ссылка и FAQ на русском', async () => {
  const h = await harness();
  h.db.bot_configs.find(c => c.slug==='ru').signup_url_tpl = 'https://p.example/newreg';
  await h.post('ru', h.msg('/start'));
  const kb = h.last().reply_markup.keyboard;
  assert.deepStrictEqual(kb.map(r => r.length), [2,2], 'четыре кнопки в двух рядах');
  assert.match(kb[0][1].text, /Проверить ГЕО/);
  await h.post('ru', h.msg('🔗 Получить ссылку для регистрации'));
  assert.match(h.last().text, /https:\/\/p\.example\/newreg/);
  assert.strictEqual(h.db.bot_leads[0].bot_slug, 'ru');
  assert.strictEqual(h.db.bot_leads[0].lang, 'ru');
});

test('LATAM-бот отвечает по-испански', async () => {
  const h = await harness();
  h.db.bot_configs.find(c => c.slug==='latam').signup_url_tpl = 'https://p.example/newreg';
  await h.post('latam', h.msg('/start'));
  assert.match(h.last().reply_markup.keyboard[0][1].text, /Consultar GEO/);
  await h.post('latam', h.msg('🔗 Obtener enlace de registro'));
  assert.match(h.last().text, /enlace personal de registro/);
  assert.strictEqual(h.db.bot_leads[0].lang, 'es');
});

test('/lang предлагает все пять языков и каждый выбирается', async () => {
  const h = await harness();
  await h.post('india', h.msg('/lang'));
  const rows = h.last().reply_markup.inline_keyboard;
  const codes = rows.flat().map(b => b.callback_data.slice(5)).sort();
  assert.deepStrictEqual(codes, ['en','es','fr','ru','uz']);
  assert.ok(rows.every(r => r.length <= 2), 'не больше двух кнопок в ряд');

  // Кнопка, которая не переключает язык, выглядит рабочей и ничего не делает —
  // проверяем каждую, а не одну.
  for (const code of codes) {
    await h.post('india', h.cb(`lang:${code}`));
    assert.strictEqual(h.db.bot_user_prefs[0].lang, code, `lang:${code} не сохранился`);
  }
});

// Забытый ключ в языковом словаре виден снаружи как слово undefined в тексте
// бота — и только на том языке, который никто из нас не читает. Прогоняем весь
// сценарий на каждом языке и ищем именно это.
test('ни один язык не даёт undefined в текстах и кнопках', async () => {
  for (const lang of ['en','fr','uz','ru','es']) {
    const h = await harness();
    h.db.bot_configs[0].signup_url_tpl = 'https://p.example/newreg';
    await h.post('india', h.cb(`lang:${lang}`));
    h.sent.length = 0;

    await h.post('india', h.msg('/start'));
    const kb = h.last().reply_markup.keyboard;
    await h.post('india', h.msg(kb[0][0].text));      // ссылка
    await h.post('india', h.msg(kb[0][1].text));      // Check GEO
    await h.post('india', h.cb('geo:country'));
    await h.post('india', h.msg('Nigeria'));
    await h.post('india', h.msg('Nigeira'));          // «вы имели в виду»
    await h.post('india', h.msg('Atlantis'));         // ничего не найдено
    await h.post('india', h.cb('geo:pdf'));
    await h.post('india', h.msg(kb[1][0].text));      // FAQ
    await h.post('india', h.cb('faq:payouts'));       // ответ не заполнен
    await h.post('india', h.msg(kb[1][1].text));      // менеджер
    await h.post('india', h.msg('/lang'));

    // Проверять только подстроку 'undefined' в JSON НЕДОСТАТОЧНО, и это ровно
    // тот случай, когда проверка выглядит рабочей и ничего не ловит:
    // JSON.stringify выбрасывает поля со значением undefined целиком. Убранный
    // ключ словаря даёт не текст «undefined», а сообщение БЕЗ поля text —
    // Telegram ответит на такое ошибкой, а бот снаружи промолчит. Поэтому
    // сначала смотрим, что текст вообще есть.
    for (const m of h.sent) {
      if (m.method === 'sendMessage') {
        assert.ok(typeof m.text === 'string' && m.text.trim(),
          `${lang}: sendMessage без текста — пропущен ключ в словаре языка`);
      }
      const btns = [
        ...((m.reply_markup && m.reply_markup.keyboard) || []).flat(),
        ...((m.reply_markup && m.reply_markup.inline_keyboard) || []).flat(),
      ];
      for (const b of btns) {
        assert.ok(typeof b.text === 'string' && b.text.trim(),
          `${lang}: кнопка без подписи`);
      }
    }

    const dump = JSON.stringify(h.sent);
    assert.ok(!dump.includes('undefined'), `${lang}: в ответах бота есть undefined`);
    assert.ok(!dump.includes('[object Object]'), `${lang}: в ответах бота есть [object Object]`);
  }
});

// ── Админ-бот ───────────────────────────────────────────────────────────────

test('первый /start пишет событие и шлёт уведомление Нику', async () => {
  const h = await harness();
  await h.post('india', h.msg('/start'));
  const ev = h.db.bot_user_events.filter(e => e.event === 'start');
  assert.strictEqual(ev.length, 1, 'событие start не записано');
  const a = h.adminSent();
  assert.strictEqual(a.length, 1, 'уведомление не ушло');
  assert.strictEqual(String(a[0].chat_id), '777', 'ушло не Нику');
  assert.match(a[0].text, /Новый пользователь/);
  assert.match(a[0].text, /@nick/);
  assert.match(a[0].text, /India \(india\)/);
});

test('повторный /start в том же боте уведомления не шлёт', async () => {
  const h = await harness();
  await h.post('india', h.msg('/start'));
  await h.post('india', h.msg('/start'));
  assert.strictEqual(h.adminSent().length, 1, 'второе уведомление лишнее');
  // Но событие пишется каждый раз: карточка /user должна показывать все заходы.
  assert.strictEqual(h.db.bot_user_events.filter(e => e.event === 'start').length, 2);
});

test('тот же человек в другом боте — уведомление с пометкой о прежнем', async () => {
  const h = await harness();
  await h.post('ru', h.msg('/start'));
  await h.post('india', h.msg('/start'));
  const a = h.adminSent();
  assert.strictEqual(a.length, 2);
  assert.match(a[1].text, /уже был в/, 'нет пометки о прежнем боте');
  assert.match(a[1].text, /Russian-speaking \(ru\)/);
});

test('кнопка «Написать»: t.me при юзернейме, tg://user без него', async () => {
  const h = await harness();
  await h.post('india', h.msg('/start', 42, 'nick'));
  const withName = h.adminSent()[0].reply_markup.inline_keyboard[0][0];
  assert.strictEqual(withName.url, 'https://t.me/nick');

  const h2 = await harness();
  await h2.post('india', { message: { chat: { id: 43 }, from: { id: 43 }, text: '/start' } });
  const noName = h2.adminSent()[0].reply_markup.inline_keyboard[0][0];
  assert.strictEqual(noName.url, 'tg://user?id=43');
  assert.match(h2.adminSent()[0].text, /без username/);
});

test('кнопка статуса меняет статус и НЕ трогает выбранный язык', async () => {
  const h = await harness();
  await h.post('india', h.cb('lang:fr'));                      // человек выбрал французский
  await h.post('india', h.msg('/start'));
  await h.admin({ callback_query: { id: 'c1', from: { id: 777 }, data: 'st:in_work:india:42',
                                    message: { chat: { id: 777 }, message_id: 5 } } });
  const pref = h.db.bot_user_prefs.find(p => p.tg_user_id === 42 && p.bot_slug === 'india');
  assert.strictEqual(pref.admin_status, 'in_work');
  assert.strictEqual(pref.lang, 'fr', 'пометка статуса затёрла язык пользователя');
  assert.ok(h.db.bot_user_events.some(e => e.event === 'status_changed' && e.detail === 'in_work'));
  // Клавиатура перерисовывается на том же сообщении, а не шлётся новым.
  assert.ok(h.adminSent().some(m => m.method === 'editMessageReplyMarkup' && m.message_id === 5));
});

test('/stats и /today считают по реальным событиям', async () => {
  const h = await harness();
  await h.post('india', h.msg('/start', 1, 'a'));
  await h.post('india', h.msg('/start', 2, 'b'));
  await h.post('ru',    h.msg('/start', 3, 'c'));
  h.db.bot_configs.find(c => c.slug === 'india').signup_url_tpl = 'https://p.example/newreg';
  await h.post('india', h.msg('🔗 Get Registration Link', 1, 'a'));
  await h.post('india', h.msg('👤 Talk to Manager', 2, 'b'));

  await h.admin(h.acmd('/stats'));
  const t = h.adminSent().slice(-1)[0].text;
  assert.match(t, /India \(india\)/);
  assert.match(t, /2 новых · 1 ссылок · 1 менеджер/);
  assert.match(t, /Итого:<\/b> 3 новых · 1 ссылок \(33%\) · 1 менеджер \(33%\)/);

  await h.admin(h.acmd('/today'));
  assert.match(h.adminSent().slice(-1)[0].text, /Сегодня/);
});

test('боты с нулём в сводку не попадают', async () => {
  const h = await harness();
  await h.post('india', h.msg('/start'));
  await h.admin(h.acmd('/stats'));
  const t = h.adminSent().slice(-1)[0].text;
  assert.match(t, /India/);
  assert.ok(!/Uzbekistan/.test(t), 'бот без событий не должен раздувать сводку');
});

test('/user находит и по юзернейму, и по id, показывает историю', async () => {
  const h = await harness();
  await h.post('india', h.msg('/start', 55, 'partner55'));
  await h.post('india', h.msg('❓ FAQ', 55, 'partner55'));

  await h.admin(h.acmd('/user @partner55'));
  const byName = h.adminSent().slice(-1)[0].text;
  assert.match(byName, /@partner55/);
  assert.match(byName, /55/);
  assert.match(byName, /открыл FAQ/);

  await h.admin(h.acmd('/user 55'));
  assert.match(h.adminSent().slice(-1)[0].text, /открыл FAQ/);

  await h.admin(h.acmd('/user @нетутакого'));
  assert.match(h.adminSent().slice(-1)[0].text, /Не нашёл/);
});

test('/last показывает последних в обратном порядке', async () => {
  const h = await harness();
  for (const [id, name] of [[1,'a'],[2,'b'],[3,'c']]) {
    await h.post('india', h.msg('/start', id, name));
    await new Promise(r => setTimeout(r, 2));   // чтобы created_at различались
  }
  await h.admin(h.acmd('/last 2'));
  const t = h.adminSent().slice(-1)[0].text;
  assert.match(t, /Последние 2/);
  assert.ok(t.indexOf('@c') < t.indexOf('@b'), 'порядок не от новых к старым');
  assert.ok(!/@a/.test(t), 'лимит не соблюдён');
});

test('посторонний chat_id игнорируется молча', async () => {
  const h = await harness();
  const res = await h.admin(h.acmd('/stats', 999999));
  assert.strictEqual(res.status, 200, 'Telegram должен получить 200');
  assert.strictEqual(h.adminSent().length, 0, 'постороннему нельзя отвечать ничем');
});

test('админ-роут без секрета — 401', async () => {
  const h = await harness();
  assert.strictEqual((await h.admin(h.acmd('/stats'), null)).status, 401);
  assert.strictEqual((await h.admin(h.acmd('/stats'), 'wrong')).status, 401);
});

test('сбой записи события не ломает /start для человека', async () => {
  const h = await harness();
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const u = typeof input === 'string' ? input : input.url;
    if (u.includes('/rest/v1/bot_user_events')) return new Response('boom', { status: 500 });
    return real(input, init);
  };
  const res = await h.post('india', h.msg('/start'));
  globalThis.fetch = real;
  assert.strictEqual(res.status, 200);
  const toUser = h.sent.filter(m => !m.__admin);
  assert.strictEqual(toUser.length, 1, 'человек остался без приветствия из-за журнала');
  assert.match(toUser[0].text, /Welcome to the 1xBet/);
});

test('события пишутся на все действия', async () => {
  const h = await harness();
  h.db.bot_configs[0].signup_url_tpl = 'https://p.example/newreg';
  await h.post('india', h.msg('/start'));
  await h.post('india', h.msg('🔗 Get Registration Link'));
  await h.post('india', h.msg('❓ FAQ'));
  await h.post('india', h.msg('🌍 Check GEO'));
  await h.post('india', h.msg('👤 Talk to Manager'));
  await h.post('india', h.cb('lang:ru'));
  const kinds = new Set(h.db.bot_user_events.map(e => e.event));
  for (const k of ['start','link_issued','faq_opened','geo_checked','manager_clicked','lang_changed']) {
    assert.ok(kinds.has(k), `не записано событие ${k}`);
  }
});

test('самотест деплоя не пишет Нику', async () => {
  const h = await harness();
  const res = await h.worker.fetch(new Request('https://x.test/selftest/india', {
    method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'shh' },
    body: JSON.stringify({ text: '/start' }),
  }), h.env, { waitUntil: p => p });
  assert.strictEqual(res.status, 200);
  // Ни одного реального обращения к Telegram: всё легло в приёмник самотеста.
  assert.strictEqual(h.adminSent().length, 0, 'каждый деплой писал бы Нику восемь раз');
  const j = await res.json();
  assert.ok(j.sent.some(m => m.admin), 'уведомление должно попасть в приёмник, а не пропасть');
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
