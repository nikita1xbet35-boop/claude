-- 051 — база ГЕО для ботов и переработанный FAQ
--
-- ── Чего здесь нет и почему ─────────────────────────────────────────────────
-- Таблица geo_availability создаётся ПУСТОЙ. ТЗ называет единственным
-- источником правды приложенный PDF (Work_GEOs_partners1xbet_EN_-_GEOs___EN)
-- и прямо запрещает транскрибировать его вручную. Файл к заданию не приложен —
-- в загрузку пришёл только текст ТЗ.
--
-- Списка стран с доступностью, валютами и лицензиями я не знаю и знать не
-- могу: это не общедоступный факт, а внутренние условия партнёрской
-- программы. Придуманный ответ «Нигерия доступна» — это обещание от лица
-- компании, и ошибка в нём стоит дороже, чем отсутствие ответа.
--
-- Пока таблица пуста, бот честно говорит, что справочник ещё не загружен, и
-- отдаёт контакт менеджера. Наполнение — импорт CSV/SQL из PDF, без правок
-- кода и без передеплоя.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ── 1. Справочник ───────────────────────────────────────────────────────────
-- DDL из ТЗ §1 дословно.
CREATE TABLE IF NOT EXISTS public.geo_availability (
  id            BIGSERIAL PRIMARY KEY,
  geo_en        TEXT NOT NULL,
  geo_ru        TEXT NOT NULL,
  iso_code      TEXT NOT NULL,
  region        TEXT NOT NULL,
  availability  TEXT NOT NULL,   -- available | not_available | local_program_only | confirm_with_manager
  note          TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_geo_availability_en   ON public.geo_availability(lower(geo_en));
CREATE INDEX IF NOT EXISTS idx_geo_availability_ru   ON public.geo_availability(lower(geo_ru));
CREATE INDEX IF NOT EXISTS idx_geo_availability_code ON public.geo_availability(iso_code);

-- Триграммные индексы — под поиск с опечатками (§2.3). Без них similarity()
-- по 190 строкам всё равно работает, но перебором.
CREATE INDEX IF NOT EXISTS idx_geo_trgm_en ON public.geo_availability USING gin (lower(geo_en) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_geo_trgm_ru ON public.geo_availability USING gin (lower(geo_ru) gin_trgm_ops);

-- Перезалить справочник целиком (ТЗ §1: без diff-логики).
--   BEGIN;
--   TRUNCATE public.geo_availability;
--   \copy public.geo_availability (geo_en,geo_ru,iso_code,region,availability,note) FROM 'geo.csv' CSV HEADER;
--   COMMIT;
-- Уникальности по iso_code сознательно нет: в исходной таблице одна страна
-- может встречаться дважды с разными примечаниями, и ограничение потеряло бы
-- часть строк молча, при импорте.

-- ── 2. Альтернативные названия ──────────────────────────────────────────────
-- Отдельной таблицей, а не колонкой в справочнике: справочник перезаливается
-- целиком из PDF, и синонимы при каждом обновлении стирались бы вместе с ним.
--
-- Здесь только вопрос НАЗВАНИЯ, не доступности: «UAE» и «United Arab
-- Emirates» — одна страна независимо от условий программы. Такие соответствия
-- я знаю и могу заполнить, в отличие от самой доступности.
CREATE TABLE IF NOT EXISTS public.geo_aliases (
  alias    TEXT PRIMARY KEY,      -- всегда в нижнем регистре
  iso_code TEXT NOT NULL
);

INSERT INTO public.geo_aliases (alias, iso_code) VALUES
  ('uae','AE'), ('emirates','AE'),
  ('usa','US'), ('us','US'), ('united states','US'), ('america','US'),
  ('uk','GB'), ('england','GB'), ('britain','GB'), ('great britain','GB'),
  ('drc','CD'), ('dr congo','CD'), ('congo kinshasa','CD'),
  ('ivory coast','CI'), ('cote d''ivoire','CI'), ('côte d''ivoire','CI'),
  ('south korea','KR'), ('korea','KR'),
  ('czechia','CZ'), ('czech republic','CZ'),
  ('holland','NL'), ('netherlands','NL'),
  ('burma','MM'), ('myanmar','MM'),
  ('turkiye','TR'), ('türkiye','TR'), ('turkey','TR'),
  ('оаэ','AE'), ('сша','US'), ('великобритания','GB'), ('англия','GB'),
  ('корея','KR'), ('турция','TR'), ('нидерланды','NL'), ('чехия','CZ')
ON CONFLICT (alias) DO NOTHING;

-- ── 3. Поиск ────────────────────────────────────────────────────────────────
-- Две функции, а не одна, и это главное решение во всей миграции.
--
-- Первая версия отвечала одной строкой, включая приблизительное совпадение.
-- Проверка на данных показала, чем это кончается: запрос «Nigeira» (опечатка в
-- «Nigeria») уверенно возвращал НИГЕР — similarity 0.400 против 0.333, потому
-- что короткое слово выигрывает по триграммам. Бот сказал бы «Niger — not
-- available» человеку, спросившему про Нигерию, где ответ обратный.
--
-- Никакой порог этого не чинит: у любого нечёткого поиска есть соседи, между
-- которыми он выбирает наугад. Поэтому приблизительное совпадение перестаёт
-- быть ответом и становится вопросом — бот показывает кандидатов и просит
-- уточнить. Утверждение о доступности ГЕО делается только при точном
-- совпадении или по синониму.

-- Точно или по синониму. Не более одной строки; пусто = уверенного ответа нет.
CREATE OR REPLACE FUNCTION public.fn_find_geo(q TEXT)
RETURNS TABLE (id BIGINT, geo_en TEXT, geo_ru TEXT, iso_code TEXT, region TEXT,
               availability TEXT, note TEXT, match TEXT)
LANGUAGE plpgsql STABLE
SET search_path = public, pg_temp
AS $$
DECLARE v_q TEXT := lower(btrim(coalesce(q, '')));
BEGIN
  IF v_q = '' THEN RETURN; END IF;

  RETURN QUERY
  SELECT g.id, g.geo_en, g.geo_ru, g.iso_code, g.region, g.availability, g.note, 'exact'::TEXT
    FROM public.geo_availability g
   WHERE lower(g.geo_en) = v_q OR lower(g.geo_ru) = v_q OR lower(g.iso_code) = v_q
   LIMIT 1;
  IF FOUND THEN RETURN; END IF;

  RETURN QUERY
  SELECT g.id, g.geo_en, g.geo_ru, g.iso_code, g.region, g.availability, g.note, 'alias'::TEXT
    FROM public.geo_aliases a
    JOIN public.geo_availability g ON lower(g.iso_code) = lower(a.iso_code)
   WHERE a.alias = v_q
   LIMIT 1;
END $$;

-- Кандидаты «вы имели в виду». Порог ниже, чем был у ответа (0.25 против 0.4):
-- ошибиться списком вариантов не страшно, человек выбирает сам, а вот не
-- показать нужную страну — страшно.
CREATE OR REPLACE FUNCTION public.fn_suggest_geo(q TEXT, n INT DEFAULT 3)
RETURNS TABLE (id BIGINT, geo_en TEXT, iso_code TEXT, score REAL)
LANGUAGE plpgsql STABLE
SET search_path = public, pg_temp
AS $$
DECLARE v_q TEXT := lower(btrim(coalesce(q, '')));
BEGIN
  IF v_q = '' THEN RETURN; END IF;

  RETURN QUERY
  SELECT g.id, g.geo_en, g.iso_code,
         greatest(similarity(lower(g.geo_en), v_q), similarity(lower(g.geo_ru), v_q)) AS score
    FROM public.geo_availability g
   WHERE similarity(lower(g.geo_en), v_q) > 0.25
      OR similarity(lower(g.geo_ru), v_q) > 0.25
      OR lower(g.geo_en) LIKE v_q || '%'
      OR lower(g.geo_ru) LIKE v_q || '%'
   -- Начинающееся с введённого — вперёд: «uni» должно предлагать United …,
   -- а не страну, случайно похожую по буквам в середине.
   ORDER BY (lower(g.geo_en) LIKE v_q || '%' OR lower(g.geo_ru) LIKE v_q || '%') DESC,
            score DESC
   LIMIT greatest(n, 1);
END $$;

-- ── 4. Ссылка на PDF ────────────────────────────────────────────────────────
-- sendDocument принимает URL, поэтому файл достаточно положить в любое место,
-- откуда его отдадут по HTTP, и записать адрес сюда. Пусто = кнопка честно
-- говорит, что список ещё не опубликован.
INSERT INTO public.system_config (key, value)
VALUES ('geo_pdf_url', '""')
ON CONFLICT (key) DO NOTHING;

-- ── 5. Состояние диалога ────────────────────────────────────────────────────
-- «Check a country» переводит человека в режим ввода, и следующее сообщение
-- нужно понять как название страны, а не как «не понял, вот меню».
ALTER TABLE public.bot_user_prefs ADD COLUMN IF NOT EXISTS awaiting TEXT;

-- ── 6. FAQ: три пункта вместо четырёх ───────────────────────────────────────
-- geo уезжает из FAQ в отдельную кнопку (ТЗ §3).
DELETE FROM public.bot_faq WHERE key = 'geo';

-- Тексты EN взяты из ТЗ §3 дословно. FR и UZ — перевод тех же формулировок:
-- ТЗ требует точный перевод, а не пересказ, потому что это утверждения об
-- условиях выплат и лицензиях. Ни одного факта сверх написанного в ТЗ здесь
-- нет — ни сроков, ни процентов, ни стран.
INSERT INTO public.bot_faq (lang, key, question, answer, sort_order) VALUES
  ('en','payouts','💵 Payouts',
   E'Payouts are processed weekly, every Tuesday, for all countries.\n\nWithdrawal: funds go to the player''s game account — from there you can withdraw using any available method, or connect a crypto wallet directly.', 1),
  ('en','revshare','📊 RevShare terms',
   E'Standard starting rate: 25% clean RevShare, no admin fee.\n\nYour actual rate is discussed individually — there''s no fixed minimum traffic threshold, terms are set based on your specific case.\n\nTalk to your manager to discuss your rate: @aff_manager_xbet', 2),
  ('en','license','🔒 Licensed?',
   E'1xBet holds official local licences in many of its markets. Licence status varies by country — use "Check GEO" to see the current status for your specific market.', 3),

  ('fr','payouts','💵 Paiements',
   E'Les paiements sont traités chaque semaine, tous les mardis, pour tous les pays.\n\nRetrait : les fonds sont versés sur le compte de jeu — de là, vous pouvez retirer par n''importe quelle méthode disponible, ou connecter directement un portefeuille crypto.', 1),
  ('fr','revshare','📊 Conditions RevShare',
   E'Taux de départ standard : 25 % de RevShare net, sans frais administratifs.\n\nVotre taux réel se discute individuellement — il n''y a pas de seuil minimum de trafic, les conditions sont fixées selon votre cas précis.\n\nParlez-en à votre manager : @aff_manager_xbet', 2),
  ('fr','license','🔒 Licences ?',
   E'1xBet détient des licences locales officielles sur beaucoup de ses marchés. Le statut de licence varie selon le pays — utilisez « Check GEO » pour voir le statut actuel de votre marché.', 3),

  ('uz','payouts','💵 To''lovlar',
   E'To''lovlar har hafta, har seshanba kuni, barcha davlatlar uchun amalga oshiriladi.\n\nYechib olish: mablag'' o''yin hisobiga tushadi — u yerdan istalgan mavjud usulda yechib olishingiz yoki to''g''ridan-to''g''ri kripto hamyonni ulashingiz mumkin.', 1),
  ('uz','revshare','📊 RevShare shartlari',
   E'Standart boshlang''ich stavka: 25% sof RevShare, admin to''lovisiz.\n\nSizning haqiqiy stavkangiz alohida muhokama qilinadi — belgilangan minimal trafik chegarasi yo''q, shartlar sizning holatingizga qarab belgilanadi.\n\nStavkangizni muhokama qilish uchun menejeringizga yozing: @aff_manager_xbet', 2),
  ('uz','license','🔒 Litsenziya?',
   E'1xBet o''z bozorlarining ko''pchiligida rasmiy mahalliy litsenziyalarga ega. Litsenziya holati davlatga qarab farq qiladi — o''z bozoringiz uchun joriy holatni ko''rish uchun "Check GEO" dan foydalaning.', 3)
ON CONFLICT (lang, key) DO UPDATE
  SET question = EXCLUDED.question,
      answer   = EXCLUDED.answer,
      sort_order = EXCLUDED.sort_order;

-- ── 7. Доступ ───────────────────────────────────────────────────────────────
-- Как и в 048: умолчания Supabase уже выдали права anon, их надо отобрать.
-- Забыть это здесь — та же ошибка, что уронила 048 в проде.
REVOKE ALL ON public.geo_availability, public.geo_aliases FROM anon, authenticated, PUBLIC;
REVOKE ALL ON SEQUENCE public.geo_availability_id_seq FROM anon, authenticated, PUBLIC;

ALTER TABLE public.geo_availability ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.geo_aliases      ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON public.geo_availability, public.geo_aliases TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.geo_availability, public.geo_aliases TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.geo_availability_id_seq TO service_role;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['geo_availability','geo_aliases'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_read', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (true)',
                   t || '_read', t);
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION public.fn_find_geo(TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_suggest_geo(TEXT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_find_geo(TEXT) TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_suggest_geo(TEXT, INT) TO service_role, authenticated;

-- ── 8. Проверка ─────────────────────────────────────────────────────────────
DO $$
DECLARE n INT; n_geo INT;
BEGIN
  SELECT count(*) INTO n FROM information_schema.role_table_grants
   WHERE table_schema = 'public' AND table_name IN ('geo_availability','geo_aliases')
     AND grantee = 'anon';
  IF n > 0 THEN RAISE EXCEPTION 'anon получил % прав на geo-таблицы', n; END IF;

  SELECT count(*) INTO n FROM public.bot_faq WHERE key = 'geo';
  IF n > 0 THEN RAISE EXCEPTION 'geo остался в FAQ — он должен жить отдельной кнопкой'; END IF;

  SELECT count(*) INTO n FROM public.bot_faq WHERE answer = '';
  IF n > 0 THEN RAISE EXCEPTION '% ответов FAQ пусты — бот отдаст контакт менеджера вместо текста', n; END IF;

  SELECT count(*) INTO n FROM public.bot_faq;
  IF n <> 9 THEN RAISE EXCEPTION 'ожидалось 9 записей FAQ (3 пункта × 3 языка), найдено %', n; END IF;

  SELECT count(*) INTO n_geo FROM public.geo_availability;
  IF n_geo = 0 THEN
    RAISE NOTICE 'FAQ заполнен на 3 языках. geo_availability ПУСТА — ждёт импорта из PDF';
  ELSE
    RAISE NOTICE 'FAQ заполнен, в справочнике ГЕО % строк', n_geo;
  END IF;
END $$;
