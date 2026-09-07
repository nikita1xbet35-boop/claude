-- 058 — telegram_channels → youtube_channels (Блок A §4)
--
-- Таблица хранит YouTube-каналы: 564 записи, все с partner_type='youtube', и
-- пишет в неё youtube-search.ts. Имя осталось от прежней итерации, когда под
-- ней подразумевались Telegram-каналы.
--
-- Это не косметика. Миграция 020 содержит прямое предупреждение о том, что
-- TG-конвейер едва не начал писать в эту таблицу, приняв её за свою по имени.
-- То есть ловушка уже почти сработала один раз — и после появления настоящего
-- TG-конвейера (scan-tg-channels) цена ошибки выросла: перепутанные каналы
-- двух разных площадок в одной таблице не разделить обратно ничем, кроме
-- ручного разбора.
--
-- RENAME, а не пересоздание: 564 строки переживают переименование без
-- копирования, а индексы и ограничения едут за таблицей сами.
--
-- Старое имя НЕ остаётся синонимом (вью-заглушкой). Смысл переименования — в
-- том, чтобы обращение по старому имени падало заметно, а не продолжало
-- работать втихую: именно молчаливая работа под неверным именем и создала
-- проблему. Все обращения в коде переведены на новое имя тем же коммитом.

BEGIN;

DO $$
BEGIN
  -- Идемпотентность: повторный прогон не должен падать. Переименовываем
  -- только если старое имя ещё существует, а нового ещё нет.
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'public' AND table_name = 'telegram_channels')
     AND NOT EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'public' AND table_name = 'youtube_channels')
  THEN
    ALTER TABLE public.telegram_channels RENAME TO youtube_channels;
    RAISE NOTICE 'telegram_channels переименована в youtube_channels';
  END IF;
END $$;

-- Индексы переименование таблицы за собой не тянет: они остаются со старыми
-- именами и в psql \d выглядят так, будто относятся к другой таблице.
DO $$
DECLARE r RECORD; new_name TEXT;
BEGIN
  FOR r IN
    SELECT indexname FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'youtube_channels'
       AND indexname LIKE '%telegram_channels%'
  LOOP
    new_name := replace(r.indexname, 'telegram_channels', 'youtube_channels');
    EXECUTE format('ALTER INDEX public.%I RENAME TO %I', r.indexname, new_name);
    RAISE NOTICE 'индекс % → %', r.indexname, new_name;
  END LOOP;
END $$;

COMMIT;

-- ── Проверка ────────────────────────────────────────────────────────────────
DO $$
DECLARE n INT; cnt BIGINT;
BEGIN
  SELECT count(*) INTO n FROM information_schema.tables
   WHERE table_schema = 'public' AND table_name = 'youtube_channels';
  IF n <> 1 THEN RAISE EXCEPTION 'youtube_channels не найдена'; END IF;

  SELECT count(*) INTO n FROM information_schema.tables
   WHERE table_schema = 'public' AND table_name = 'telegram_channels';
  IF n <> 0 THEN RAISE EXCEPTION 'telegram_channels всё ещё существует'; END IF;

  -- Данные должны переехать целиком: RENAME их не трогает, но если кто-то
  -- когда-то «переименует» пересозданием, счётчик это покажет.
  EXECUTE 'SELECT count(*) FROM public.youtube_channels' INTO cnt;
  IF cnt = 0 THEN
    RAISE WARNING 'youtube_channels пуста — ожидалось ~564 записи, проверь вручную';
  END IF;

  RAISE NOTICE 'youtube_channels на месте, записей: %', cnt;
END $$;
