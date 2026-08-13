-- ═══════════════════════════════════════════════════════════════════════════
-- AffiliateOS v8 — модуль «Brand» (бренд-трафик)
--
-- ЗАЧЕМ
-- Третий независимый пайплайн, наравне с search и dataforseo. Человек, который
-- ищет «mostbet apk» или «bet9ja app download», уже выбрал бренд — его не надо
-- прогревать, он идёт скачивать. Конверсия в депозит кратно выше обзорников;
-- подтверждённый кейс — партнёр в Узбекистане делает 35 000 FTD в месяц чисто
-- на APK-трафе.
--
-- ПОЧЕМУ ВЫДАЧА САМООТФИЛЬТРОВАНА
-- По брендовому запросу первую позицию занимает сам оператор, а позиции 2-50 —
-- практически исключительно аффилиаты, перехватывающие этот трафик. Новостникам
-- и статистическим сервисам там делать нечего: они по таким запросам не
-- ранжируются. Значит выдача по брендам конкурентов И ЕСТЬ готовый список
-- бренд-трафовых партнёров, и фильтрацию за нас делает поисковик.
--
-- ПРАВИЛО ОТБОРА
-- Пишем всем, КРОМЕ официальных операторских доменов. Аффилиаты Melbet, 22bet,
-- BetWinner, Megapari, Paripesa, Linebet — это ЦЕЛИ, а не исключения:
-- формально отдельные бренды, такому партнёру предлагаем 1xBet за счёт более
-- высокого LTV продукта.
--
-- Блокировка — ЯВНЫЙ СПИСОК доменов, не эвристика. Это принципиально: у
-- 1win.fyi (аффилиат) название бренда занимает весь домен второго уровня ровно
-- так же, как у 1win.com (оператор). По маске их не различить, и любая
-- эвристика будет либо пропускать операторов, либо выбрасывать лучшие цели.
--
-- Идемпотентно: можно перезапускать.
-- ═══════════════════════════════════════════════════════════════════════════


-- ── 1.1 Бренды-цели: связка бренд × ГЕО × язык ─────────────────────────────
CREATE TABLE IF NOT EXISTS public.brand_targets (
  id            BIGSERIAL PRIMARY KEY,
  brand         TEXT NOT NULL,          -- 'Mostbet', '1win', 'Bet9ja'...
  geo           TEXT NOT NULL,          -- ISO: UZ, NG, KE, SN...
  lang          TEXT NOT NULL,          -- ru, uz, en, fr, pt, bn, hi, sw, tr
  -- Слово страны на языке рынка. Нужно генератору: «1win» продаётся в UZ, CM и
  -- BD, и без гео-токена все три дали бы один и тот же запрос «1win apk» —
  -- то есть мы бы трижды покупали одну выдачу и дважды выбрасывали её дедупом.
  geo_word      TEXT,
  priority      INT DEFAULT 5,          -- 1 = обрабатывать первым
  active        BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (brand, geo, lang)
);

ALTER TABLE public.brand_targets DISABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.brand_targets TO anon, authenticated, service_role;
GRANT USAGE, SELECT ON SEQUENCE public.brand_targets_id_seq TO anon, authenticated, service_role;


-- ── 1.2 Модификаторы по языкам ─────────────────────────────────────────────
-- Отдельной таблицей, а не списком в коде: ключи собираются декартовым
-- произведением бренд × модификатор, и добавление модификатора должно быть
-- строкой в базе, а не деплоем функции.
CREATE TABLE IF NOT EXISTS public.brand_modifiers (
  id        BIGSERIAL PRIMARY KEY,
  lang      TEXT NOT NULL,
  modifier  TEXT NOT NULL,
  active    BOOLEAN DEFAULT TRUE,
  UNIQUE (lang, modifier)
);

ALTER TABLE public.brand_modifiers DISABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.brand_modifiers TO anon, authenticated, service_role;
GRANT USAGE, SELECT ON SEQUENCE public.brand_modifiers_id_seq TO anon, authenticated, service_role;


-- ── 1.3 Брендовые ключи (генерируются) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.brand_keywords (
  id               BIGSERIAL PRIMARY KEY,
  brand_target_id  BIGINT REFERENCES public.brand_targets(id) ON DELETE CASCADE,
  keyword          TEXT NOT NULL,
  modifier         TEXT,
  lang             TEXT,
  active           BOOLEAN DEFAULT TRUE,
  runs             INT DEFAULT 0,
  urls_found       INT DEFAULT 0,
  leads_created    INT DEFAULT 0,
  last_run_at      TIMESTAMPTZ,
  UNIQUE (brand_target_id, keyword)
);
-- Обход пула строго по last_run_at NULLS FIRST — гарантирует, что каждый ключ
-- дойдёт до очереди, а не что мы вечно крутим первые пять, как это случилось с
-- layer A основного пайплайна (см. миграцию 028).
CREATE INDEX IF NOT EXISTS brand_kw_active
  ON public.brand_keywords (brand_target_id, last_run_at NULLS FIRST) WHERE active = TRUE;
CREATE INDEX IF NOT EXISTS brand_kw_rotation
  ON public.brand_keywords (last_run_at NULLS FIRST) WHERE active = TRUE;

ALTER TABLE public.brand_keywords DISABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.brand_keywords TO anon, authenticated, service_role;
GRANT USAGE, SELECT ON SEQUENCE public.brand_keywords_id_seq TO anon, authenticated, service_role;


-- ── 1.4 Блок-лист официальных операторских доменов ─────────────────────────
CREATE TABLE IF NOT EXISTS public.official_domains (
  id       BIGSERIAL PRIMARY KEY,
  domain   TEXT UNIQUE NOT NULL,
  brand    TEXT,
  note     TEXT,
  added_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.official_domains DISABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.official_domains TO anon, authenticated, service_role;
GRANT USAGE, SELECT ON SEQUENCE public.official_domains_id_seq TO anon, authenticated, service_role;


-- ── 1.5 Расширение leads под бренд-пайплайн ────────────────────────────────
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS brand_found        TEXT;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS serp_position      INT;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS traffic_type       TEXT;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS has_apk            BOOLEAN;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS ref_params         JSONB;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS suspected_official BOOLEAN DEFAULT FALSE;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS brand_keyword_id   BIGINT;

ALTER TABLE public.leads      ADD COLUMN IF NOT EXISTS pipeline TEXT DEFAULT 'search';
ALTER TABLE public.send_queue ADD COLUMN IF NOT EXISTS pipeline TEXT DEFAULT 'search';
ALTER TABLE public.email_log  ADD COLUMN IF NOT EXISTS pipeline TEXT DEFAULT 'search';

CREATE INDEX IF NOT EXISTS leads_brand_pipeline
  ON public.leads (pipeline, fit_score DESC NULLS LAST) WHERE pipeline = 'brand';


-- ── 1.6 Лимит отправки ─────────────────────────────────────────────────────
-- paused = TRUE намеренно: текста заходного письма для этого пайплайна ещё нет,
-- а очередь без шаблона отправила бы людям письмо основного пайплайна, которое
-- под бренд-трафик не написано. Снимать паузу вместе с заливкой шаблона.
INSERT INTO public.pipeline_limits (pipeline, daily_limit, paused)
VALUES ('brand', 50, TRUE)
ON CONFLICT (pipeline) DO UPDATE SET daily_limit = 50;


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. БЛОК-ЛИСТ ОФИЦИАЛЬНЫХ ДОМЕНОВ
-- Блокируются ТОЛЬКО эти домены. Всё остальное — цели, включая аффилиатов
-- нашей же группы брендов.
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO public.official_domains (domain, brand, note) VALUES
  -- Наша группа
  ('1xbet.com','1xBet','наш оператор'), ('1xcasino.com','1xCasino','наш оператор'),
  ('melbet.com','Melbet','наш оператор'), ('betwinner.com','BetWinner','наш оператор'),
  ('megapari.com','Megapari','наш оператор'), ('paripesa.com','Paripesa','наш оператор'),
  ('22bet.com','22bet','наш оператор'), ('linebet.com','Linebet','наш оператор'),
  ('luckypari.com','LuckyPari','наш оператор'),
  -- Национальные версии нашей группы
  ('1xbet.ng','1xBet','нац. версия'), ('1xbet.co.ke','1xBet','нац. версия'),
  ('1xbet.uz','1xBet','нац. версия'), ('1xbet.com.gh','1xBet','нац. версия'),
  ('1xbet.cm','1xBet','нац. версия'), ('1xbet.sn','1xBet','нац. версия'),
  ('1xbet.co.tz','1xBet','нац. версия'), ('1xbet.ug','1xBet','нац. версия'),
  ('1xbet.co.zm','1xBet','нац. версия'), ('1xbet.in','1xBet','нац. версия'),
  ('1xbet.com.bd','1xBet','нац. версия'), ('1xbet.kz','1xBet','нац. версия'),
  ('melbet.ng','Melbet','нац. версия'), ('melbet.co.ke','Melbet','нац. версия'),
  ('melbet.uz','Melbet','нац. версия'), ('melbet.cm','Melbet','нац. версия'),
  ('melbet.in','Melbet','нац. версия'), ('melbet-bd.com','Melbet','нац. версия'),
  ('22bet.co.ke','22bet','нац. версия'), ('22bet.ng','22bet','нац. версия'),
  ('22bet.uz','22bet','нац. версия'),
  ('betwinner.ng','BetWinner','нац. версия'), ('betwinner.co.ke','BetWinner','нац. версия'),
  ('linebet.uz','Linebet','нац. версия'), ('linebet.in','Linebet','нац. версия'),
  -- Конкуренты: CIS / Центральная Азия
  ('1win.com','1win','оператор'), ('mostbet.com','Mostbet','оператор'),
  ('pin-up.casino','Pin-Up','оператор'), ('pinup.ru','Pin-Up','оператор'),
  ('parimatch.com','Parimatch','оператор'), ('leon.ru','Leon','оператор'),
  ('marathonbet.com','Marathonbet','оператор'), ('fonbet.ru','Fonbet','оператор'),
  ('winline.ru','Winline','оператор'), ('mostbet.uz','Mostbet','нац. версия'),
  ('1win.uz','1win','нац. версия'), ('pin-up.uz','Pin-Up','нац. версия'),
  ('parimatch.uz','Parimatch','нац. версия'), ('mostbet.kz','Mostbet','нац. версия'),
  -- Конкуренты: Африка
  ('bet9ja.com','Bet9ja','оператор'), ('sportybet.com','SportyBet','оператор'),
  ('betking.com','BetKing','оператор'), ('nairabet.com','NairaBet','оператор'),
  ('merrybet.com','MerryBet','оператор'), ('betika.com','Betika','оператор'),
  ('sportpesa.com','SportPesa','оператор'), ('odibets.com','Odibets','оператор'),
  ('mozzartbet.com','Mozzartbet','оператор'), ('betway.com','Betway','оператор'),
  ('betpawa.com','Betpawa','оператор'), ('soccabet.com','Soccabet','оператор'),
  ('fortebet.ug','Fortebet','оператор'), ('gsb.co.ug','Gal Sport','оператор'),
  ('premierbet.com','Premier Bet','оператор'), ('betclic.com','Betclic','оператор'),
  ('sunubet.com','Sunubet','оператор'), ('meridianbet.com','Meridianbet','оператор'),
  ('betway.co.ke','Betway','нац. версия'), ('betway.com.gh','Betway','нац. версия'),
  ('betway.co.tz','Betway','нац. версия'), ('betway.co.zm','Betway','нац. версия'),
  ('betpawa.ng','Betpawa','нац. версия'), ('betpawa.co.ke','Betpawa','нац. версия'),
  ('betpawa.com.gh','Betpawa','нац. версия'), ('betpawa.ug','Betpawa','нац. версия'),
  ('betika.co.ke','Betika','нац. версия'), ('mozzartbet.co.ke','Mozzartbet','нац. версия'),
  ('premierbet.cm','Premier Bet','нац. версия'), ('premierbet.sn','Premier Bet','нац. версия'),
  ('premierbet.ci','Premier Bet','нац. версия'), ('premierbet.co.mz','Premier Bet','нац. версия'),
  ('sportybet.com.gh','SportyBet','нац. версия'), ('sportybet.ug','SportyBet','нац. версия'),
  ('hulusport.com','HulusPort','оператор'), ('abyssiniabet.com','Abyssinia Bet','оператор'),
  -- Конкуренты: Азия / LATAM
  ('betano.com','Betano','оператор'), ('rajabets.com','Rajabets','оператор'),
  ('parimatch.in','Parimatch','нац. версия'), ('dafabet.com','Dafabet','оператор'),
  ('10cric.com','10CRIC','оператор')
ON CONFLICT (domain) DO NOTHING;


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. МОДИФИКАТОРЫ
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO public.brand_modifiers (lang, modifier) VALUES
  -- RU
  ('ru','скачать'),('ru','апк'),('ru','apk'),('ru','скачать apk'),('ru','зеркало'),
  ('ru','рабочее зеркало'),('ru','официальный сайт'),('ru','вход'),('ru','регистрация'),
  ('ru','приложение'),('ru','скачать на андроид'),('ru','промокод'),('ru','бонус код'),
  ('ru','зеркало сегодня'),
  -- UZ
  ('uz','yuklab olish'),('uz','ilova'),('uz','rasmiy sayt'),('uz','ro''yxatdan o''tish'),
  ('uz','apk'),('uz','skachat'),('uz','kirish'),('uz','promokod'),
  -- EN
  ('en','apk'),('en','app'),('en','download'),('en','apk download'),('en','app download'),
  ('en','download apk'),('en','mirror'),('en','official site'),('en','login'),
  ('en','registration'),('en','sign up'),('en','android app'),('en','free download'),
  ('en','promo code'),('en','bonus code'),
  -- FR
  ('fr','télécharger'),('fr','apk'),('fr','application'),('fr','site officiel'),
  ('fr','connexion'),('fr','inscription'),('fr','miroir'),('fr','télécharger apk'),
  ('fr','code promo'),('fr','application android'),
  -- PT
  ('pt','baixar'),('pt','apk'),('pt','aplicativo'),('pt','site oficial'),('pt','entrar'),
  ('pt','cadastro'),('pt','baixar apk'),('pt','codigo promocional'),
  -- BN
  ('bn','app download'),('bn','apk download bangladesh'),('bn','login'),
  ('bn','registration'),('bn','promo code'),
  -- HI
  ('hi','app download'),('hi','apk'),('hi','download india'),('hi','login'),('hi','promo code'),
  -- SW (Танзания). В ТЗ язык указан, но список модификаторов не задан —
  -- взят минимальный набор, в котором нет сомнений. Расширять по результатам,
  -- а не угадывать: неверный модификатор даёт пустую выдачу, а не плохую.
  ('sw','apk'),('sw','pakua'),('sw','programu'),('sw','login'),('sw','bonus'),
  -- TR. Та же оговорка, что и по SW.
  ('tr','indir'),('tr','apk'),('tr','uygulama'),('tr','giriş'),('tr','güncel giriş'),
  ('tr','promosyon kodu')
ON CONFLICT (lang, modifier) DO NOTHING;


-- ═══════════════════════════════════════════════════════════════════════════
-- 4. БРЕНДЫ ПО ГЕО
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO public.brand_targets (brand, geo, lang, geo_word, priority) VALUES
  -- UZ — подтверждённый кейс, приоритет 1
  ('Mostbet','UZ','ru','узбекистан',1), ('1win','UZ','ru','узбекистан',1),
  ('Pin-Up','UZ','ru','узбекистан',1), ('Parimatch','UZ','ru','узбекистан',1),
  ('Melbet','UZ','ru','узбекистан',1), ('22bet','UZ','ru','узбекистан',1),
  ('Linebet','UZ','ru','узбекистан',1), ('BetWinner','UZ','ru','узбекистан',1),
  ('Mostbet','UZ','uz','uzbekistan',1), ('1win','UZ','uz','uzbekistan',1),
  ('Pin-Up','UZ','uz','uzbekistan',1), ('Parimatch','UZ','uz','uzbekistan',1),
  ('Melbet','UZ','uz','uzbekistan',1), ('22bet','UZ','uz','uzbekistan',1),
  ('Linebet','UZ','uz','uzbekistan',1), ('BetWinner','UZ','uz','uzbekistan',1),
  -- KZ
  ('Mostbet','KZ','ru','казахстан',3), ('1win','KZ','ru','казахстан',3),
  ('Pin-Up','KZ','ru','казахстан',3), ('Parimatch','KZ','ru','казахстан',3),
  ('Melbet','KZ','ru','казахстан',3),
  -- NG
  ('Bet9ja','NG','en','nigeria',1), ('SportyBet','NG','en','nigeria',1),
  ('BetKing','NG','en','nigeria',1), ('NairaBet','NG','en','nigeria',1),
  ('MerryBet','NG','en','nigeria',1), ('BetWinner','NG','en','nigeria',1),
  ('22bet','NG','en','nigeria',1),
  -- KE
  ('Betika','KE','en','kenya',1), ('SportPesa','KE','en','kenya',1),
  ('Odibets','KE','en','kenya',1), ('Mozzartbet','KE','en','kenya',1),
  ('Betway','KE','en','kenya',1), ('22bet','KE','en','kenya',1),
  -- GH
  ('Betway','GH','en','ghana',1), ('SportyBet','GH','en','ghana',1),
  ('Soccabet','GH','en','ghana',1), ('Betpawa','GH','en','ghana',1),
  ('Premier Bet','GH','en','ghana',1),
  -- TZ
  ('Betway','TZ','en','tanzania',2), ('Meridianbet','TZ','en','tanzania',2),
  ('Premier Bet','TZ','en','tanzania',2), ('Betpawa','TZ','en','tanzania',2),
  ('Betway','TZ','sw','tanzania',2), ('Premier Bet','TZ','sw','tanzania',2),
  ('Betpawa','TZ','sw','tanzania',2), ('Meridianbet','TZ','sw','tanzania',2),
  -- UG
  ('Fortebet','UG','en','uganda',2), ('Betway','UG','en','uganda',2),
  ('Betpawa','UG','en','uganda',2), ('Gal Sport','UG','en','uganda',2),
  -- ZM
  ('Betway','ZM','en','zambia',3), ('Premier Bet','ZM','en','zambia',3),
  ('Betpawa','ZM','en','zambia',3),
  -- CM
  ('1win','CM','fr','cameroun',1), ('Premier Bet','CM','fr','cameroun',1),
  ('Betclic','CM','fr','cameroun',1), ('Melbet','CM','fr','cameroun',1),
  ('Megapari','CM','fr','cameroun',1),
  -- SN
  ('Sunubet','SN','fr','senegal',1), ('Premier Bet','SN','fr','senegal',1),
  ('1win','SN','fr','senegal',1), ('Betclic','SN','fr','senegal',1),
  ('Melbet','SN','fr','senegal',1),
  -- CI
  ('Premier Bet','CI','fr','cote d''ivoire',2), ('1win','CI','fr','cote d''ivoire',2),
  ('Betclic','CI','fr','cote d''ivoire',2), ('Melbet','CI','fr','cote d''ivoire',2),
  -- ML
  ('Premier Bet','ML','fr','mali',3), ('1win','ML','fr','mali',3),
  ('Melbet','ML','fr','mali',3),
  -- BF
  ('Premier Bet','BF','fr','burkina faso',3), ('1win','BF','fr','burkina faso',3),
  -- CD
  ('Premier Bet','CD','fr','rdc',2), ('Betway','CD','fr','rdc',2),
  ('1win','CD','fr','rdc',2), ('Melbet','CD','fr','rdc',2),
  -- MZ
  ('Premier Bet','MZ','pt','mocambique',3), ('Betpawa','MZ','pt','mocambique',3),
  ('Betway','MZ','pt','mocambique',3),
  -- ET
  ('HulusPort','ET','en','ethiopia',3), ('Abyssinia Bet','ET','en','ethiopia',3),
  ('Betika','ET','en','ethiopia',3),
  -- BD
  ('Mostbet','BD','en','bangladesh',1), ('1win','BD','en','bangladesh',1),
  ('Melbet','BD','en','bangladesh',1), ('Linebet','BD','en','bangladesh',1),
  ('BetWinner','BD','en','bangladesh',1), ('Parimatch','BD','en','bangladesh',1),
  ('Mostbet','BD','bn','bangladesh',1), ('1win','BD','bn','bangladesh',1),
  ('Melbet','BD','bn','bangladesh',1), ('Linebet','BD','bn','bangladesh',1),
  ('BetWinner','BD','bn','bangladesh',1), ('Parimatch','BD','bn','bangladesh',1),
  -- IN
  ('Mostbet','IN','en','india',2), ('1win','IN','en','india',2),
  ('Parimatch','IN','en','india',2), ('Dafabet','IN','en','india',2),
  ('10CRIC','IN','en','india',2), ('Rajabets','IN','en','india',2),
  ('Mostbet','IN','hi','india',2), ('1win','IN','hi','india',2),
  ('Parimatch','IN','hi','india',2), ('Dafabet','IN','hi','india',2),
  ('10CRIC','IN','hi','india',2), ('Rajabets','IN','hi','india',2),
  -- TR
  ('Mostbet','TR','tr','turkiye',3), ('1win','TR','tr','turkiye',3),
  ('BetWinner','TR','tr','turkiye',3)
ON CONFLICT (brand, geo, lang) DO UPDATE
  SET geo_word = EXCLUDED.geo_word, priority = EXCLUDED.priority, active = TRUE;


-- ═══════════════════════════════════════════════════════════════════════════
-- 5. ГЕНЕРАТОР КЛЮЧЕЙ
--
-- Функция, а не разовый INSERT: кнопка «Сгенерировать ключи» в интерфейсе
-- вызывает её через RPC, и пересборка пула после правки брендов или
-- модификаторов не требует деплоя.
--
-- Гео-токен добавляется ТОЛЬКО для брендов, представленных больше чем в одном
-- ГЕО. Без этого «1win apk» сгенерировался бы для UZ, CM, SN, CI, ML, BF, CD,
-- BD и IN — девять одинаковых запросов, из которых восемь были бы выброшены
-- дедупом уже после того, как за них заплатили обращением к DuckDuckGo.
-- Локальным брендам (Bet9ja, Betika, Sunubet) гео-токен не нужен: страна и так
-- зашита в название, а лишнее слово только сужает выдачу.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.brand_generate_keywords()
RETURNS TABLE (inserted INT, deactivated INT, total_active INT)
LANGUAGE plpgsql AS $$
DECLARE
  n_ins INT;
  n_off INT;
  n_tot INT;
BEGIN
  WITH multi_geo AS (
    SELECT brand FROM public.brand_targets
    WHERE active GROUP BY brand HAVING count(DISTINCT geo) > 1
  ),
  built AS (
    SELECT
      t.id  AS brand_target_id,
      lower(trim(
        t.brand || ' ' || m.modifier ||
        CASE WHEN mg.brand IS NOT NULL AND t.geo_word IS NOT NULL
             THEN ' ' || t.geo_word ELSE '' END
      )) AS keyword,
      m.modifier,
      t.lang
    FROM public.brand_targets t
    JOIN public.brand_modifiers m ON m.lang = t.lang AND m.active
    LEFT JOIN multi_geo mg ON mg.brand = t.brand
    WHERE t.active
  ),
  ins AS (
    INSERT INTO public.brand_keywords (brand_target_id, keyword, modifier, lang, active)
    SELECT brand_target_id, keyword, modifier, lang, TRUE FROM built
    ON CONFLICT (brand_target_id, keyword) DO UPDATE SET active = TRUE
    RETURNING (xmax = 0) AS is_new
  )
  SELECT count(*) FILTER (WHERE is_new) INTO n_ins FROM ins;

  -- Ключи отключённых брендов гасим, но не удаляем: в них накоплена статистика
  -- выхода, а она и есть основание решать, какой бренд включать обратно.
  UPDATE public.brand_keywords k
     SET active = FALSE
   WHERE k.active
     AND NOT EXISTS (
       SELECT 1 FROM public.brand_targets t
        WHERE t.id = k.brand_target_id AND t.active);
  GET DIAGNOSTICS n_off = ROW_COUNT;

  SELECT count(*) INTO n_tot FROM public.brand_keywords WHERE active;

  RETURN QUERY SELECT n_ins, n_off, n_tot;
END;
$$;

GRANT EXECUTE ON FUNCTION public.brand_generate_keywords() TO anon, authenticated, service_role;

-- Первая сборка пула прямо в миграции — модуль должен быть рабочим сразу
-- после применения, а не после первого нажатия кнопки в интерфейсе.
SELECT public.brand_generate_keywords();


COMMENT ON TABLE public.official_domains IS
  'Явный блок-лист операторских доменов для бренд-пайплайна. ТОЛЬКО точное '
  'совпадение, никакой эвристики по вхождению названия бренда: у 1win.fyi '
  '(аффилиат, наша цель) и 1win.com (оператор) бренд занимает домен второго '
  'уровня одинаково, и любая маска либо пропустит оператора, либо выбросит '
  'лучшую цель.';

COMMENT ON COLUMN public.leads.suspected_official IS
  'Страховка от неучтённых зеркал оператора: нет исходящих реф-ссылок + есть '
  'своя форма регистрации + бренд в домене. Не блокирует, но исключает из '
  'автоотправки — решает человек.';

COMMENT ON COLUMN public.leads.serp_position IS
  'Позиция в брендовой выдаче. Прямой прокси объёма перехваченного трафика: '
  'позиция 2 по «mostbet apk» стоит кратно больше позиции 30.';
