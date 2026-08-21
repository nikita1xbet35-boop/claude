-- 046 — Блок 4: скрытые бренды становятся действительно скрытыми
--
-- ── Что было сломано ────────────────────────────────────────────────────────
-- 035 завела Melbet и Coldbet с visibility='hidden' — то есть объявила, что
-- эти два бренда видны не всем. Но объявление так и осталось объявлением:
-- колонка ничего не значила ни для одного запроса. Экран «Настройки системы»
-- тянул `select *` из brands без фильтра и печатал оба, а RLS на таблице не
-- было вовсе, поэтому anon-ключ из index.html читал их напрямую.
--
-- Воркер (a35c467) уже научился выдавать сессии подписанный JWT с claim
-- brand_role ('full' | 'standard') — но читать этот claim было некому:
-- политик не существовало. Эта миграция и есть тот, кто его читает.
--
-- ── Почему граница здесь, а не только в интерфейсе ──────────────────────────
-- Параллельно с этой миграцией дашборд перестаёт показывать standard'у кнопку
-- настроек и закрывает маршрут #/settings. Само по себе это ничего не
-- защищает: /db проксирует ЛЮБОЙ запрос PostgREST, и `GET /db/rest/v1/brands`
-- из консоли браузера вернул бы полный список мимо всякого интерфейса.
-- Прятать строки должен Postgres, а фронт — лишь не показывать то, что и так
-- не придёт.
--
-- ── Почему anon оставлен с правом читать несекретное ────────────────────────
-- Соблазн был закрыть anon целиком: раз все запросы дашборда идут через /db с
-- подписанным JWT, anon вроде бы не нужен. Но тогда любая осечка в выдаче
-- JWT (не задан SUPABASE_JWT_SECRET, протухла сессия, воркер откатился на
-- старый код) превращается в дашборд, где в шапке «брендов нет» — и это
-- выглядит как пустая база, а не как проблема с доступом. Ровно тот тип
-- беззвучной поломки, на который SETUP.md жалуется отдельным разделом.
--
-- Поэтому anon читает несекретные бренды и не может писать. Скрытые не
-- достаются ему ни при каком раскладе — включая режим ?direct=1, который
-- ходит в supabase.co мимо воркера. Цель («Melbet/Coldbet не видит никто,
-- кроме full») выполняется на всех путях, а отказ ломает запись, где ошибка
-- видна сразу по alert'у, а не чтение, где она видна как ноль.
--
-- ── Область ─────────────────────────────────────────────────────────────────
-- Только brands. Данных под melbet/coldbet нет: оба в статусе draft с
-- cron_weight = 0, поиск под ними ни разу не запускался, в leads их brand_id
-- не встречается. Растягивать RLS на leads/send_queue/email_log — отдельная
-- работа с реальным риском обнулить рабочие экраны, и её место в
-- RLS_ROADMAP.md, а не в этой миграции.

ALTER TABLE public.brands ENABLE ROW LEVEL SECURITY;

-- Политики пересоздаются целиком: миграция должна переживать повторный накат.
DROP POLICY IF EXISTS brands_select   ON public.brands;
DROP POLICY IF EXISTS brands_modify   ON public.brands;

-- ── Чтение ──────────────────────────────────────────────────────────────────
-- auth.jwt() при отсутствии токена возвращает NULL (внутри у неё
-- current_setting(..., true)), NULL ->> 'brand_role' тоже NULL, сравнение даёт
-- NULL — то есть для anon условие честно сводится к первой половине OR.
CREATE POLICY brands_select ON public.brands
  FOR SELECT TO anon, authenticated
  USING (
    visibility <> 'hidden'
    OR (auth.jwt() ->> 'brand_role') = 'full'
  );

-- ── Запись ──────────────────────────────────────────────────────────────────
-- Только для authenticated, то есть только через /db с сессионным JWT.
--
-- WITH CHECK смотрит на строку ПОСЛЕ изменения, и это здесь не формальность:
-- без него standard мог бы взять публичный бренд и выставить ему
-- visibility='hidden' — строка прошла бы USING (она ещё публичная) и стала бы
-- невидимой для него же. С WITH CHECK такой UPDATE отклоняется.
CREATE POLICY brands_modify ON public.brands
  FOR ALL TO authenticated
  USING (
    visibility <> 'hidden'
    OR (auth.jwt() ->> 'brand_role') = 'full'
  )
  WITH CHECK (
    visibility <> 'hidden'
    OR (auth.jwt() ->> 'brand_role') = 'full'
  );

-- ── Почему запись у anon отбирается GRANT'ом, а не только политикой ─────────
-- Политика brands_modify выдана роли authenticated, поэтому anon под неё не
-- подпадает и писать не может уже сейчас. Но отказ по RLS не является
-- ошибкой: UPDATE просто не находит ни одной строки и возвращает «UPDATE 0».
-- Проверено на локальном Postgres — anon UPDATE и DELETE отрабатывают именно
-- так, молча.
--
-- Для дашборда это худший из возможных ответов. Он проверяет `if(error)`,
-- ошибки нет — и он рисует «сохранено», не сохранив ничего. Отобранный GRANT
-- превращает это в «permission denied for table brands», то есть в текст,
-- который попадёт в alert и будет виден человеку.
--
-- Читать anon по-прежнему может (SELECT из GRANT'а 035 не трогаем) — на этом
-- держится сценарий из шапки: сорванная выдача JWT ломает запись, а не
-- показ дашборда.
REVOKE INSERT, UPDATE, DELETE ON public.brands FROM anon;

-- service_role в Supabase объявлен BYPASSRLS — все edge-функции, которые
-- читают brands (generate-queue, generate-queue-dfs, generate-queue-brand,
-- find-and-queue, process-queue-lp), ходят под ним и политик не замечают.
-- Проверено: ни одна из них не использует anon-ключ.

-- ── Проверка, что политика различает роли ───────────────────────────────────
-- Ошибка в выражении политики не роняет миграцию — она просто отдаёт не то
-- множество строк, и заметить это можно было бы только глазами на проде.
-- Поэтому прогоняем оба claim'а прямо здесь и падаем, если результат не тот.
DO $$
DECLARE
  n_hidden INT;
  n_std    INT;
  n_full   INT;
BEGIN
  SELECT count(*) INTO n_hidden FROM public.brands WHERE visibility = 'hidden';
  IF n_hidden = 0 THEN
    RAISE NOTICE 'скрытых брендов нет — политика включена, но различать пока нечего';
    RETURN;
  END IF;

  SET LOCAL ROLE authenticated;

  PERFORM set_config('request.jwt.claims', '{"role":"authenticated","brand_role":"standard"}', true);
  SELECT count(*) INTO n_std FROM public.brands WHERE visibility = 'hidden';

  PERFORM set_config('request.jwt.claims', '{"role":"authenticated","brand_role":"full"}', true);
  SELECT count(*) INTO n_full FROM public.brands WHERE visibility = 'hidden';

  RESET ROLE;
  PERFORM set_config('request.jwt.claims', NULL, true);

  IF n_std <> 0 THEN
    RAISE EXCEPTION 'политика не работает: standard видит % скрытых брендов вместо 0', n_std;
  END IF;
  IF n_full <> n_hidden THEN
    RAISE EXCEPTION 'политика режет лишнее: full видит % скрытых брендов вместо %', n_full, n_hidden;
  END IF;

  RAISE NOTICE 'проверка пройдена: standard видит 0 скрытых, full — все % ', n_hidden;
END $$;
