-- 057 — снос мёртвых таблиц (Блок A, чистка по AUDIT_REPORT.md §11)
--
-- ── Что сносится и почему ───────────────────────────────────────────────────
--
-- conferences — создана миграцией 045, за всё время её не прочитала и не
-- записала ни одна функция и ни один экран дашборда. Строки в ней есть только
-- те, что залила сама 045. Это заготовка под конвейер, который решили не
-- делать; пока она стоит, схема утверждает, что конвейер конференций
-- существует.
--
-- Вместе с таблицей уходит leads.conference_id: колонка-внешний ключ, которую
-- ничто не заполняет. Оставить её нельзя чисто технически (FK не даст удалить
-- таблицу), но и незачем: без conferences она ссылается в пустоту.
--
-- ── Чего НЕ делаем: brand_modifiers остаётся ────────────────────────────────
--
-- ТЗ Блока A относит brand_modifiers к мёртвым артефактам с обоснованием «не
-- встречается в коде вообще». В коде — действительно не встречается, но в базе
-- встречается: её читает RPC brand_generate_keywords (миграция 029, JOIN по
-- m.lang = t.lang). Это не мёртвая таблица, а таблица, которую использует
-- хранимая функция, — поиск по .ts и .html её и не мог найти.
--
-- Уронить её сейчас значит сломать brand_generate_keywords, а ТЗ Блока B §3
-- прямо требует эту механику сохранить и перенаправить в search_keywords.
-- Снос ради формального выполнения пункта списка стоил бы того самого
-- пайплайна, который в соседнем ТЗ велено беречь.
--
-- Решение: brand_modifiers НЕ трогаем. Вопрос возвращается в Блок B вместе с
-- судьбой brand_generate_keywords — там он и решается по существу.
--
-- ── Порядок ─────────────────────────────────────────────────────────────────
-- Сначала колонка-ссылка, потом таблица: наоборот не даст внешний ключ.

BEGIN;

-- Индекс уходит сам вместе с колонкой, но пишем явно — чтобы миграция читалась
-- без знания того, что за индексы там были.
DROP INDEX IF EXISTS public.leads_conference;
ALTER TABLE public.leads DROP COLUMN IF EXISTS conference_id;

DROP TABLE IF EXISTS public.conferences;

COMMIT;

-- ── Проверка ────────────────────────────────────────────────────────────────
-- Миграция, которая «прошла», но ничего не сделала, — обычное дело при
-- IF EXISTS: она молча зелёная и на второй, и на сотый запуск. Поэтому
-- проверяем не факт выполнения, а конечное состояние.
DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n FROM information_schema.tables
   WHERE table_schema = 'public' AND table_name = 'conferences';
  IF n <> 0 THEN RAISE EXCEPTION 'conferences всё ещё существует'; END IF;

  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'leads' AND column_name = 'conference_id';
  IF n <> 0 THEN RAISE EXCEPTION 'leads.conference_id всё ещё существует'; END IF;

  -- Обратная проверка: brand_modifiers должна остаться. Если её однажды снесут
  -- «за компанию», эта строка скажет об этом громко, а не через сломанный
  -- brand_generate_keywords спустя недели.
  SELECT count(*) INTO n FROM information_schema.tables
   WHERE table_schema = 'public' AND table_name = 'brand_modifiers';
  IF n <> 1 THEN
    RAISE EXCEPTION 'brand_modifiers исчезла — её читает RPC brand_generate_keywords';
  END IF;

  RAISE NOTICE 'conferences и leads.conference_id удалены; brand_modifiers на месте';
END $$;
