-- 059 — одна таблица поисковых ключей вместо пяти (Блок B)
--
-- Ключи были размазаны по пяти таблицам плюс хардкод в коде. Они жили по
-- разным правилам и читались разными функциями — и это уже стоило дорого:
-- 1464 ключа пролежали полтора месяца мёртвым грузом, потому что таблицу, в
-- которую их залили, не читал никто. Миграция 040 честно предупреждала об
-- этом текстом, и предупреждение полтора месяца никто не прочитал.
--
-- Здесь создаётся search_keywords и наполняется из двух актуальных таблиц.
-- Старые таблицы НЕ удаляются: снос отдельной миграцией и только после того,
-- как оба конвейера отработают на новой. Уронить источник ключей в той же
-- миграции, что заводит новый, — это ставить всё на то, что переключение кода
-- сработало с первого раза.
--
-- ── Почему web и telegram в одной таблице ───────────────────────────────────
-- Механика одна: запрос → выдача → кандидаты. Различаются потребитель и
-- разбор результата, а не природа ключа. Двумя таблицами это и было, и именно
-- поэтому телеметрия у них разъехалась: у TG счётчики называются runs/
-- channels_found, у веба — runs/results_found, и ни один запрос не мог
-- посчитать выход по обоим сразу.
--
-- ── Почему телеметрия переносится, а не обнуляется ──────────────────────────
-- В tg_search_queries накоплены runs и channels_found за всё время работы
-- TG-поиска. Это единственное измерение, по которому вообще можно судить,
-- какие углы работали. Обнулить его при переезде значит начать отбраковку
-- выгоревших ключей с нуля — то есть отложить её ещё на месяцы.

-- ── 1. Таблица ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.search_keywords (
  id            BIGSERIAL PRIMARY KEY,
  brand_id      UUID NOT NULL REFERENCES public.brands(id),
  channel       TEXT NOT NULL DEFAULT 'web',
  geo           TEXT NOT NULL,
  language      TEXT NOT NULL,
  keyword       TEXT NOT NULL,
  layer         TEXT NOT NULL,
  active        BOOLEAN NOT NULL DEFAULT true,

  -- Телеметрия для отбраковки выгоревших ключей. Лежит здесь же, а не в
  -- отдельной таблице: разнесённая телеметрия — ровно та причина, по которой
  -- archive-keywords нечем было принимать решение.
  times_used    INTEGER NOT NULL DEFAULT 0,
  results_total INTEGER NOT NULL DEFAULT 0,
  leads_total   INTEGER NOT NULL DEFAULT 0,
  last_used_at  TIMESTAMPTZ,
  burned_at     TIMESTAMPTZ,
  burn_reason   TEXT,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT search_keywords_channel_chk CHECK (channel IN ('web', 'telegram')),
  CONSTRAINT search_keywords_layer_chk   CHECK (layer   IN ('A', 'B', 'C', 'D')),
  CONSTRAINT search_keywords_uniq UNIQUE (brand_id, channel, geo, language, keyword)
);

-- Порядок выбора ключа — least-recently-used. С полутора тысячами ключей любая
-- арифметика по номеру слота возвращалась бы к конкретному ключу днями, а
-- ключ, который не запускался, нельзя судить по выходу.
CREATE INDEX IF NOT EXISTS idx_search_keywords_pick
  ON public.search_keywords(brand_id, channel, active, last_used_at NULLS FIRST);
CREATE INDEX IF NOT EXISTS idx_search_keywords_layer
  ON public.search_keywords(brand_id, channel, layer) WHERE active;
-- Выбор внутри слоя идёт ещё и по гео: без гео в индексе запрос слоя A по
-- конкретной стране сканирует весь пул бренда.
CREATE INDEX IF NOT EXISTS idx_search_keywords_geo
  ON public.search_keywords(brand_id, channel, layer, geo, last_used_at NULLS FIRST)
  WHERE active;

-- ── 2. Доступы ──────────────────────────────────────────────────────────────
-- В этом проекте ALTER DEFAULT PRIVILEGES выдаёт anon права на КАЖДУЮ новую
-- таблицу автоматически. Поэтому сначала отбираем, потом выдаём — иначе
-- «мы ничего не выдавали anon» означает «anon всё может».
--
-- anon здесь не нужен: search_keywords читают только edge-функции, а они ходят
-- под service_role. Дашборд к ней не обращается.
REVOKE ALL ON public.search_keywords FROM anon;
REVOKE ALL ON SEQUENCE public.search_keywords_id_seq FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.search_keywords TO service_role, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.search_keywords_id_seq TO service_role, authenticated;

-- ── 3. Перенос: веб-ключи ───────────────────────────────────────────────────
-- ON CONFLICT DO NOTHING, а не UPDATE: миграция должна быть перезапускаемой,
-- но повторный прогон НЕ должен затирать телеметрию, накопленную конвейером
-- уже на новой таблице. Второй прогон обязан быть пустым, а не разрушительным.
INSERT INTO public.search_keywords
  (brand_id, channel, geo, language, keyword, layer, active,
   times_used, results_total, leads_total, last_used_at, created_at)
SELECT k.brand_id, 'web', k.geo, k.language, k.keyword, k.layer, k.active,
       coalesce(k.runs, 0), coalesce(k.results_found, 0), coalesce(k.leads_created, 0),
       k.last_run_at, k.created_at
  FROM public.multibrand_keywords k
 WHERE k.brand_id IS NOT NULL
   AND k.layer IN ('A', 'B', 'C', 'D')
ON CONFLICT ON CONSTRAINT search_keywords_uniq DO NOTHING;

-- ── 4. Перенос: TG-ключи ────────────────────────────────────────────────────
-- Только строки с брендом. Старый сид 020 остался без brand_id и выключен ещё
-- миграцией 054 — тащить его сюда нельзя технически (brand_id NOT NULL) и
-- незачем: это отбракованные запросы, их место в старой таблице как в архиве.
--
-- channels_found → results_total: для TG «найденный результат» и есть канал.
INSERT INTO public.search_keywords
  (brand_id, channel, geo, language, keyword, layer, active,
   times_used, results_total, leads_total, last_used_at, created_at)
SELECT q.brand_id, 'telegram',
       coalesce(q.geo, 'global'), coalesce(q.language, 'EN'),
       q.query, q.layer, coalesce(q.active, true),
       coalesce(q.runs, 0), coalesce(q.channels_found, 0), 0,
       q.last_run_at, coalesce(q.created_at, now())
  FROM public.tg_search_queries q
 WHERE q.brand_id IS NOT NULL
   AND q.layer IN ('A', 'B', 'C', 'D')
ON CONFLICT ON CONSTRAINT search_keywords_uniq DO NOTHING;

-- ── 5. Проверка и отчёт по коллизиям ────────────────────────────────────────
DO $$
DECLARE
  src_web  BIGINT; src_tg  BIGINT;
  got_web  BIGINT; got_tg  BIGINT;
  skipped_web BIGINT; skipped_tg BIGINT;
  no_brand_tg BIGINT;
BEGIN
  SELECT count(*) INTO src_web FROM public.multibrand_keywords
   WHERE brand_id IS NOT NULL AND layer IN ('A','B','C','D');
  SELECT count(*) INTO src_tg  FROM public.tg_search_queries
   WHERE brand_id IS NOT NULL AND layer IN ('A','B','C','D');
  SELECT count(*) INTO no_brand_tg FROM public.tg_search_queries WHERE brand_id IS NULL;

  SELECT count(*) INTO got_web FROM public.search_keywords WHERE channel = 'web';
  SELECT count(*) INTO got_tg  FROM public.search_keywords WHERE channel = 'telegram';

  skipped_web := src_web - got_web;
  skipped_tg  := src_tg  - got_tg;

  RAISE NOTICE 'веб:      источник % → перенесено % (коллизий по UNIQUE: %)',
    src_web, got_web, skipped_web;
  RAISE NOTICE 'telegram: источник % → перенесено % (коллизий по UNIQUE: %)',
    src_tg, got_tg, skipped_tg;
  RAISE NOTICE 'итого в search_keywords: %', got_web + got_tg;
  RAISE NOTICE 'не перенесено из tg_search_queries без бренда (старый сид 020, выключен): %',
    no_brand_tg;

  -- Пустая таблица после переноса — это не «мигрировали ноль строк», это
  -- сломанный конвейер, который потом молча не найдёт ни одного ключа.
  IF got_web + got_tg = 0 THEN
    RAISE EXCEPTION 'search_keywords пуста после переноса — источники не прочитались';
  END IF;

  -- Ключ без бренда, гео или языка не выберется ни одним запросом конвейера:
  -- он есть в таблице и невидим для поиска. Ровно так 199 ключей из 929
  -- оказались недостижимы в прошлый раз.
  PERFORM 1 FROM public.search_keywords
   WHERE btrim(coalesce(geo,'')) = '' OR btrim(coalesce(language,'')) = '';
  IF FOUND THEN
    RAISE EXCEPTION 'есть ключи с пустым гео или языком — они недостижимы для конвейера';
  END IF;

  -- Обратная проверка на anon: см. блок 2. Дешевле поймать здесь, чем узнать
  -- из аудита через полгода.
  PERFORM 1 FROM information_schema.role_table_grants
   WHERE table_schema = 'public' AND table_name = 'search_keywords' AND grantee = 'anon';
  IF FOUND THEN
    RAISE EXCEPTION 'у anon остались права на search_keywords';
  END IF;
END $$;
