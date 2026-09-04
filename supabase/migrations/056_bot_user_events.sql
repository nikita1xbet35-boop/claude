-- 056 — журнал действий пользователей ботов + статус лида для админ-бота
--
-- ТЗ §3 просит сначала посмотреть, чего не хватает в существующих таблицах.
-- Не хватает двух вещей, и ни одна не втискивается в имеющееся:
--
-- 1. ЖУРНАЛА ДЕЙСТВИЙ. Сейчас факт фиксируется только один — выдача ссылки, и
--    то строкой в bot_leads. Ни /start, ни FAQ, ни проверка ГЕО, ни смена
--    языка нигде не остаются. Без них ни воронка, ни карточка пользователя не
--    считаются, а именно они и есть смысл админ-бота.
--
-- 2. СТАТУСА ЛИДА в смысле ТЗ (new/in_work/registered/lost/spam).
--    В bot_leads.status уже есть колонка с таким именем, но другим смыслом:
--    link_issued | contacted_manager | inactive. По ней работает выборка
--    реминдера (status=eq.link_issued в sendReminders). Дописать туда чужие
--    значения — значит тихо сломать рассылку напоминаний: лид со статусом
--    in_work перестал бы попадать в выборку и не получил бы напоминание.

-- ── 1. Журнал ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.bot_user_events (
  id           BIGSERIAL PRIMARY KEY,
  bot_slug     TEXT NOT NULL REFERENCES public.bot_configs(slug),
  tg_user_id   BIGINT NOT NULL,
  event        TEXT NOT NULL,   -- start | link_issued | faq_opened | geo_checked
                                -- | manager_clicked | lang_changed | reminder_sent
                                -- | status_changed
  detail       TEXT,            -- какой ГЕО проверял, на какой язык переключил,
                                -- в какой статус перевели
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bot_user_events_user
  ON public.bot_user_events (tg_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bot_user_events_bot_date
  ON public.bot_user_events (bot_slug, created_at DESC);
-- Под проверку «первый ли это /start в этом боте» — она делается на КАЖДЫЙ
-- /start, то есть чаще всех остальных запросов вместе взятых.
CREATE INDEX IF NOT EXISTS idx_bot_user_events_first_start
  ON public.bot_user_events (bot_slug, tg_user_id) WHERE event = 'start';

-- ── 2. Статус лида ──────────────────────────────────────────────────────────
-- Живёт в bot_user_prefs, а не в bot_leads, и это не произвол: строка в prefs
-- заводится на первом же /start (её создаёт setAwaiting), а в bot_leads —
-- только когда человек попросил ссылку. Кнопки статуса висят под уведомлением
-- о /start, то есть у большинства помеченных лида в bot_leads ещё нет.
ALTER TABLE public.bot_user_prefs
  ADD COLUMN IF NOT EXISTS admin_status TEXT NOT NULL DEFAULT 'new';

-- Юзернейм здесь же. Он есть в bot_leads, но только у тех, кто дошёл до
-- ссылки; команда /user @username должна находить и тех, кто просто нажал
-- /start. Пишется воркером при каждом /start — юзернейм меняется, и последний
-- известный полезнее первого.
ALTER TABLE public.bot_user_prefs
  ADD COLUMN IF NOT EXISTS tg_username TEXT;

UPDATE public.bot_user_prefs p
   SET tg_username = l.tg_username
  FROM public.bot_leads l
 WHERE l.bot_slug = p.bot_slug AND l.tg_user_id = p.tg_user_id
   AND p.tg_username IS NULL AND l.tg_username IS NOT NULL;

-- ── 3. Бэкфилл (ТЗ §5.8) ────────────────────────────────────────────────────
-- Без него /stats начинает с нуля и выглядит так, будто ботами никто не
-- пользовался. Плюс важный побочный эффект: событие 'start' на уже известных
-- пользователей не даст админ-боту прислать уведомление о каждом из них
-- задним числом при первом же их возвращении.
--
-- Честная оговорка про время: у существующих лидов нет отметки, когда они
-- нажали /start — есть только link_issued_at. Берём её: /start заведомо был не
-- позже выдачи ссылки. Для суточных и недельных срезов это безразлично (записи
-- старые), для /stats за всё время — тем более.
INSERT INTO public.bot_user_events (bot_slug, tg_user_id, event, detail, created_at)
SELECT l.bot_slug, l.tg_user_id, 'start', 'бэкфилл из bot_leads', l.link_issued_at
  FROM public.bot_leads l
 WHERE NOT EXISTS (
   SELECT 1 FROM public.bot_user_events e
    WHERE e.bot_slug = l.bot_slug AND e.tg_user_id = l.tg_user_id AND e.event = 'start');

INSERT INTO public.bot_user_events (bot_slug, tg_user_id, event, detail, created_at)
SELECT l.bot_slug, l.tg_user_id, 'link_issued', l.ref_code, l.link_issued_at
  FROM public.bot_leads l
 WHERE NOT EXISTS (
   SELECT 1 FROM public.bot_user_events e
    WHERE e.bot_slug = l.bot_slug AND e.tg_user_id = l.tg_user_id AND e.event = 'link_issued');

INSERT INTO public.bot_user_events (bot_slug, tg_user_id, event, detail, created_at)
SELECT l.bot_slug, l.tg_user_id, 'manager_clicked', 'бэкфилл из bot_leads', l.last_interaction_at
  FROM public.bot_leads l
 WHERE l.status = 'contacted_manager'
   AND NOT EXISTS (
   SELECT 1 FROM public.bot_user_events e
    WHERE e.bot_slug = l.bot_slug AND e.tg_user_id = l.tg_user_id AND e.event = 'manager_clicked');

-- ── 4. Воронка одним запросом ───────────────────────────────────────────────
-- Считается в базе, а не в воркере: PostgREST не умеет GROUP BY, и без этой
-- функции /stats пришлось бы собирать выгрузкой всех событий с агрегацией в
-- памяти — то есть тем медленнее, чем успешнее боты.
--
-- Считаем УНИКАЛЬНЫХ людей, а не события: человек, нажавший «получить ссылку»
-- трижды, — это один взявший ссылку, а не три.
CREATE OR REPLACE FUNCTION public.fn_bot_funnel(p_since TIMESTAMPTZ DEFAULT NULL)
RETURNS TABLE (bot_slug TEXT, geo_label TEXT, starts BIGINT, links BIGINT, managers BIGINT)
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT c.slug,
         c.geo_label,
         count(DISTINCT e.tg_user_id) FILTER (WHERE e.event = 'start'),
         count(DISTINCT e.tg_user_id) FILTER (WHERE e.event = 'link_issued'),
         count(DISTINCT e.tg_user_id) FILTER (WHERE e.event = 'manager_clicked')
    FROM public.bot_configs c
    LEFT JOIN public.bot_user_events e
           ON e.bot_slug = c.slug
          AND (p_since IS NULL OR e.created_at >= p_since)
          -- Отрицательный id — это самотест деплоя (/selftest гоняет все
          -- функции под uid -1, настоящих пользователей с таким id не бывает).
          -- Без этой строки каждый деплой добавлял бы восемь «новых
          -- пользователей» в статистику.
          AND e.tg_user_id > 0
   GROUP BY c.slug, c.geo_label
   ORDER BY 3 DESC, 1;
$$;

-- ── 5. Доступ ───────────────────────────────────────────────────────────────
-- Как и в 048: умолчания Supabase уже выдали права anon на новую таблицу, их
-- надо отобрать. В bot_user_events лежат telegram id живых людей.
REVOKE ALL ON public.bot_user_events FROM anon, authenticated, PUBLIC;
REVOKE ALL ON SEQUENCE public.bot_user_events_id_seq FROM anon, authenticated, PUBLIC;

ALTER TABLE public.bot_user_events ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON public.bot_user_events TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.bot_user_events TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.bot_user_events_id_seq TO service_role;

DROP POLICY IF EXISTS bot_user_events_read ON public.bot_user_events;
CREATE POLICY bot_user_events_read ON public.bot_user_events
  FOR SELECT TO authenticated USING (true);

REVOKE ALL ON FUNCTION public.fn_bot_funnel(TIMESTAMPTZ) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_bot_funnel(TIMESTAMPTZ) TO service_role, authenticated;

-- ── 6. Проверка ─────────────────────────────────────────────────────────────
DO $$
DECLARE n INT; n_leads INT; n_start INT;
BEGIN
  SELECT count(*) INTO n FROM information_schema.role_table_grants
   WHERE table_schema = 'public' AND table_name = 'bot_user_events' AND grantee = 'anon';
  IF n > 0 THEN
    RAISE EXCEPTION 'anon получил % прав на bot_user_events — там telegram id живых людей', n;
  END IF;

  -- Бэкфилл обязан покрыть КАЖДЫЙ существующий лид: пропущенный означает, что
  -- этому человеку прилетит уведомление «новый пользователь» при следующем его
  -- заходе, хотя он давно известен.
  SELECT count(*) INTO n_leads FROM public.bot_leads;
  SELECT count(DISTINCT (bot_slug, tg_user_id)) INTO n_start
    FROM public.bot_user_events WHERE event = 'start';
  IF n_start < n_leads THEN
    RAISE EXCEPTION 'бэкфилл неполон: лидов %, стартов %', n_leads, n_start;
  END IF;

  SELECT count(*) INTO n FROM public.bot_user_prefs WHERE admin_status IS NULL;
  IF n > 0 THEN RAISE EXCEPTION 'admin_status не проставился у % строк', n; END IF;

  RAISE NOTICE 'журнал событий готов: лидов %, событий start %', n_leads, n_start;
END $$;
