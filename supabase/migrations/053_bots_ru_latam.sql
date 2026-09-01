-- 053 — ещё два бота: русскоязычный и LATAM
--
-- Кода они не добавляют ни строки: воркер разбирает конфиг из bot_configs, а
-- тексты берёт по языку. Всё, что нужно новому боту — строка здесь, токен в
-- секретах Cloudflare и setWebhook (оба делает воркфлоу деплоя).
--
-- ── Почему LATAM на испанском, а не на английском ───────────────────────────
-- Ник предложил английский и сам просил проверить. Проверять тут особо нечего:
-- испанский — рабочий язык почти всей Латинской Америки, и партнёр, читающий
-- условия выплат на неродном языке, чаще уходит к менеджеру с вопросом, чем
-- регистрируется. Английский при этом никуда не девается: /lang переключает
-- на любой из пяти языков, включая английский, и выбор запоминается.
--
-- Крупное исключение — Бразилия: там португальский, и испанский её НЕ
-- покрывает. Отдельный pt-BR добавляется ровно так же (блок в T + строка
-- здесь), но выдумывать сейчас бота, которого не просили, я не стал.

-- ── 1. Конфигурация ─────────────────────────────────────────────────────────
-- Ссылка не пишется literal'ом второй раз: она уже задана остальным ботам
-- (050), и продублированная строка разъехалась бы при первом же изменении —
-- новые боты молча остались бы со старым адресом.
INSERT INTO public.bot_configs (slug, geo_label, default_lang, signup_url_tpl)
SELECT v.slug, v.geo_label, v.default_lang,
       (SELECT signup_url_tpl FROM public.bot_configs WHERE slug = 'india')
  FROM (VALUES
    ('ru',    'Russian-speaking', 'ru'),
    ('latam', 'Latin America',    'es')
  ) AS v(slug, geo_label, default_lang)
ON CONFLICT (slug) DO UPDATE
  SET geo_label      = EXCLUDED.geo_label,
      default_lang   = EXCLUDED.default_lang,
      signup_url_tpl = EXCLUDED.signup_url_tpl;

-- Контакт менеджера остаётся общим (@aff_manager_xbet — умолчание колонки).
-- Если у русскоязычного и LATAM-сегмента менеджеры разные, это один UPDATE,
-- без передеплоя:
--   UPDATE public.bot_configs SET manager_contact = '@...' WHERE slug = 'latam';

-- ── 2. FAQ на русском и испанском ───────────────────────────────────────────
-- Точный перевод текстов из 051, а не пересказ: это утверждения об условиях
-- выплат и лицензиях (ТЗ §5 запрещает отсебятину в фактах). Ни одного нового
-- факта здесь нет — ни процента, ни срока, ни страны сверх того, что уже
-- утверждено на английском.
INSERT INTO public.bot_faq (lang, key, question, answer, sort_order) VALUES
  ('ru','payouts','💵 Выплаты',
   E'Выплаты проводятся еженедельно, каждый вторник, для всех стран.\n\nВывод: средства поступают на игровой счёт — оттуда их можно вывести любым доступным способом или подключить криптокошелёк напрямую.', 1),
  ('ru','revshare','📊 Условия RevShare',
   E'Стандартная стартовая ставка: 25% чистого RevShare, без admin fee.\n\nВаша фактическая ставка обсуждается индивидуально — фиксированного минимального порога по трафику нет, условия определяются по вашему конкретному случаю.\n\nОбсудить свою ставку с менеджером: @aff_manager_xbet', 2),
  ('ru','license','🔒 Есть лицензия?',
   E'1xBet имеет официальные локальные лицензии на многих своих рынках. Статус лицензии зависит от страны — нажмите «Проверить ГЕО», чтобы увидеть текущий статус по вашему рынку.', 3),

  ('es','payouts','💵 Pagos',
   E'Los pagos se procesan semanalmente, todos los martes, para todos los países.\n\nRetiro: los fondos llegan a la cuenta de juego — desde ahí puedes retirarlos por cualquier método disponible o conectar directamente un monedero cripto.', 1),
  ('es','revshare','📊 Condiciones de RevShare',
   E'Tarifa inicial estándar: 25% de RevShare limpio, sin admin fee.\n\nTu tarifa real se acuerda de forma individual — no hay un umbral mínimo de tráfico fijo, las condiciones se establecen según tu caso concreto.\n\nHabla con tu manager para acordar tu tarifa: @aff_manager_xbet', 2),
  ('es','license','🔒 ¿Tiene licencia?',
   E'1xBet cuenta con licencias locales oficiales en muchos de sus mercados. El estado de la licencia varía según el país — pulsa «Consultar GEO» para ver el estado actual de tu mercado.', 3)
ON CONFLICT (lang, key) DO UPDATE
  SET question   = EXCLUDED.question,
      answer     = EXCLUDED.answer,
      sort_order = EXCLUDED.sort_order;

-- ── 3. Испанские названия стран ─────────────────────────────────────────────
-- Справочник ГЕО пришёл из PDF с колонками geo_en и geo_ru — испанской в нём
-- нет. Русскоязычному боту это ничем не грозит (поиск сверяется с geo_ru), а
-- испаноязычный партнёр напишет «México» или «Brasil», и точного совпадения не
-- будет.
--
-- Полагаться на нечёткий поиск здесь нельзя принципиально: он не отвечает, а
-- предлагает варианты (051 — «Nigeira» ближе к Niger, чем к Nigeria). То есть
-- без синонимов испаноязычный бот на половину своего же региона отвечал бы
-- «уточните, что вы имели в виду».
--
-- Это вопрос НАЗВАНИЯ, а не доступности: «Brasil» и «Brazil» — одна страна
-- независимо от условий программы, поэтому заполнять их мне можно (см. 051).
INSERT INTO public.geo_aliases (alias, iso_code) VALUES
  -- Латинская Америка — основной регион этого бота
  ('méxico','MX'), ('mexico','MX'),
  ('brasil','BR'),
  ('perú','PE'), ('peru','PE'),
  ('república dominicana','DO'), ('republica dominicana','DO'),
  ('panamá','PA'), ('panama','PA'),
  ('haití','HT'), ('haiti','HT'),
  ('belice','BZ'),
  ('argentina','AR'), ('chile','CL'), ('colombia','CO'), ('bolivia','BO'),
  ('ecuador','EC'), ('paraguay','PY'), ('uruguay','UY'), ('venezuela','VE'),
  ('costa rica','CR'), ('guatemala','GT'), ('honduras','HN'),
  ('nicaragua','NI'), ('el salvador','SV'), ('cuba','CU'),
  ('puerto rico','PR'),
  -- Прочие страны по-испански: спрашивают и о них
  ('estados unidos','US'), ('eeuu','US'),
  ('españa','ES'), ('espana','ES'),
  ('alemania','DE'), ('francia','FR'), ('italia','IT'), ('portugal','PT'),
  ('reino unido','GB'), ('canadá','CA'), ('canada','CA'),
  ('japón','JP'), ('japon','JP'),
  ('turquía','TR'), ('turquia','TR'),
  ('rusia','RU'), ('india','IN'),
  ('marruecos','MA'), ('egipto','EG'), ('sudáfrica','ZA'), ('sudafrica','ZA'),
  ('kenia','KE'), ('filipinas','PH'), ('tailandia','TH'),
  ('emiratos árabes unidos','AE'), ('emiratos arabes unidos','AE')
ON CONFLICT (alias) DO NOTHING;

-- ── 4. Проверка ─────────────────────────────────────────────────────────────
DO $$
DECLARE n INT; miss TEXT;
BEGIN
  SELECT count(*) INTO n FROM public.bot_configs;
  IF n <> 8 THEN RAISE EXCEPTION 'ожидалось 8 конфигов ботов, найдено %', n; END IF;

  -- Пустая ссылка = главная кнопка бота отвечает «не настроено». Тихо и
  -- заметно только вручную, поэтому проверяется здесь.
  SELECT count(*) INTO n FROM public.bot_configs WHERE coalesce(signup_url_tpl,'') = '';
  IF n > 0 THEN RAISE EXCEPTION 'у % ботов пустая ссылка регистрации', n; END IF;

  -- Один адрес на всех: расхождение означало бы, что 050 применилась не ко
  -- всем, и часть партнёров получает другую ссылку.
  SELECT count(DISTINCT signup_url_tpl) INTO n FROM public.bot_configs;
  IF n <> 1 THEN RAISE EXCEPTION 'ссылка регистрации разошлась: % разных значений', n; END IF;

  -- Язык бота без текстов FAQ — это бот, у которого кнопка «Вопросы и ответы»
  -- открывает пустой список. Проверяем именно связь конфиг → FAQ, а не число
  -- строк: число сойдётся и при перекосе.
  SELECT string_agg(DISTINCT c.slug || ':' || c.default_lang, ', ') INTO miss
    FROM public.bot_configs c
   WHERE NOT EXISTS (SELECT 1 FROM public.bot_faq f WHERE f.lang = c.default_lang);
  IF miss IS NOT NULL THEN
    RAISE EXCEPTION 'у этих ботов нет FAQ на их языке: %', miss;
  END IF;

  SELECT count(*) INTO n FROM public.bot_faq;
  IF n <> 15 THEN RAISE EXCEPTION 'ожидалось 15 записей FAQ (3 пункта × 5 языков), найдено %', n; END IF;

  SELECT count(*) INTO n FROM public.bot_faq WHERE btrim(answer) = '';
  IF n > 0 THEN RAISE EXCEPTION '% ответов FAQ пусты — бот отдаст контакт менеджера вместо текста', n; END IF;

  -- Синоним, не совпавший ни с одной строкой справочника, молча не работает:
  -- поиск просто вернёт «не найдено». Считаем, сколько таких.
  SELECT count(*) INTO n
    FROM public.geo_aliases a
   WHERE NOT EXISTS (SELECT 1 FROM public.geo_availability g
                      WHERE lower(g.iso_code) = lower(a.iso_code));
  RAISE NOTICE '8 ботов, FAQ на 5 языках; синонимов без страны в справочнике: %', n;
END $$;
