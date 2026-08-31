// 1xBet Affiliate Program — Telegram-боты партнёрской программы
//
// Шесть ботов, один код. Различия между ними — строки в bot_configs, а не
// ветки здесь: гео, язык по умолчанию, контакт менеджера, шаблон ссылки.
// Добавить седьмой бот = строка в таблице + секрет с токеном + setWebhook.
//
// ── Почему отдельный воркер, а не роут в дашбордном ─────────────────────────
// У дашбордного воркера "crons": [] выставлены СОЗНАТЕЛЬНО — этим стоит на
// паузе весь конвейер AffiliateOS (см. комментарий в его wrangler.jsonc).
// Реминдеру нужен крон; добавить его туда значило бы либо снять паузу, либо
// городить внутри планировщика исключения. Плюс там пароль-гейт, мимо которого
// пришлось бы проводить шесть новых открытых роутов.
//
// ── Секреты (Cloudflare) ────────────────────────────────────────────────────
//   BOT_TOKEN_INDIA / _AFRICA / _BANGLADESH / _WORLDWIDE / _AFRIQUE / _UZBEKISTAN
//   BOT_WEBHOOK_SECRET   — общий для всех шести, см. verifyWebhookSecret
//   SUPABASE_URL, SUPABASE_SERVICE_KEY
//
// Токены в коде не лежат и лежать не могут: репозиторий публичный.

const SLUGS = ['india', 'africa', 'bangladesh', 'worldwide', 'afrique', 'uzbekistan'];

// Токен бота по slug. Имя секрета выводится, а не перечисляется таблицей —
// иначе добавление бота требует правки в двух местах, и второе забывается.
const tokenFor = (env, slug) => env['BOT_TOKEN_' + slug.toUpperCase()];

// ── Тексты интерфейса ───────────────────────────────────────────────────────
// Здесь только то, что задано в ТЗ дословно, плюс служебные строки. Ответы FAQ
// сюда НЕ попадают: они утверждают факты о лицензиях и условиях выплат, их
// согласует Ник, и живут они в таблице bot_faq.
const T = {
  en: {
    welcome: (mgr) =>
      `👋 Welcome to the 1xBet Affiliate Program.\n` +
      `Direct contact: ${mgr} — message anytime, no tickets.\n\n` +
      `Choose an option below 👇`,
    btnLink: '🔗 Get Registration Link',
    btnFaq: '❓ FAQ',
    btnManager: '👤 Talk to Manager',
    link: (url) =>
      `Here's your personal registration link:\n👉 ${url}\n\n` +
      `Tap it to create your partner account. Once you're registered,\n` +
      `you'll get access to your dashboard with your tracking link,\n` +
      `stats, and payout settings.\n\n` +
      `Questions? Tap "Talk to Manager" anytime.`,
    manager: (mgr) => `Message your manager directly:\n👉 ${mgr}`,
    reminder: (url, mgr) =>
      `👋 Just checking in — if you've registered, your manager is ready\n` +
      `to help. If not, your link is still active:\n👉 ${url}\n\n` +
      `Contact: ${mgr}`,
    faqTitle: 'Frequently asked questions:',
    // Показывается, пока Ник не заполнил соответствующее поле. Врать про
    // «скоро будет» нечестно, и человек остаётся без следующего шага —
    // поэтому сразу контакт.
    faqEmpty: (mgr) => `This answer isn't published yet. Ask your manager directly: ${mgr}`,
    linkMissing: (mgr) =>
      `The registration link isn't configured yet — your manager will send it to you directly:\n👉 ${mgr}`,
    langTitle: "Choose language / Tilni tanlang / Choisir la langue:",
    langSet: 'Language set to English.',
    back: '⬅️ Back',
  },
  fr: {
    welcome: (mgr) =>
      `👋 Bienvenue dans le programme d'affiliation 1xBet.\n` +
      `Contact direct : ${mgr} — écrivez à tout moment, sans ticket.\n\n` +
      `Choisissez une option ci-dessous 👇`,
    btnLink: '🔗 Obtenir le lien d\'inscription',
    btnFaq: '❓ FAQ',
    btnManager: '👤 Parler au manager',
    link: (url) =>
      `Voici votre lien d'inscription personnel :\n👉 ${url}\n\n` +
      `Cliquez dessus pour créer votre compte partenaire. Une fois inscrit,\n` +
      `vous aurez accès à votre tableau de bord avec votre lien de suivi,\n` +
      `vos statistiques et vos paramètres de paiement.\n\n` +
      `Des questions ? Appuyez sur « Parler au manager » à tout moment.`,
    manager: (mgr) => `Écrivez directement à votre manager :\n👉 ${mgr}`,
    reminder: (url, mgr) =>
      `👋 Petit rappel — si vous êtes inscrit, votre manager est prêt\n` +
      `à vous aider. Sinon, votre lien est toujours actif :\n👉 ${url}\n\n` +
      `Contact : ${mgr}`,
    faqTitle: 'Questions fréquentes :',
    faqEmpty: (mgr) => `Cette réponse n'est pas encore publiée. Demandez directement à votre manager : ${mgr}`,
    linkMissing: (mgr) =>
      `Le lien d'inscription n'est pas encore configuré — votre manager vous l'enverra directement :\n👉 ${mgr}`,
    langTitle: "Choose language / Tilni tanlang / Choisir la langue:",
    langSet: 'Langue définie sur le français.',
    back: '⬅️ Retour',
  },
  uz: {
    welcome: (mgr) =>
      `👋 1xBet Affiliate dasturiga xush kelibsiz.\n` +
      `To'g'ridan-to'g'ri aloqa: ${mgr} — istalgan vaqtda yozing.\n\n` +
      `Quyidan tanlang 👇`,
    btnLink: '🔗 Ro\'yxatdan o\'tish havolasi',
    btnFaq: '❓ Savol-javob',
    btnManager: '👤 Menejer bilan bog\'lanish',
    link: (url) =>
      `Sizning shaxsiy ro'yxatdan o'tish havolangiz:\n👉 ${url}\n\n` +
      `Hamkor hisobingizni yaratish uchun bosing. Ro'yxatdan o'tgach,\n` +
      `kuzatuv havolangiz, statistika va to'lov sozlamalari bilan\n` +
      `shaxsiy kabinetga kirasiz.\n\n` +
      `Savollar bormi? Istalgan vaqtda «Menejer bilan bog'lanish» tugmasini bosing.`,
    manager: (mgr) => `Menejeringizga to'g'ridan-to'g'ri yozing:\n👉 ${mgr}`,
    reminder: (url, mgr) =>
      `👋 Eslatma — agar ro'yxatdan o'tgan bo'lsangiz, menejeringiz\n` +
      `yordam berishga tayyor. Aks holda havolangiz hali ham amal qiladi:\n👉 ${url}\n\n` +
      `Aloqa: ${mgr}`,
    faqTitle: 'Ko\'p beriladigan savollar:',
    faqEmpty: (mgr) => `Bu javob hali chop etilmagan. Menejeringizdan so'rang: ${mgr}`,
    linkMissing: (mgr) =>
      `Ro'yxatdan o'tish havolasi hali sozlanmagan — menejeringiz uni sizga yuboradi:\n👉 ${mgr}`,
    langTitle: "Choose language / Tilni tanlang / Choisir la langue:",
    langSet: 'Til o\'zbekchaga o\'zgartirildi.',
    back: '⬅️ Orqaga',
  },
};

const t = (lang) => T[lang] || T.en;

// ── Supabase ────────────────────────────────────────────────────────────────
// Через REST под service_role: воркер — сервер, RLS для него не барьер, а
// bot_leads по 048 закрыта для всех остальных ролей.
async function sb(env, path, init = {}) {
  const url = `${env.SUPABASE_URL}/rest/v1/${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    // Тело ответа PostgREST содержит причину; без него в логах остаётся голый
    // код и искать нечего.
    throw new Error(`supabase ${init.method || 'GET'} ${path} → ${res.status}: ${await res.text()}`);
  }
  return res.status === 204 ? null : res.json();
}

// ── Telegram ────────────────────────────────────────────────────────────────
async function tg(env, slug, method, payload) {
  const token = tokenFor(env, slug);
  if (!token) throw new Error(`нет секрета BOT_TOKEN_${slug.toUpperCase()}`);
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) console.error(`tg ${slug}/${method} → ${res.status}: ${await res.text()}`);
  return res;
}

const mainKeyboard = (lang) => ({
  keyboard: [
    [{ text: t(lang).btnLink }, { text: t(lang).btnFaq }],
    [{ text: t(lang).btnManager }],
  ],
  resize_keyboard: true,
});

const send = (env, slug, chatId, text, extra = {}) =>
  tg(env, slug, 'sendMessage', { chat_id: chatId, text, disable_web_page_preview: false, ...extra });

// ── Состояние пользователя ──────────────────────────────────────────────────
// Язык берётся по цепочке: явный выбор пользователя → умолчание бота. Язык
// самого Telegram сознательно НЕ учитывается: бот привязан к гео, и человек с
// русской локалью в узбекском боте должен видеть узбекский, а не случайный
// третий язык.
async function resolveLang(env, cfg, userId) {
  const rows = await sb(env,
    `bot_user_prefs?bot_slug=eq.${cfg.slug}&tg_user_id=eq.${userId}&select=lang`);
  return (rows[0] && T[rows[0].lang]) ? rows[0].lang : cfg.default_lang;
}

async function setLang(env, slug, userId, lang) {
  await sb(env, 'bot_user_prefs', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ bot_slug: slug, tg_user_id: userId, lang, updated_at: new Date().toISOString() }),
  });
}

const refCodeFor = (slug, userId) => `tg_${slug}_${userId}`;

// Пустой шаблон — это не сбой, а незаполненная настройка (048: signup_url_tpl
// намеренно пуст, пока Ник не даст точный адрес). Возвращаем null, и
// вызывающий говорит об этом прямо вместо того, чтобы слать битую ссылку.
const signupUrl = (cfg, refCode) =>
  cfg.signup_url_tpl ? cfg.signup_url_tpl.replace('{ref}', encodeURIComponent(refCode)) : null;

// ── Обработчики ─────────────────────────────────────────────────────────────
async function onStart(env, cfg, chatId, userId) {
  const lang = await resolveLang(env, cfg, userId);
  await send(env, cfg.slug, chatId, t(lang).welcome(cfg.manager_contact),
    { reply_markup: mainKeyboard(lang) });
}

async function onGetLink(env, cfg, chatId, user) {
  const lang = await resolveLang(env, cfg, user.id);
  const refCode = refCodeFor(cfg.slug, user.id);
  const url = signupUrl(cfg, refCode);

  if (!url) {
    // Запись всё равно не делаем: bot_leads означает «ссылка выдана», а она не
    // выдана. Иначе счётчик выдач начал бы врать в большую сторону.
    await send(env, cfg.slug, chatId, t(lang).linkMissing(cfg.manager_contact));
    return;
  }

  const now = new Date().toISOString();
  // merge-duplicates по UNIQUE(bot_slug, tg_user_id): повторное нажатие
  // обновляет строку, а не заводит вторую (ТЗ §3.2).
  //
  // merge-duplicates обновляет РОВНО те колонки, что есть в теле. Отсюда два
  // сознательных пропуска:
  //
  //   link_issued_at — от него отсчитывается окно реминдера. Переписывать его
  //     значит сдвигать окно при каждом нажатии: человек, заглядывающий в бот
  //     раз в пару дней, не получил бы напоминания никогда.
  //
  //   status — колонка объявлена DEFAULT 'link_issued', поэтому при вставке
  //     нужное значение проставится само, а при обновлении останется прежним.
  //     Передай мы его явно — повторное нажатие откатывало бы
  //     'contacted_manager' назад в 'link_issued', то есть снова взводило бы
  //     реминдер тому, кто уже общается с менеджером. Пропуск здесь и есть
  //     логика, а не небрежность.
  await sb(env, 'bot_leads?on_conflict=bot_slug,tg_user_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({
      bot_slug: cfg.slug,
      tg_user_id: user.id,
      tg_username: user.username || null,
      lang,
      ref_code: refCode,
      last_interaction_at: now,
    }),
  });

  await send(env, cfg.slug, chatId, t(lang).link(url), { reply_markup: mainKeyboard(lang) });
}

async function onFaq(env, cfg, chatId, userId) {
  const lang = await resolveLang(env, cfg, userId);
  const rows = await sb(env, `bot_faq?lang=eq.${lang}&select=key,question,sort_order&order=sort_order`);
  await send(env, cfg.slug, chatId, t(lang).faqTitle, {
    reply_markup: {
      inline_keyboard: rows.map(r => [{ text: r.question, callback_data: `faq:${r.key}` }]),
    },
  });
}

async function onFaqAnswer(env, cfg, chatId, userId, key) {
  const lang = await resolveLang(env, cfg, userId);
  const rows = await sb(env,
    `bot_faq?lang=eq.${lang}&key=eq.${encodeURIComponent(key)}&select=answer`);
  const answer = rows[0] && rows[0].answer;
  await send(env, cfg.slug, chatId, answer || t(lang).faqEmpty(cfg.manager_contact));
}

async function onManager(env, cfg, chatId, userId) {
  const lang = await resolveLang(env, cfg, userId);
  await send(env, cfg.slug, chatId, t(lang).manager(cfg.manager_contact));

  // Только UPDATE. ТЗ §3.4: записи нет — не создавать, нажатие на «связаться»
  // не означает, что человек вообще собирался регистрироваться.
  await sb(env, `bot_leads?bot_slug=eq.${cfg.slug}&tg_user_id=eq.${userId}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ status: 'contacted_manager', last_interaction_at: new Date().toISOString() }),
  });
}

async function onLang(env, cfg, chatId, userId) {
  const lang = await resolveLang(env, cfg, userId);
  await send(env, cfg.slug, chatId, t(lang).langTitle, {
    reply_markup: {
      inline_keyboard: [[
        { text: 'English', callback_data: 'lang:en' },
        { text: "O'zbekcha", callback_data: 'lang:uz' },
        { text: 'Français', callback_data: 'lang:fr' },
      ]],
    },
  });
}

// ── Роутинг апдейта ─────────────────────────────────────────────────────────
async function handleUpdate(env, cfg, update) {
  if (update.callback_query) {
    const cq = update.callback_query;
    const chatId = cq.message && cq.message.chat.id;
    const userId = cq.from.id;
    const data = cq.data || '';
    // Отвечаем всегда — иначе кнопка в клиенте крутит часики до таймаута.
    await tg(env, cfg.slug, 'answerCallbackQuery', { callback_query_id: cq.id });

    if (data.startsWith('lang:')) {
      const lang = data.slice(5);
      if (!T[lang]) return;
      await setLang(env, cfg.slug, userId, lang);
      await send(env, cfg.slug, chatId, t(lang).langSet, { reply_markup: mainKeyboard(lang) });
      return;
    }
    if (data.startsWith('faq:')) {
      await onFaqAnswer(env, cfg, chatId, userId, data.slice(4));
      return;
    }
    return;
  }

  const msg = update.message;
  if (!msg || !msg.text) return;
  const chatId = msg.chat.id;
  const user = msg.from;
  const text = msg.text.trim();

  if (text === '/start' || text.startsWith('/start ')) return onStart(env, cfg, chatId, user.id);
  if (text === '/lang')  return onLang(env, cfg, chatId, user.id);

  // Кнопки reply-меню приходят обычным текстом, поэтому сверяемся со ВСЕМИ
  // языками, а не только с текущим: человек мог переключить язык, оставив на
  // экране клавиатуру на прежнем — Telegram её не перерисовывает сам.
  const isBtn = (field) => Object.values(T).some(x => x[field] === text);
  if (isBtn('btnLink'))    return onGetLink(env, cfg, chatId, user);
  if (isBtn('btnFaq'))     return onFaq(env, cfg, chatId, user.id);
  if (isBtn('btnManager')) return onManager(env, cfg, chatId, user.id);

  // Всё остальное — снова меню. Свободный текст боту не адресован: живой
  // диалог ведёт менеджер, и его контакт в приветствии.
  return onStart(env, cfg, chatId, user.id);
}

// ── Проверка подписи вебхука ────────────────────────────────────────────────
// Один секрет на все шесть ботов. Раздельные были бы строже, но каждый секрет
// — ещё одна ручная операция в панели Cloudflare, а роут и так не даёт ничего,
// кроме возможности прислать боту фальшивый апдейт. Разделить можно позже, не
// меняя логику: достаточно читать BOT_SECRET_{SLUG} с откатом на общий.
function verifyWebhookSecret(request, env, slug) {
  const expected = env['BOT_SECRET_' + slug.toUpperCase()] || env.BOT_WEBHOOK_SECRET;
  if (!expected) {
    // Не «пропустить молча»: незащищённый вебхук принимает апдейты от кого
    // угодно, кто узнал URL. Отказ ломает бота заметно, пропуск — незаметно.
    console.error(`bot/${slug}: BOT_WEBHOOK_SECRET не задан — апдейт отклонён`);
    return false;
  }
  return request.headers.get('X-Telegram-Bot-Api-Secret-Token') === expected;
}

async function loadConfig(env, slug) {
  const rows = await sb(env, `bot_configs?slug=eq.${encodeURIComponent(slug)}&select=*`);
  return rows[0] || null;
}

// ── Реминдер ────────────────────────────────────────────────────────────────
// Раз в сутки: тем, кто получил ссылку 6+ дней назад и с тех пор ничего не
// делал. Ровно один раз за всю жизнь записи (ТЗ §3.5).
async function sendReminders(env) {
  const cutoff = new Date(Date.now() - 6 * 24 * 3600 * 1000).toISOString();
  const leads = await sb(env,
    `bot_leads?reminder_sent=eq.false&status=eq.link_issued` +
    `&link_issued_at=lt.${encodeURIComponent(cutoff)}` +
    `&select=id,bot_slug,tg_user_id,ref_code,lang&limit=500`);

  if (!leads.length) return { sent: 0, failed: 0 };

  const configs = {};
  for (const slug of new Set(leads.map(l => l.bot_slug))) configs[slug] = await loadConfig(env, slug);

  let sent = 0, failed = 0;
  for (const lead of leads) {
    const cfg = configs[lead.bot_slug];
    const url = cfg && signupUrl(cfg, lead.ref_code);
    // Без настроенной ссылки реминдер отправлять нечем. Флаг НЕ ставим —
    // иначе человек потеряет своё единственное напоминание из-за того, что в
    // момент рассылки не был заполнен шаблон.
    if (!url) { failed++; continue; }
    try {
      const lang = T[lead.lang] ? lead.lang : cfg.default_lang;
      await send(env, cfg.slug, lead.tg_user_id, t(lang).reminder(url, cfg.manager_contact));
      await sb(env, `bot_leads?id=eq.${lead.id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ reminder_sent: true }),
      });
      sent++;
    } catch (e) {
      // Заблокировавший бота пользователь не должен останавливать рассылку
      // остальным. Флаг не ставим — попробуем в следующий раз.
      console.error(`reminder ${lead.bot_slug}/${lead.tg_user_id}:`, e && e.message);
      failed++;
    }
  }
  return { sent, failed };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/bot\/([a-z]+)\/?$/);

    if (!m) return new Response('not found', { status: 404 });
    const slug = m[1];
    if (!SLUGS.includes(slug)) return new Response('unknown bot', { status: 404 });
    if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
    if (!verifyWebhookSecret(request, env, slug)) return new Response('unauthorized', { status: 401 });

    // Telegram считает доставку неудачной по не-200 и повторяет апдейт. Своя
    // ошибка при этом вернётся снова и снова тем же результатом, поэтому
    // отвечаем 200 всегда, а причину пишем в лог.
    try {
      const cfg = await loadConfig(env, slug);
      if (!cfg || !cfg.active) {
        console.error(`bot/${slug}: конфига нет или бот выключен`);
        return new Response('OK');
      }
      await handleUpdate(env, cfg, await request.json());
    } catch (e) {
      console.error(`bot/${slug} update failed:`, e && e.stack || e);
    }
    return new Response('OK');
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendReminders(env)
      .then(r => console.log(`reminders: отправлено ${r.sent}, не удалось ${r.failed}`))
      .catch(e => console.error('reminders failed:', e && e.stack || e)));
  },
};
