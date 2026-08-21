-- 044 — Доведение brand_id до NOT NULL там, где бренд обязателен
--
-- ── Почему не «все семь», как в 037 ─────────────────────────────────────────
-- 037 ставила NOT NULL на leads, send_queue, email_log, api_usage, error_log,
-- funnel_stats, dfs_domains. Три из них бренду не принадлежат по смыслу, и
-- требовать там brand_id значит выдумывать владельца записи, у которой его нет:
--
--   error_log    — 66 мест вставки, и почти все системные: сброс счётчиков,
--                  падение планировщика, ошибка воркера. Бренд здесь —
--                  необязательный контекст, а не идентичность записи.
--   api_usage    — строка на СЕРВИС (gmail_main, groq, serpapi). Сервисы общие
--                  для всех брендов; «расход Groq за сутки» ничьим брендом не
--                  владеется.
--   dfs_domains  — сырая выгрузка ссылочного графа ДО квалификации. Домен ещё
--                  не привязан к бренду — этим занимается следующая стадия.
--
-- Эти три остаются nullable сознательно, а не «пока руки не дошли».
-- NOT NULL включается на четырёх, где бренд — часть идентичности строки:
-- leads, send_queue, email_log, funnel_stats.
--
-- ── Почему это не повторит аварию 037 ───────────────────────────────────────
-- 037 упала не потому, что идея неверная, а потому что включила ограничение
-- РАНЬШЕ, чем код научился его соблюдать. Одного обхода кода мало: grep по
-- вставкам уже один раз соврал (объект строится далеко от вызова .insert).
-- Поэтому ограничению предшествует триггер-подстраховка: если brand_id пришёл
-- пустым, он проставляется брендом по умолчанию ДО проверки NOT NULL.
--
-- Это закрывает и оставшиеся однобрендовые производители (brand-search,
-- dfs-qualify, find-appstore, find-youtube, scan-tg-channels, youtube-search,
-- process-partner-queue): каждый из них по построению делает записи 1xBet, и
-- значение по умолчанию для них не «заглушка», а верный ответ. Там, где бренд
-- известен построчно (email_log из лида, send_queue из follow-up), он теперь
-- проставляется явно в коде — умолчание туда не доходит.
--
-- Ограничение умолчания названо прямо: если новый пайплайн начнёт писать лиды
-- второго бренда и забудет brand_id, они молча станут 1xBet. Защита от этого —
-- явная простановка в коде, а триггер лишь гарантирует, что NOT NULL не уронит
-- прод.

-- ── 1. Бренд по умолчанию ───────────────────────────────────────────────────
INSERT INTO public.system_config (key, value)
VALUES ('default_brand_slug', '"1xbet"')
ON CONFLICT (key) DO NOTHING;

-- ── 2. Триггер-подстраховка ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_fill_default_brand_id()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.brand_id IS NULL THEN
    SELECT b.id INTO NEW.brand_id
      FROM public.brands b
     WHERE b.slug = COALESCE(
       (SELECT value #>> '{}' FROM public.system_config WHERE key = 'default_brand_slug'),
       '1xbet');
  END IF;
  RETURN NEW;
END;
$$;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['leads','send_queue','email_log','funnel_stats'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_default_brand_id ON public.%I', t);
    EXECUTE format(
      'CREATE TRIGGER trg_default_brand_id BEFORE INSERT ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.fn_fill_default_brand_id()', t);
  END LOOP;
END $$;

-- ── 3. Добить остатки NULL ──────────────────────────────────────────────────
-- 036 уже проставила brand_id всему, что существовало на тот момент; сюда
-- попадает только то, что вставилось между 042 (снятие NOT NULL) и сейчас.
DO $$
DECLARE
  v_default UUID;
  t TEXT;
  n INT;
BEGIN
  SELECT id INTO v_default FROM public.brands WHERE slug = '1xbet';
  IF v_default IS NULL THEN
    RAISE EXCEPTION 'нет бренда 1xbet — сначала должна примениться 035';
  END IF;

  FOREACH t IN ARRAY ARRAY['leads','send_queue','email_log','funnel_stats'] LOOP
    EXECUTE format('UPDATE public.%I SET brand_id = $1 WHERE brand_id IS NULL', t) USING v_default;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN RAISE NOTICE 'добито % строк в %', n, t; END IF;
  END LOOP;
END $$;

-- ── 4. Проверка из ТЗ (п.6 порядка работ): count = 0 ────────────────────────
-- Если хоть одна строка осталась — миграция падает ЗДЕСЬ, до ALTER, и ничего
-- не ломает. Именно этого шага не было в 037.
DO $$
DECLARE t TEXT; n INT;
BEGIN
  FOREACH t IN ARRAY ARRAY['leads','send_queue','email_log','funnel_stats'] LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE brand_id IS NULL', t) INTO n;
    IF n > 0 THEN
      RAISE EXCEPTION '% содержит % строк с brand_id IS NULL — NOT NULL не включаем', t, n;
    END IF;
  END LOOP;
  RAISE NOTICE 'проверка пройдена: во всех четырёх таблицах ноль NULL';
END $$;

-- ── 5. Само ограничение ─────────────────────────────────────────────────────
ALTER TABLE public.leads        ALTER COLUMN brand_id SET NOT NULL;
ALTER TABLE public.send_queue   ALTER COLUMN brand_id SET NOT NULL;
ALTER TABLE public.email_log    ALTER COLUMN brand_id SET NOT NULL;
ALTER TABLE public.funnel_stats ALTER COLUMN brand_id SET NOT NULL;

-- error_log / api_usage / dfs_domains намеренно НЕ трогаем — см. шапку.
