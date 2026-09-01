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

// Отметка сборки: по ней видно, какой код реально отвечает. Поднимать при
// каждом изменении, которое надо уметь опознать на живом воркере.
const BUILD = '2026-09-01.1';

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

// ── Check GEO (дополнение к ТЗ) ─────────────────────────────────────────────
// Отдельным блоком, а не врезкой в три языковых объекта выше: весь текст новой
// функции лежит рядом, и его видно целиком — включая то, что ни один ответ не
// утверждает ничего сверх того, что пришло из справочника.
//
// Формулировки статусов взяты из ТЗ §2.3 дословно; fr/uz — перевод тех же
// фраз. Названия стран и примечания подставляются из geo_availability как
// есть, ни на один язык не переводятся: это данные из PDF, а не наш текст.
const GEO_T = {
  en: {
    btnGeo: '🌍 Check GEO',
    geoIntro: 'Would you like to check a specific country, or get the full list?',
    geoBtnCountry: '🔍 Check a country',
    geoBtnPdf: '📄 Full GEO list (PDF)',
    geoAsk: 'Type the country name (e.g. Nigeria)',
    geoAvailable: (n, note) => `✅ ${n} — available.` + (note ? `\n${note}` : ''),
    geoNotAvailable: (n) => `❌ ${n} — not available.`,
    geoLocalOnly: (n, note) =>
      `⚠️ ${n} is only covered through a local affiliate program, not this one.` +
      (note ? `\n${note}` : ''),
    geoConfirm: (n, mgr) =>
      `❓ ${n} availability depends on current terms — please confirm directly:\n👉 ${mgr}`,
    geoNotFound: (q) =>
      `Couldn't find "${q}" — check the spelling, or tap "Full GEO list" to browse all countries.`,
    geoDidYouMean: (q) => `No exact match for "${q}". Did you mean:`,
    geoAgain: 'Type another country, or go back to the menu.',
    geoEmpty: (mgr) =>
      `The GEO directory hasn't been uploaded yet — your manager can confirm any country directly:\n👉 ${mgr}`,
    geoPdfMissing: (mgr) =>
      `The full list isn't published yet. Type a country name instead, or ask your manager:\n👉 ${mgr}`,
    btnMenu: '⬅️ Menu',
  },
  fr: {
    btnGeo: '🌍 Vérifier un GEO',
    geoIntro: 'Souhaitez-vous vérifier un pays précis, ou obtenir la liste complète ?',
    geoBtnCountry: '🔍 Vérifier un pays',
    geoBtnPdf: '📄 Liste GEO complète (PDF)',
    geoAsk: 'Saisissez le nom du pays (par ex. Nigeria)',
    geoAvailable: (n, note) => `✅ ${n} — disponible.` + (note ? `\n${note}` : ''),
    geoNotAvailable: (n) => `❌ ${n} — non disponible.`,
    geoLocalOnly: (n, note) =>
      `⚠️ ${n} est couvert uniquement par un programme d'affiliation local, pas celui-ci.` +
      (note ? `\n${note}` : ''),
    geoConfirm: (n, mgr) =>
      `❓ La disponibilité de ${n} dépend des conditions actuelles — merci de confirmer directement :\n👉 ${mgr}`,
    geoNotFound: (q) =>
      `Impossible de trouver « ${q} » — vérifiez l'orthographe, ou appuyez sur « Liste GEO complète » pour parcourir tous les pays.`,
    geoDidYouMean: (q) => `Aucune correspondance exacte pour « ${q} ». Vouliez-vous dire :`,
    geoAgain: 'Saisissez un autre pays, ou revenez au menu.',
    geoEmpty: (mgr) =>
      `Le répertoire GEO n'a pas encore été chargé — votre manager peut confirmer n'importe quel pays directement :\n👉 ${mgr}`,
    geoPdfMissing: (mgr) =>
      `La liste complète n'est pas encore publiée. Saisissez plutôt un nom de pays, ou demandez à votre manager :\n👉 ${mgr}`,
    btnMenu: '⬅️ Menu',
  },
  uz: {
    btnGeo: '🌍 GEO tekshirish',
    geoIntro: "Muayyan davlatni tekshirmoqchimisiz yoki to'liq ro'yxatni olasizmi?",
    geoBtnCountry: '🔍 Davlatni tekshirish',
    geoBtnPdf: "📄 To'liq GEO ro'yxati (PDF)",
    geoAsk: 'Davlat nomini yozing (masalan, Nigeria)',
    geoAvailable: (n, note) => `✅ ${n} — mavjud.` + (note ? `\n${note}` : ''),
    geoNotAvailable: (n) => `❌ ${n} — mavjud emas.`,
    geoLocalOnly: (n, note) =>
      `⚠️ ${n} faqat mahalliy hamkorlik dasturi orqali qamrab olingan, bu dastur orqali emas.` +
      (note ? `\n${note}` : ''),
    geoConfirm: (n, mgr) =>
      `❓ ${n} bo'yicha mavjudlik joriy shartlarga bog'liq — iltimos, to'g'ridan-to'g'ri aniqlang:\n👉 ${mgr}`,
    geoNotFound: (q) =>
      `"${q}" topilmadi — imloni tekshiring yoki barcha davlatlarni ko'rish uchun "To'liq GEO ro'yxati" tugmasini bosing.`,
    geoDidYouMean: (q) => `"${q}" uchun aniq moslik yo'q. Balki shulardan biri:`,
    geoAgain: "Boshqa davlat nomini yozing yoki menyuga qayting.",
    geoEmpty: (mgr) =>
      `GEO ma'lumotnomasi hali yuklanmagan — menejeringiz istalgan davlatni to'g'ridan-to'g'ri tasdiqlay oladi:\n👉 ${mgr}`,
    geoPdfMissing: (mgr) =>
      `To'liq ro'yxat hali chop etilmagan. Buning o'rniga davlat nomini yozing yoki menejeringizdan so'rang:\n👉 ${mgr}`,
    btnMenu: '⬅️ Menyu',
  },
};
for (const [lang, extra] of Object.entries(GEO_T)) Object.assign(T[lang], extra);

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

// Раскладка из ТЗ §0: ссылка и GEO в первом ряду, FAQ и менеджер во втором.
const mainKeyboard = (lang) => ({
  keyboard: [
    [{ text: t(lang).btnLink }, { text: t(lang).btnGeo }],
    [{ text: t(lang).btnFaq },  { text: t(lang).btnManager }],
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
// clearState=true при явном возврате в меню (/start или кнопка «Menu»):
// иначе человек, вышедший из проверки ГЕО, остался бы в ней, и следующее его
// сообщение снова искалось бы как страна.
async function onStart(env, cfg, chatId, userId, clearState) {
  const lang = await resolveLang(env, cfg, userId);
  if (clearState) await setAwaiting(env, cfg.slug, userId, lang, null);
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

// ── Check GEO ───────────────────────────────────────────────────────────────

// Состояние «ждём название страны». Нужно, чтобы следующее сообщение поняли
// как страну, а не как «не понял, вот меню». Живёт в bot_user_prefs рядом с
// языком: заводить ради одного флага отдельную таблицу незачем.
// lang передаётся ОБЯЗАТЕЛЬНО, хотя менять его здесь не требуется.
//
// bot_user_prefs.lang объявлен NOT NULL без умолчания, а у большинства людей
// строки в этой таблице нет вовсе — она заводится только при смене языка.
// Первая версия слала upsert без lang, и для такого человека вставка нарушала
// ограничение: sb() бросал, обработчик ловил, Telegram получал 200, а
// приветствие на следующей строке уже не отправлялось. Снаружи — «/start
// молчит», и ни одной ошибки нигде.
//
// Умолчания в колонке хватило бы не всегда: правильный язык зависит от бота
// (uz для Узбекистана, fr для франкофонной Африки), а колонка про бота не
// знает. Поэтому значение приходит от вызывающего, который его уже вычислил.
async function setAwaiting(env, slug, userId, lang, value) {
  await sb(env, 'bot_user_prefs?on_conflict=bot_slug,tg_user_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ bot_slug: slug, tg_user_id: userId, lang, awaiting: value,
                           updated_at: new Date().toISOString() }),
  });
}

async function onGeoMenu(env, cfg, chatId, userId) {
  const lang = await resolveLang(env, cfg, userId);
  await setAwaiting(env, cfg.slug, userId, lang, null);
  await send(env, cfg.slug, chatId, t(lang).geoIntro, {
    reply_markup: { inline_keyboard: [[
      { text: t(lang).geoBtnCountry, callback_data: 'geo:country' },
      { text: t(lang).geoBtnPdf,     callback_data: 'geo:pdf' },
    ]] },
  });
}

async function onGeoAskCountry(env, cfg, chatId, userId) {
  const lang = await resolveLang(env, cfg, userId);
  await setAwaiting(env, cfg.slug, userId, lang, 'geo');
  await send(env, cfg.slug, chatId, t(lang).geoAsk);
}

// origin приходит из самого запроса, а не из настройки: воркер отдаёт PDF как
// свою статику (public/geo.pdf), и адрес у каждого аккаунта свой. Собирать его
// из имени воркера — это гадание, которое выглядит правдоподобно и уводит
// вебхуки в никуда; тот же адрес, по которому Telegram сейчас достучался,
// заведомо верен.
//
// system_config.geo_pdf_url остаётся и имеет приоритет — на случай, если файл
// решат раздавать откуда-то ещё.
async function onGeoPdf(env, cfg, chatId, userId, origin) {
  const lang = await resolveLang(env, cfg, userId);
  const rows = await sb(env, "system_config?key=eq.geo_pdf_url&select=value");
  const configured = rows[0] && typeof rows[0].value === 'string' ? rows[0].value : '';
  const url = configured || (origin ? `${origin}/geo.pdf` : '');
  if (!url) {
    // Отправить «что-нибудь похожее» вместо официального списка ГЕО было бы
    // хуже молчания.
    await send(env, cfg.slug, chatId, t(lang).geoPdfMissing(cfg.manager_contact));
    return;
  }
  await tg(env, cfg.slug, 'sendDocument', { chat_id: chatId, document: url });
}

// Один ответ по строке справочника. Текст выбирается по availability; note
// подставляется как есть и только если он есть.
function geoAnswer(lang, row, mgr) {
  const T_ = t(lang);
  const name = row.geo_en;
  switch (row.availability) {
    case 'available':          return T_.geoAvailable(name, row.note);
    case 'not_available':      return T_.geoNotAvailable(name);
    case 'local_program_only': return T_.geoLocalOnly(name, row.note);
    case 'confirm_with_manager': return T_.geoConfirm(name, mgr);
    // Незнакомый статус — не наш случай выдумывать. Отправляем к менеджеру
    // вместо того, чтобы молча выбрать одну из четырёх готовых формулировок.
    default:                   return T_.geoConfirm(name, mgr);
  }
}

const geoAgainKeyboard = (lang) => ({
  inline_keyboard: [[{ text: t(lang).btnMenu, callback_data: 'geo:exit' }]],
});

async function onGeoLookup(env, cfg, chatId, userId, query) {
  const lang = await resolveLang(env, cfg, userId);

  const hit = await sb(env, 'rpc/fn_find_geo', {
    method: 'POST', body: JSON.stringify({ q: query }),
  });
  if (hit.length) {
    await send(env, cfg.slug, chatId, geoAnswer(lang, hit[0], cfg.manager_contact),
      { reply_markup: geoAgainKeyboard(lang) });
    return;
  }

  // Неточное совпадение НЕ становится ответом — только вопросом.
  //
  // Проверено на данных: запрос «Nigeira» ближе к «Niger» (0.400), чем к
  // «Nigeria» (0.333), потому что короткое слово выигрывает по триграммам. Бот
  // сказал бы «Niger — not available» человеку, спросившему про Нигерию, где
  // ответ обратный. Порог этого не чинит — у любого нечёткого поиска есть
  // соседи, между которыми он выбирает наугад.
  const suggestions = await sb(env, 'rpc/fn_suggest_geo', {
    method: 'POST', body: JSON.stringify({ q: query, n: 3 }),
  });
  if (suggestions.length) {
    await send(env, cfg.slug, chatId, t(lang).geoDidYouMean(query), {
      reply_markup: {
        inline_keyboard: suggestions.map(x => [
          { text: x.geo_en, callback_data: `geo:id:${x.id}` },
        ]).concat([[{ text: t(lang).btnMenu, callback_data: 'geo:exit' }]]),
      },
    });
    return;
  }

  // Ни ответа, ни кандидатов. Пустой справочник и незнакомая страна снаружи
  // выглядят одинаково, а чинятся по-разному, поэтому различаем.
  const any = await sb(env, 'geo_availability?select=id&limit=1');
  await send(env, cfg.slug, chatId,
    any.length ? t(lang).geoNotFound(query) : t(lang).geoEmpty(cfg.manager_contact),
    { reply_markup: geoAgainKeyboard(lang) });
}

async function onGeoById(env, cfg, chatId, userId, id) {
  const lang = await resolveLang(env, cfg, userId);
  const rows = await sb(env, `geo_availability?id=eq.${encodeURIComponent(id)}&select=*`);
  if (!rows.length) { await onGeoMenu(env, cfg, chatId, userId); return; }
  await send(env, cfg.slug, chatId, geoAnswer(lang, rows[0], cfg.manager_contact),
    { reply_markup: geoAgainKeyboard(lang) });
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
async function handleUpdate(env, cfg, update, origin) {
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
    if (data === 'geo:country') { await onGeoAskCountry(env, cfg, chatId, userId); return; }
    if (data === 'geo:pdf')     { await onGeoPdf(env, cfg, chatId, userId, origin); return; }
    if (data === 'geo:exit')    { await onStart(env, cfg, chatId, userId, true); return; }
    if (data.startsWith('geo:id:')) {
      await onGeoById(env, cfg, chatId, userId, data.slice(7));
      return;
    }
    return;
  }

  const msg = update.message;
  if (!msg || !msg.text) return;
  const chatId = msg.chat.id;
  const user = msg.from;
  const text = msg.text.trim();

  if (text === '/start' || text.startsWith('/start ')) return onStart(env, cfg, chatId, user.id, true);
  if (text === '/lang')       return onLang(env, cfg, chatId, user.id);
  if (text === '/check_geo')  return onGeoMenu(env, cfg, chatId, user.id);

  // Кнопки reply-меню приходят обычным текстом, поэтому сверяемся со ВСЕМИ
  // языками, а не только с текущим: человек мог переключить язык, оставив на
  // экране клавиатуру на прежнем — Telegram её не перерисовывает сам.
  const isBtn = (field) => Object.values(T).some(x => x[field] === text);
  if (isBtn('btnLink'))    return onGetLink(env, cfg, chatId, user);
  if (isBtn('btnGeo'))     return onGeoMenu(env, cfg, chatId, user.id);
  if (isBtn('btnFaq'))     return onFaq(env, cfg, chatId, user.id);
  if (isBtn('btnManager')) return onManager(env, cfg, chatId, user.id);

  // Кнопки проверяются ДО состояния: находясь в режиме ввода страны, человек
  // всё равно должен мочь нажать «FAQ» и попасть в FAQ, а не искать страну с
  // названием «❓ FAQ».
  const prefs = await sb(env,
    `bot_user_prefs?bot_slug=eq.${cfg.slug}&tg_user_id=eq.${user.id}&select=awaiting`);
  if (prefs[0] && prefs[0].awaiting === 'geo') {
    // Режим не сбрасывается после ответа: ТЗ §2.3 просит не заставлять выходить
    // из проверки после одной страны. Выход — кнопкой «Menu».
    return onGeoLookup(env, cfg, chatId, user.id, text);
  }

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

    // ── Самопроверка ────────────────────────────────────────────────────────
    // Появилась после того, как боты замолчали при зелёных деплоях обоих
    // конвейеров. Обработчик апдейта намеренно возвращает Telegram 200 на любой
    // своей ошибке — иначе Telegram завалит повторами, — поэтому снаружи любая
    // поломка выглядит одинаково: бот молчит. Здесь те же вызовы делаются
    // открыто, и текст ошибки виден.
    //
    // Секретов не отдаёт: только «задан/не задан» и сообщения об ошибках БД.
    if (url.pathname === '/health') {
      const out = { build: BUILD, env: {}, db: {} };
      out.env = {
        SUPABASE_URL: env.SUPABASE_URL || '(не задан)',
        SUPABASE_SERVICE_KEY: !!env.SUPABASE_SERVICE_KEY,
        BOT_WEBHOOK_SECRET: !!env.BOT_WEBHOOK_SECRET,
        tokens: SLUGS.filter(s => !!tokenFor(env, s)),
      };
      const probe = async (name, fn) => {
        try { out.db[name] = await fn(); }
        catch (e) { out.db[name] = 'ОШИБКА: ' + (e && e.message || String(e)); }
      };
      await probe('bot_configs', async () => {
        const c = await loadConfig(env, 'india');
        return c ? `ok (india, active=${c.active}, ссылка=${c.signup_url_tpl ? 'есть' : 'пусто'})` : 'строки india нет';
      });
      await probe('bot_user_prefs', async () => {
        await sb(env, 'bot_user_prefs?select=bot_slug,awaiting&limit=1');
        return 'ok (колонка awaiting на месте)';
      });
      await probe('bot_faq', async () => {
        const r = await sb(env, 'bot_faq?select=lang,key');
        return `ok (${r.length} записей)`;
      });
      await probe('geo_availability', async () => {
        const r = await sb(env, 'geo_availability?select=id&limit=1');
        return r.length ? 'ok (справочник не пуст)' : 'пусто';
      });
      await probe('fn_find_geo', async () => {
        const r = await sb(env, 'rpc/fn_find_geo', { method: 'POST', body: JSON.stringify({ q: 'Nigeria' }) });
        return r.length ? `ok (Nigeria → ${r[0].availability})` : 'ничего не нашлось';
      });
      const failed = Object.values(out.db).filter(v => String(v).startsWith('ОШИБКА')).length;
      out.ok = failed === 0;
      return new Response(JSON.stringify(out, null, 2), {
        status: out.ok ? 200 : 500,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }

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
      await handleUpdate(env, cfg, await request.json(), url.origin);
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
