// 1xBet Affiliate Program — Telegram-боты партнёрской программы
//
// Восемь ботов, один код. Различия между ними — строки в bot_configs, а не
// ветки здесь: гео, язык по умолчанию, контакт менеджера, шаблон ссылки.
// Добавить девятый бот = строка в таблице + секрет с токеном + setWebhook.
//
// ── Почему отдельный воркер, а не роут в дашбордном ─────────────────────────
// У дашбордного воркера "crons": [] выставлены СОЗНАТЕЛЬНО — этим стоит на
// паузе весь конвейер AffiliateOS (см. комментарий в его wrangler.jsonc).
// Реминдеру нужен крон; добавить его туда значило бы либо снять паузу, либо
// городить внутри планировщика исключения. Плюс там пароль-гейт, мимо которого
// пришлось бы проводить шесть новых открытых роутов.
//
// ── Секреты (Cloudflare) ────────────────────────────────────────────────────
//   BOT_TOKEN_INDIA / _AFRICA / _BANGLADESH / _WORLDWIDE / _AFRIQUE /
//   _UZBEKISTAN / _RU / _LATAM
//   BOT_WEBHOOK_SECRET   — общий для всех восьми и для админ-бота
//   ADMIN_BOT_TOKEN      — админ-бот уведомлений (роут /admin-bot)
//   ADMIN_CHAT_ID        — единственный получатель уведомлений
//   ADMIN_TZ_OFFSET      — необязательный, часовой пояс показа времени (по умолчанию +2)
//   SUPABASE_URL, SUPABASE_SERVICE_KEY
//
// Токены в коде не лежат и лежать не могут: репозиторий публичный.

const SLUGS = ['india', 'africa', 'bangladesh', 'worldwide', 'afrique', 'uzbekistan',
               'ru', 'latam'];

// Отметка сборки: по ней видно, какой код реально отвечает. Поднимать при
// каждом изменении, которое надо уметь опознать на живом воркере.
const BUILD = '2026-09-04.1';

// Токен бота по slug. Имя секрета выводится, а не перечисляется таблицей —
// иначе добавление бота требует правки в двух местах, и второе забывается.
const tokenFor = (env, slug) => env['BOT_TOKEN_' + slug.toUpperCase()];

// ── Тексты интерфейса ───────────────────────────────────────────────────────
// Здесь только то, что задано в ТЗ дословно, плюс служебные строки. Ответы FAQ
// сюда НЕ попадают: они утверждают факты о лицензиях и условиях выплат, их
// согласует Ник, и живут они в таблице bot_faq.

// Заголовок выбора языка одинаков во всех языках и намеренно многоязычен:
// человек открывает /lang именно тогда, когда текущий язык ему НЕ понятен, и
// строка на непонятном языке здесь бесполезна. Вынесена в константу, потому
// что раньше её приходилось дублировать в каждый блок, и при добавлении языка
// список молча расходился между блоками.
const LANG_TITLE =
  'Choose language / Выберите язык / Elige idioma / Choisir la langue / Tilni tanlang:';

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
    langTitle: LANG_TITLE,
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
    langTitle: LANG_TITLE,
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
    langTitle: LANG_TITLE,
    langSet: 'Til o\'zbekchaga o\'zgartirildi.',
    back: '⬅️ Orqaga',
  },
  ru: {
    welcome: (mgr) =>
      `👋 Добро пожаловать в партнёрскую программу 1xBet.\n` +
      `Прямой контакт: ${mgr} — пишите в любое время, без тикетов.\n\n` +
      `Выберите действие 👇`,
    btnLink: '🔗 Получить ссылку для регистрации',
    btnFaq: '❓ Вопросы и ответы',
    btnManager: '👤 Связаться с менеджером',
    link: (url) =>
      `Ваша персональная ссылка для регистрации:\n👉 ${url}\n\n` +
      `Перейдите по ней, чтобы создать партнёрский аккаунт. После регистрации\n` +
      `вы получите доступ к личному кабинету с трекинговой ссылкой,\n` +
      `статистикой и настройками выплат.\n\n` +
      `Вопросы? В любой момент нажмите «Связаться с менеджером».`,
    manager: (mgr) => `Напишите менеджеру напрямую:\n👉 ${mgr}`,
    reminder: (url, mgr) =>
      `👋 Напоминаем о себе — если вы зарегистрировались, менеджер готов\n` +
      `помочь. Если нет, ваша ссылка всё ещё активна:\n👉 ${url}\n\n` +
      `Контакт: ${mgr}`,
    faqTitle: 'Частые вопросы:',
    faqEmpty: (mgr) => `Этот ответ ещё не опубликован. Спросите менеджера напрямую: ${mgr}`,
    linkMissing: (mgr) =>
      `Ссылка для регистрации ещё не настроена — менеджер пришлёт её вам лично:\n👉 ${mgr}`,
    langTitle: LANG_TITLE,
    langSet: 'Язык переключён на русский.',
    back: '⬅️ Назад',
  },
  es: {
    welcome: (mgr) =>
      `👋 Bienvenido al programa de afiliados de 1xBet.\n` +
      `Contacto directo: ${mgr} — escríbenos cuando quieras, sin tickets.\n\n` +
      `Elige una opción abajo 👇`,
    btnLink: '🔗 Obtener enlace de registro',
    btnFaq: '❓ Preguntas frecuentes',
    btnManager: '👤 Hablar con el manager',
    link: (url) =>
      `Este es tu enlace personal de registro:\n👉 ${url}\n\n` +
      `Púlsalo para crear tu cuenta de socio. Una vez registrado,\n` +
      `tendrás acceso a tu panel con tu enlace de seguimiento,\n` +
      `estadísticas y ajustes de pago.\n\n` +
      `¿Dudas? Pulsa «Hablar con el manager» cuando quieras.`,
    manager: (mgr) => `Escribe directamente a tu manager:\n👉 ${mgr}`,
    reminder: (url, mgr) =>
      `👋 Pasamos a saludar — si ya te has registrado, tu manager está\n` +
      `listo para ayudarte. Si no, tu enlace sigue activo:\n👉 ${url}\n\n` +
      `Contacto: ${mgr}`,
    faqTitle: 'Preguntas frecuentes:',
    faqEmpty: (mgr) => `Esta respuesta aún no está publicada. Pregunta directamente a tu manager: ${mgr}`,
    linkMissing: (mgr) =>
      `El enlace de registro aún no está configurado — tu manager te lo enviará directamente:\n👉 ${mgr}`,
    langTitle: LANG_TITLE,
    langSet: 'Idioma cambiado a español.',
    back: '⬅️ Atrás',
  },
};

// ── Check GEO (дополнение к ТЗ) ─────────────────────────────────────────────
// Отдельным блоком, а не врезкой в три языковых объекта выше: весь текст новой
// функции лежит рядом, и его видно целиком — включая то, что ни один ответ не
// утверждает ничего сверх того, что пришло из справочника.
//
// Формулировки статусов взяты из ТЗ §2.3 дословно; fr/uz/ru/es — перевод тех
// же фраз. Названия стран и примечания подставляются из geo_availability как
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
  ru: {
    btnGeo: '🌍 Проверить ГЕО',
    geoIntro: 'Проверить конкретную страну или получить полный список?',
    geoBtnCountry: '🔍 Проверить страну',
    geoBtnPdf: '📄 Полный список ГЕО (PDF)',
    // Русское название работает наравне с английским: в справочнике есть
    // колонка geo_ru, и поиск сверяется с обеими.
    geoAsk: 'Напишите название страны (например, Нигерия)',
    geoAvailable: (n, note) => `✅ ${n} — доступно.` + (note ? `\n${note}` : ''),
    geoNotAvailable: (n) => `❌ ${n} — недоступно.`,
    geoLocalOnly: (n, note) =>
      `⚠️ ${n} покрывается только локальной партнёрской программой, не этой.` +
      (note ? `\n${note}` : ''),
    geoConfirm: (n, mgr) =>
      `❓ Доступность ${n} зависит от текущих условий — уточните напрямую:\n👉 ${mgr}`,
    geoNotFound: (q) =>
      `Не удалось найти «${q}» — проверьте написание или нажмите «Полный список ГЕО», чтобы посмотреть все страны.`,
    geoDidYouMean: (q) => `Точного совпадения для «${q}» нет. Возможно, имелось в виду:`,
    geoAgain: 'Напишите другую страну или вернитесь в меню.',
    geoEmpty: (mgr) =>
      `Справочник ГЕО ещё не загружен — менеджер может подтвердить любую страну напрямую:\n👉 ${mgr}`,
    geoPdfMissing: (mgr) =>
      `Полный список ещё не опубликован. Напишите название страны или спросите менеджера:\n👉 ${mgr}`,
    btnMenu: '⬅️ Меню',
  },
  es: {
    btnGeo: '🌍 Consultar GEO',
    geoIntro: '¿Quieres consultar un país concreto u obtener la lista completa?',
    geoBtnCountry: '🔍 Consultar un país',
    geoBtnPdf: '📄 Lista GEO completa (PDF)',
    geoAsk: 'Escribe el nombre del país (por ejemplo, México)',
    geoAvailable: (n, note) => `✅ ${n} — disponible.` + (note ? `\n${note}` : ''),
    geoNotAvailable: (n) => `❌ ${n} — no disponible.`,
    geoLocalOnly: (n, note) =>
      `⚠️ ${n} solo está cubierto por un programa de afiliados local, no por este.` +
      (note ? `\n${note}` : ''),
    geoConfirm: (n, mgr) =>
      `❓ La disponibilidad de ${n} depende de las condiciones actuales — confírmalo directamente:\n👉 ${mgr}`,
    geoNotFound: (q) =>
      `No se ha encontrado «${q}» — revisa la ortografía o pulsa «Lista GEO completa» para ver todos los países.`,
    geoDidYouMean: (q) => `No hay coincidencia exacta para «${q}». ¿Querías decir:`,
    geoAgain: 'Escribe otro país o vuelve al menú.',
    geoEmpty: (mgr) =>
      `El directorio GEO aún no se ha cargado — tu manager puede confirmar cualquier país directamente:\n👉 ${mgr}`,
    geoPdfMissing: (mgr) =>
      `La lista completa aún no está publicada. Escribe el nombre de un país o pregunta a tu manager:\n👉 ${mgr}`,
    btnMenu: '⬅️ Menú',
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
  // Разбираем тело только когда оно есть.
  //
  // Это стоило нам всего рабочего дня. PostgREST на upsert (POST с
  // resolution=merge-duplicates) отвечает 201 и ПУСТЫМ телом — представление
  // возвращается только по явному Prefer: return=representation. Проверки на
  // 204 здесь не хватало: res.json() на пустом теле бросает «Unexpected end of
  // JSON input».
  //
  // Дальше ошибка попадала в обработчик апдейта, тот честно отвечал Telegram
  // 200 (иначе бесконечные повторы) — и /start, /check_geo и выдача ссылки
  // молчали во всех шести ботах, не оставив ни одного следа снаружи.
  //
  // Проверять код ответа вместо тела ненадёжно: PostgREST возвращает то 200,
  // то 201, то 204 в зависимости от запроса и заголовков. Наличие тела —
  // единственный честный признак того, что его можно разбирать.
  const body = await res.text();
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch (e) {
    throw new Error(`supabase ${init.method || 'GET'} ${path} → ${res.status}: ` +
                    `тело не разобралось как JSON: ${body.slice(0, 200)}`);
  }
}

// ── Telegram ────────────────────────────────────────────────────────────────
// cfg, а не slug, потому что на нём может висеть __sink — приёмник для
// сквозного самотеста (/selftest). Сделано параметром, а не модульной
// переменной, СОЗНАТЕЛЬНО: модульная переменная в воркере общая для всех
// запросов изолята, и самотест мог бы проглотить сообщение живого человека,
// пришедшее в ту же секунду.
async function tg(env, cfg, method, payload) {
  const slug = typeof cfg === 'string' ? cfg : cfg.slug;
  if (cfg && cfg.__sink) { cfg.__sink.push({ method, ...payload }); return null; }
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

const send = (env, cfg, chatId, text, extra = {}) =>
  tg(env, cfg, 'sendMessage', { chat_id: chatId, text, disable_web_page_preview: false, ...extra });

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
  await send(env, cfg, chatId, t(lang).welcome(cfg.manager_contact),
    { reply_markup: mainKeyboard(lang) });
}

async function onGetLink(env, cfg, chatId, user) {
  const lang = await resolveLang(env, cfg, user.id);
  const refCode = refCodeFor(cfg.slug, user.id);
  const url = signupUrl(cfg, refCode);

  if (!url) {
    // Запись всё равно не делаем: bot_leads означает «ссылка выдана», а она не
    // выдана. Иначе счётчик выдач начал бы врать в большую сторону.
    await send(env, cfg, chatId, t(lang).linkMissing(cfg.manager_contact));
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

  await logEvent(env, cfg.slug, user.id, 'link_issued', refCode);
  await send(env, cfg, chatId, t(lang).link(url), { reply_markup: mainKeyboard(lang) });
}

async function onFaq(env, cfg, chatId, userId) {
  const lang = await resolveLang(env, cfg, userId);
  await logEvent(env, cfg.slug, userId, 'faq_opened', null);
  const rows = await sb(env, `bot_faq?lang=eq.${lang}&select=key,question,sort_order&order=sort_order`);
  await send(env, cfg, chatId, t(lang).faqTitle, {
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
  await send(env, cfg, chatId, answer || t(lang).faqEmpty(cfg.manager_contact));
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
  await logEvent(env, cfg.slug, userId, 'geo_checked', null);
  await setAwaiting(env, cfg.slug, userId, lang, null);
  await send(env, cfg, chatId, t(lang).geoIntro, {
    reply_markup: { inline_keyboard: [[
      { text: t(lang).geoBtnCountry, callback_data: 'geo:country' },
      { text: t(lang).geoBtnPdf,     callback_data: 'geo:pdf' },
    ]] },
  });
}

async function onGeoAskCountry(env, cfg, chatId, userId) {
  const lang = await resolveLang(env, cfg, userId);
  await setAwaiting(env, cfg.slug, userId, lang, 'geo');
  await send(env, cfg, chatId, t(lang).geoAsk);
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
    await send(env, cfg, chatId, t(lang).geoPdfMissing(cfg.manager_contact));
    return;
  }
  await tg(env, cfg, 'sendDocument', { chat_id: chatId, document: url });
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
  await logEvent(env, cfg.slug, userId, 'geo_checked', query);

  const hit = await sb(env, 'rpc/fn_find_geo', {
    method: 'POST', body: JSON.stringify({ q: query }),
  });
  if (hit.length) {
    await send(env, cfg, chatId, geoAnswer(lang, hit[0], cfg.manager_contact),
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
    await send(env, cfg, chatId, t(lang).geoDidYouMean(query), {
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
  await send(env, cfg, chatId,
    any.length ? t(lang).geoNotFound(query) : t(lang).geoEmpty(cfg.manager_contact),
    { reply_markup: geoAgainKeyboard(lang) });
}

async function onGeoById(env, cfg, chatId, userId, id) {
  const lang = await resolveLang(env, cfg, userId);
  const rows = await sb(env, `geo_availability?id=eq.${encodeURIComponent(id)}&select=*`);
  if (!rows.length) { await onGeoMenu(env, cfg, chatId, userId); return; }
  await send(env, cfg, chatId, geoAnswer(lang, rows[0], cfg.manager_contact),
    { reply_markup: geoAgainKeyboard(lang) });
}

async function onManager(env, cfg, chatId, userId) {
  const lang = await resolveLang(env, cfg, userId);
  await logEvent(env, cfg.slug, userId, 'manager_clicked', null);
  await send(env, cfg, chatId, t(lang).manager(cfg.manager_contact));

  // Только UPDATE. ТЗ §3.4: записи нет — не создавать, нажатие на «связаться»
  // не означает, что человек вообще собирался регистрироваться.
  await sb(env, `bot_leads?bot_slug=eq.${cfg.slug}&tg_user_id=eq.${userId}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ status: 'contacted_manager', last_interaction_at: new Date().toISOString() }),
  });
}

// Самоназвания языков: подпись кнопки читает тот, кто нужного языка сейчас не
// видит, поэтому «Русский», а не «Russian».
const LANG_NAMES = {
  en: 'English', ru: 'Русский', es: 'Español', fr: 'Français', uz: "O'zbekcha",
};

async function onLang(env, cfg, chatId, userId) {
  const lang = await resolveLang(env, cfg, userId);

  // Клавиатура собирается из списка языков, а не перечисляется руками: пока
  // она была списком из трёх кнопок, добавление языка означало правку в двух
  // местах, и второе (здесь) забывалось — язык существовал бы в коде, но
  // выбрать его было бы нечем.
  //
  // По две кнопки в ряд: пять подписей в одну строку Telegram сожмёт до
  // нечитаемого.
  const langs = Object.keys(T).filter(l => LANG_NAMES[l]);
  const rows = [];
  for (let i = 0; i < langs.length; i += 2) {
    rows.push(langs.slice(i, i + 2).map(l => ({ text: LANG_NAMES[l], callback_data: `lang:${l}` })));
  }

  await send(env, cfg, chatId, t(lang).langTitle, { reply_markup: { inline_keyboard: rows } });
}

// ── Роутинг апдейта ─────────────────────────────────────────────────────────
async function handleUpdate(env, cfg, update, origin) {
  if (update.callback_query) {
    const cq = update.callback_query;
    const chatId = cq.message && cq.message.chat.id;
    const userId = cq.from.id;
    const data = cq.data || '';
    // Отвечаем всегда — иначе кнопка в клиенте крутит часики до таймаута.
    await tg(env, cfg, 'answerCallbackQuery', { callback_query_id: cq.id });

    if (data.startsWith('lang:')) {
      const lang = data.slice(5);
      if (!T[lang]) return;
      await setLang(env, cfg.slug, userId, lang);
      await logEvent(env, cfg.slug, userId, 'lang_changed', lang);
      await send(env, cfg, chatId, t(lang).langSet, { reply_markup: mainKeyboard(lang) });
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

  if (text === '/start' || text.startsWith('/start ')) {
    // Учёт идёт ДО ответа и обёрнут так, чтобы не мешать ему: приветствие
    // человеку важнее записи в журнал (ТЗ §4). cfg.__sink подставляется
    // самотестом — в нём уведомления складываются в массив, а не летят Нику.
    try { await trackStart(env, cfg, user, cfg.__sink); }
    catch (e) { console.error('trackStart:', e && e.stack || e); }
    return onStart(env, cfg, chatId, user.id, true);
  }
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

// ── Журнал действий ─────────────────────────────────────────────────────────
// Пишется на каждое осмысленное действие. Из него считаются и воронка в
// /stats, и карточка в /user — до 056 фиксировалась ровно одна вещь, выдача
// ссылки, и то строкой в bot_leads.
//
// НИКОГДА не бросает. Журнал — это наблюдение за работой бота, а не сама
// работа: упавшая запись события не должна лишить человека ответа. Ровно так
// и ломался /start в своё время — ошибка в побочной записи съедала всё, что
// шло после неё.
async function logEvent(env, slug, userId, event, detail) {
  try {
    await sb(env, 'bot_user_events', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ bot_slug: slug, tg_user_id: userId, event,
                             detail: detail == null ? null : String(detail).slice(0, 200) }),
    });
  } catch (e) {
    console.error(`logEvent ${slug}/${event}:`, e && e.message);
  }
}

// ── Админ-бот ───────────────────────────────────────────────────────────────
// Живёт в ЭТОМ же воркере отдельным роутом (ТЗ §4): уведомление рождается
// вплотную к обработке /start, разносить их по разным воркерам значило бы
// гонять событие через сеть без причины.
//
// Получатель ровно один — ADMIN_CHAT_ID. Проверка стоит на каждом апдейте, и
// постороннему НЕ отвечаем ничем: ответ подтвердил бы, что бот существует.
const ADMIN_FLAGS = {
  india: '🇮🇳', africa: '🌍', bangladesh: '🇧🇩', worldwide: '🌐',
  afrique: '🇫🇷', uzbekistan: '🇺🇿', ru: '🇷🇺', latam: '🌎',
};
const botTitle = (slug, geoLabel) => `${ADMIN_FLAGS[slug] || '•'} ${geoLabel || slug} (${slug})`;

// Смещение часового пояса для показа времени. ТЗ показывает UTC+2; вынесено в
// переменную, чтобы поправить без правки кода.
const adminTzOffset = (env) => parseInt(env.ADMIN_TZ_OFFSET || '2', 10) || 0;

function fmtTime(iso, offsetH) {
  const d = new Date(new Date(iso).getTime() + offsetH * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} `
       + `${p(d.getUTCHours())}:${p(d.getUTCMinutes())} (UTC${offsetH >= 0 ? '+' : ''}${offsetH})`;
}

// sink — тот же приём, что у tg(): в самотесте деплоя сообщения складываются в
// массив вместо отправки. Без него каждый деплой писал бы Нику восемь раз.
async function adminTg(env, method, payload, sink) {
  if (sink) { sink.push({ admin: true, method, ...payload }); return null; }
  const token = env.ADMIN_BOT_TOKEN;
  if (!token) { console.error('ADMIN_BOT_TOKEN не задан — уведомление не ушло'); return null; }
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) console.error(`admin/${method} → ${res.status}: ${await res.text()}`);
  return res;
}

const adminSay = (env, text, extra = {}, sink) =>
  adminTg(env, 'sendMessage', {
    chat_id: env.ADMIN_CHAT_ID, text, parse_mode: 'HTML',
    disable_web_page_preview: true, ...extra,
  }, sink);

/** Кнопки под уведомлением. «Написать» — ссылка: у пользователя с юзернеймом
 *  берём t.me (работает во всех клиентах), без юзернейма — tg://user?id=,
 *  который открывается не везде, но другого способа нет. */
function adminLeadKeyboard(slug, userId, username, status) {
  const write = username
    ? { text: '✍️ Написать', url: `https://t.me/${username}` }
    : { text: '✍️ Написать', url: `tg://user?id=${userId}` };
  return { inline_keyboard: [
    [write, { text: status === 'in_work' ? '✅ В работе (отмечено)' : '✅ В работе',
              callback_data: `st:in_work:${slug}:${userId}` }],
    [{ text: status === 'spam' ? '🚫 Спам (отмечено)' : '🚫 Спам',
       callback_data: `st:spam:${slug}:${userId}` },
     { text: '📋 История', callback_data: `hist:${slug}:${userId}` }],
  ] };
}

/** Первый ли это /start в этом боте. Проверяется ДО записи события — иначе
 *  собственная запись и делала бы каждый старт «не первым». */
async function isFirstStart(env, slug, userId) {
  const rows = await sb(env,
    `bot_user_events?bot_slug=eq.${slug}&tg_user_id=eq.${userId}&event=eq.start&select=id&limit=1`);
  return !rows.length;
}

async function notifyAdminNewUser(env, cfg, user, sink) {
  const off = adminTzOffset(env);
  // Был ли уже в других ботах — это меняет смысл лида: человек ходит по
  // нескольким гео, а не пришёл впервые.
  let seenElsewhere = '';
  try {
    const prev = await sb(env,
      `bot_user_events?tg_user_id=eq.${user.id}&event=eq.start&bot_slug=neq.${cfg.slug}` +
      `&select=bot_slug,created_at&order=created_at.asc&limit=3`);
    if (prev.length) {
      const names = await sb(env, `bot_configs?select=slug,geo_label`);
      const label = (sl) => {
        const c = (names || []).find(x => x.slug === sl);
        return botTitle(sl, c && c.geo_label);
      };
      seenElsewhere = '\n\n⚠️ Этот пользователь уже был в: '
        + prev.map(p => `${label(p.bot_slug)} — ${fmtTime(p.created_at, off).split(' ')[0]}`).join(', ');
    }
  } catch (e) { console.error('notifyAdmin prev:', e && e.message); }

  const uname = user.username ? '@' + user.username : 'без username';
  const text =
    `🆕 <b>Новый пользователь</b>\n\n` +
    `Бот: ${botTitle(cfg.slug, cfg.geo_label)}\n` +
    `Юзер: ${uname}\n` +
    `ID: <code>${user.id}</code>\n` +
    `Имя: ${(user.first_name || '—')}${user.last_name ? ' ' + user.last_name : ''}\n` +
    `Язык TG: ${user.language_code || '—'}\n` +
    `Время: ${fmtTime(new Date().toISOString(), off)}` + seenElsewhere;

  await adminSay(env, text, { reply_markup: adminLeadKeyboard(cfg.slug, user.id, user.username, 'new') }, sink);
}

/** Обработка /start со стороны учёта: запись события и, если человек новый в
 *  этом боте, уведомление. Ошибка здесь не должна отражаться на пользователе —
 *  поэтому весь блок обёрнут вызывающим в try/catch (ТЗ §4). */
async function trackStart(env, cfg, user, sink) {
  let first = false;
  try { first = await isFirstStart(env, cfg.slug, user.id); }
  catch (e) { console.error('isFirstStart:', e && e.message); }

  await logEvent(env, cfg.slug, user.id, 'start', user.username ? '@' + user.username : null);

  // Юзернейм кладём в prefs, чтобы /user @name находил и тех, кто до ссылки не
  // дошёл: в bot_leads такие не появляются вовсе.
  //
  // lang берётся РАЗРЕШЁННЫМ, а не умолчанием бота. Первая версия писала сюда
  // cfg.default_lang, и это стирало выбор языка при каждом /start: человек
  // переключался на русский, перезаходил — и снова видел английский. Поймал
  // тест «/lang переживает следующий /start». Колонка объявлена NOT NULL без
  // умолчания, поэтому просто не передать её нельзя — нужно именно правильное
  // значение.
  if (user.username) {
    try {
      const lang = await resolveLang(env, cfg, user.id);
      await sb(env, 'bot_user_prefs?on_conflict=bot_slug,tg_user_id', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ bot_slug: cfg.slug, tg_user_id: user.id,
                               lang, tg_username: user.username }),
      });
    } catch (e) { console.error('username upsert:', e && e.message); }
  }

  if (first) await notifyAdminNewUser(env, cfg, user, sink);
}

// ── Админ-бот: команды ──────────────────────────────────────────────────────
const STATUS_RU = { new: 'новый', in_work: 'в работе', registered: 'зарегистрирован',
                    lost: 'потерян', spam: 'спам' };

const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0);

/** Сводка по воронке. Считает база (fn_bot_funnel): PostgREST не умеет
 *  GROUP BY, а тянуть все события в воркер и складывать в памяти — значит
 *  делать тем медленнее, чем успешнее боты. */
async function adminFunnel(env, sinceIso, title) {
  const rows = await sb(env, 'rpc/fn_bot_funnel', {
    method: 'POST', body: JSON.stringify({ p_since: sinceIso }),
  });
  const live = (rows || []).filter(r => Number(r.starts) > 0);   // ТЗ §2.3: нули не показываем
  if (!live.length) return `${title}\n\nПока пусто.`;
  const S = live.reduce((a, r) => a + Number(r.starts), 0);
  const L = live.reduce((a, r) => a + Number(r.links), 0);
  const M = live.reduce((a, r) => a + Number(r.managers), 0);
  const lines = live.map(r =>
    `${botTitle(r.bot_slug, r.geo_label)}\n` +
    `   ${r.starts} новых · ${r.links} ссылок · ${r.managers} менеджер`);
  return `${title}\n\n${lines.join('\n')}\n\n` +
         `<b>Итого:</b> ${S} новых · ${L} ссылок (${pct(L, S)}%) · ${M} менеджер (${pct(M, S)}%)`;
}

async function adminLast(env, n) {
  const rows = await sb(env,
    `bot_user_events?event=eq.start&tg_user_id=gt.0&select=bot_slug,tg_user_id,detail,created_at` +
    `&order=created_at.desc&limit=${Math.min(Math.max(n, 1), 50)}`);
  if (!rows.length) return 'Пока никого.';
  const off = adminTzOffset(env);
  return `📋 <b>Последние ${rows.length}</b>\n\n` + rows.map(r =>
    `${ADMIN_FLAGS[r.bot_slug] || '•'} <code>${r.tg_user_id}</code> ${r.detail || 'без username'}` +
    ` — ${fmtTime(r.created_at, off)}`).join('\n');
}

/** Карточка пользователя. Ищем и по id, и по юзернейму: юзернейм лежит в
 *  bot_user_prefs (пишется на каждом /start) и в bot_leads (только у дошедших
 *  до ссылки) — смотрим оба, иначе половина людей не находится. */
async function adminUserCard(env, query) {
  const off = adminTzOffset(env);
  let userId = null;
  if (/^\d+$/.test(query)) {
    userId = Number(query);
  } else {
    const uname = query.replace(/^@/, '');
    const p = await sb(env, `bot_user_prefs?tg_username=eq.${encodeURIComponent(uname)}&select=tg_user_id&limit=1`);
    if (p.length) userId = p[0].tg_user_id;
    if (userId === null) {
      const l = await sb(env, `bot_leads?tg_username=eq.${encodeURIComponent(uname)}&select=tg_user_id&limit=1`);
      if (l.length) userId = l[0].tg_user_id;
    }
  }
  if (userId === null) return `Не нашёл ${query}. Попробуй по ID.`;

  const ev = await sb(env,
    `bot_user_events?tg_user_id=eq.${userId}&select=bot_slug,event,detail,created_at&order=created_at.asc&limit=100`);
  if (!ev.length) return `По ${query} (ID <code>${userId}</code>) событий нет.`;

  const prefs = await sb(env, `bot_user_prefs?tg_user_id=eq.${userId}&select=bot_slug,lang,admin_status,tg_username`);
  const uname = (prefs[0] && prefs[0].tg_username) ? '@' + prefs[0].tg_username : 'без username';
  const bots = [...new Set(ev.map(e => e.bot_slug))];
  const statuses = prefs.map(p => `${p.bot_slug}: ${STATUS_RU[p.admin_status] || p.admin_status}`).join(', ');

  const EV_RU = { start: '/start', link_issued: 'взял ссылку', faq_opened: 'открыл FAQ',
                  geo_checked: 'проверил ГЕО', manager_clicked: 'к менеджеру',
                  lang_changed: 'сменил язык', reminder_sent: 'напоминание',
                  status_changed: 'статус' };
  const hist = ev.map(e =>
    `${fmtTime(e.created_at, off)} · ${ADMIN_FLAGS[e.bot_slug] || '•'} ${EV_RU[e.event] || e.event}` +
    (e.detail ? ` — ${e.detail}` : '')).join('\n');

  return `👤 <b>${uname}</b>\nID: <code>${userId}</code>\n` +
         `Боты: ${bots.join(', ')}\nСтатус: ${statuses || 'новый'}\n\n` +
         `<b>История</b>\n${hist}`;
}

const ADMIN_HELP =
  '🛠 <b>Команды</b>\n\n' +
  '/today — сводка за сегодня\n' +
  '/week — за 7 дней\n' +
  '/stats — за всё время\n' +
  '/last [N] — последние N пользователей (по умолчанию 10)\n' +
  '/user @name или /user 123456789 — карточка и вся история\n' +
  '/help — это сообщение';

/** Пометка статуса из админ-бота.
 *
 *  Строка правится, а не перезаписывается: upsert со своим lang затёр бы язык,
 *  выбранный самим человеком, — та же ловушка, что и в trackStart. Здесь она
 *  опаснее, потому что срабатывала бы от действия Ника, а страдал бы
 *  пользователь. */
async function setLeadStatus(env, slug, userId, status) {
  const rows = await sb(env,
    `bot_user_prefs?bot_slug=eq.${slug}&tg_user_id=eq.${userId}&select=lang`);
  if (rows.length) {
    await sb(env, `bot_user_prefs?bot_slug=eq.${slug}&tg_user_id=eq.${userId}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ admin_status: status, updated_at: new Date().toISOString() }),
    });
  } else {
    // Строки нет — человек в этом боте не появлялся, но пометить его всё равно
    // можно (например из карточки). Язык берём умолчанием бота: своего у него
    // ещё нет, а колонка NOT NULL.
    const cfg = await loadConfig(env, slug);
    await sb(env, 'bot_user_prefs', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ bot_slug: slug, tg_user_id: userId,
                             lang: (cfg && cfg.default_lang) || 'en', admin_status: status }),
    });
  }
  await logEvent(env, slug, userId, 'status_changed', status);
}

async function handleAdminUpdate(env, update, sink) {
  const msg = update.message;
  const cq  = update.callback_query;
  const from = (msg && msg.from) || (cq && cq.from);
  // Посторонним не отвечаем ВООБЩЕ (ТЗ §4): любой ответ подтвердил бы, что бот
  // существует и слушает.
  if (!from || String(from.id) !== String(env.ADMIN_CHAT_ID)) return;

  if (cq) {
    await adminTg(env, 'answerCallbackQuery', { callback_query_id: cq.id }, sink);
    const d = String(cq.data || '');
    const m = d.match(/^st:(in_work|spam):([a-z]+):(-?\d+)$/);
    if (m) {
      await setLeadStatus(env, m[2], Number(m[3]), m[1]);
      // Перерисовываем ТУ ЖЕ клавиатуру с отметкой, а не шлём новое сообщение:
      // иначе список уведомлений быстро превращается в кашу из дублей.
      await adminTg(env, 'editMessageReplyMarkup', {
        chat_id: cq.message.chat.id, message_id: cq.message.message_id,
        reply_markup: adminLeadKeyboard(m[2], Number(m[3]), null, m[1]),
      }, sink);
      return;
    }
    const h = d.match(/^hist:([a-z]+):(-?\d+)$/);
    if (h) { await adminSay(env, await adminUserCard(env, h[2]), {}, sink); return; }
    return;
  }

  const text = String((msg && msg.text) || '').trim();
  const off  = adminTzOffset(env);

  if (text.startsWith('/today')) {
    // Начало суток в часовом поясе Ника, а не в UTC: «сегодня» для человека
    // начинается там, где он живёт.
    const now = new Date(Date.now() + off * 3600 * 1000);
    const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
                           - off * 3600 * 1000).toISOString();
    const d = new Date(Date.now() + off * 3600 * 1000);
    const title = `📊 <b>Сегодня, ${String(d.getUTCDate()).padStart(2,'0')}.`
                + `${String(d.getUTCMonth()+1).padStart(2,'0')}.${d.getUTCFullYear()}</b>`;
    return void await adminSay(env, await adminFunnel(env, since, title), {}, sink);
  }
  if (text.startsWith('/week')) {
    const since = new Date(Date.now() - 7 * 86400e3).toISOString();
    return void await adminSay(env, await adminFunnel(env, since, '📊 <b>За 7 дней</b>'), {}, sink);
  }
  if (text.startsWith('/stats')) {
    return void await adminSay(env, await adminFunnel(env, null, '📊 <b>За всё время</b>'), {}, sink);
  }
  if (text.startsWith('/last')) {
    const n = parseInt(text.split(/\s+/)[1], 10);
    return void await adminSay(env, await adminLast(env, Number.isFinite(n) ? n : 10), {}, sink);
  }
  if (text.startsWith('/user')) {
    const q = text.split(/\s+/)[1];
    if (!q) return void await adminSay(env, 'Как пользоваться: /user @name или /user 123456789', {}, sink);
    return void await adminSay(env, await adminUserCard(env, q), {}, sink);
  }
  // /help, /start и всё остальное — короткая справка. Админ-бот не ведёт
  // диалогов: любое непонятое сообщение это промах по команде.
  return void await adminSay(env, ADMIN_HELP, {}, sink);
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
      await send(env, cfg, lead.tg_user_id, t(lang).reminder(url, cfg.manager_contact));
      await logEvent(env, cfg.slug, lead.tg_user_id, 'reminder_sent', null);
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

    // ── Сквозной самотест ───────────────────────────────────────────────────
    // POST /selftest/{slug} с тем же секретом, что у вебхука.
    //
    // Проверки БД (/health) говорят, что воркер видит базу, но НИЧЕГО не
    // говорят о пути «пришёл апдейт → бот ответил» — а ломался именно он, и
    // ровно этот путь я до сих пор ни разу не проверял на живом воркере.
    // Здесь прогоняется настоящий handleUpdate, только вместо обращения к
    // Telegram ответы складываются в приёмник и возвращаются вызывающему.
    //
    // Закрыт тем же секретом, что и вебхук: иначе любой желающий гонял бы
    // обработчики чужого бота.
    const st = url.pathname.match(/^\/selftest\/([a-z]+)\/?$/);
    if (st) {
      const slug = st[1];
      if (!SLUGS.includes(slug)) return new Response('unknown bot', { status: 404 });
      if (!verifyWebhookSecret(request, env, slug)) return new Response('unauthorized', { status: 401 });
      let body = {};
      try { body = await request.json(); } catch (_) {}
      const text = typeof body.text === 'string' ? body.text : '/start';
      const data = typeof body.callback_data === 'string' ? body.callback_data : null;
      // Отрицательный id: настоящих пользователей с таким не бывает, поэтому
      // самотест не может задеть чью-то запись в bot_user_prefs или bot_leads.
      const uid = -1;

      const out = { build: BUILD, slug, input: data ? `callback:${data}` : text, sent: [] };
      try {
        const cfg = await loadConfig(env, slug);
        if (!cfg) { out.error = 'нет строки в bot_configs'; }
        else if (!cfg.active) { out.error = 'бот выключен (active=false)'; }
        else {
          cfg.__sink = out.sent;
          const update = data
            ? { callback_query: { id: 'selftest', from: { id: uid }, data, message: { chat: { id: uid } } } }
            : { message: { chat: { id: uid }, from: { id: uid, username: 'selftest' }, text } };
          await handleUpdate(env, cfg, update, url.origin);
        }
      } catch (e) {
        // Здесь ошибка НЕ проглатывается, в отличие от боевого пути: там 200
        // обязателен, иначе Telegram уходит в бесконечные повторы.
        out.error = (e && e.stack || String(e)).split('\n').slice(0, 4).join(' | ');
      }
      out.ok = !out.error && out.sent.length > 0;
      return new Response(JSON.stringify(out, null, 2), {
        status: out.ok ? 200 : 500,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }

    // ── Админ-бот ───────────────────────────────────────────────────────────
    // Тот же секрет вебхука, что у партнёрских: Telegram присылает его
    // заголовком, и без него роут не отвечает никому.
    if (url.pathname === '/admin-bot' || url.pathname === '/admin-bot/') {
      if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
      const expected = env.BOT_WEBHOOK_SECRET;
      if (!expected || request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== expected) {
        return new Response('unauthorized', { status: 401 });
      }
      // 200 всегда, как и партнёрским: иначе Telegram уходит в бесконечные
      // повторы одного и того же апдейта.
      try { await handleAdminUpdate(env, await request.json(), null); }
      catch (e) { console.error('admin-bot update failed:', e && e.stack || e); }
      return new Response('OK');
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
