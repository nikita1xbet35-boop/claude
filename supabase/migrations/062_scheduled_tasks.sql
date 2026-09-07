-- 062 — расписание в базе вместо wrangler.jsonc (Блок D)
--
-- ── Что здесь чинится на самом деле ─────────────────────────────────────────
-- Пока расписание живёт в конфиге воркера, крон-строка и обработчик под неё —
-- две независимые вещи, и рассинхрон между ними ничем не заметен. Он и
-- случился, причём трижды.
--
-- Сейчас в wrangler.jsonc: */2, */7, */12, */15.
-- Сейчас в worker.js:      */2, */3, */7, */15, "0 7 * * *".
--
--   */12  — триггер БЕЗ обработчика. Срабатывает каждые 12 минут и ничего не
--           делает: ни одна ветка под него не подходит.
--   */3   — обработчик БЕЗ триггера. Это find-and-queue, dfs-qualify,
--           dfs-enrich, find-contact-form, process-form-queue. Поиск.
--   0 7   — обработчик БЕЗ триггера. daily-report и archive-keywords.
--
-- Как это вышло, видно в истории: коммит 165bad5 «сбавить темп поиска» заменил
-- */3 на */12 в конфиге и не тронул условие в коде. С этого момента поиск
-- перестал запускаться по расписанию вообще.
--
-- Это не гипотеза. Диагностика 07.09 13:15 показывает:
--   generate-queue   (триггер */2 есть)   последний лог 1 минуту назад
--   find-and-queue   (триггер */3 нет)    последний лог 720 минут назад
--   CRON CADENCE: find-and-queue за 2 часа — пусто
-- А те редкие прогоны find-and-queue, что есть в funnel_stats, идут примерно
-- раз в сутки и совпадают по времени с прогонами диагностического воркфлоу,
-- который дёргает функцию напрямую. То есть поиск работал ровно тогда, когда
-- его будила диагностика.
--
-- daily-report в списке свежести отсутствует вовсе — он не запускался ни разу.
-- Значит и вызовы прогрева отправителей из Блока C, повешенные на его тик, не
-- отработали ни разу.
--
-- ── Про «одну задачу за тик» ────────────────────────────────────────────────
-- ТЗ §2 требует брать одну задачу за тик, §7 прямо запрещает несколько. Но
-- арифметика этого не выдерживает:
--
--   5 задач × каждые 120 с = 3600 запусков в сутки
--   5 задач × каждые 420 с = 1029
--   8 задач × каждые 900 с =  768
--   5 задач × каждые 720 с =  600
--   2 задачи × раз в сутки =    2
--   ─────────────────────────────
--   итого нужно ~6000 запусков, а тиков в сутках 1440.
--
-- При строгом «один за тик» система замедлилась бы вчетверо против текущей —
-- то есть блок, который чинит расписание, сам стал бы главным тормозом.
-- Поэтому за тик берётся НЕСКОЛЬКО задач, а их число — настройка
-- dispatcher_max_per_tick в system_config, по умолчанию 8. Вернуть букву ТЗ
-- можно одним UPDATE, не трогая код.
--
-- Восемь параллельных вызовов — не новая нагрузка: текущий код уже запускает
-- по 5-8 функций в одном тике через Promise.all. Меняется способ вызова, а не
-- объём работы, чего ТЗ §7 и требует.

CREATE TABLE IF NOT EXISTS public.scheduled_tasks (
  id              BIGSERIAL PRIMARY KEY,
  name            TEXT UNIQUE NOT NULL,
  handler         TEXT NOT NULL,
  interval_sec    INTEGER NOT NULL,
  priority        INTEGER NOT NULL DEFAULT 100,
  enabled         BOOLEAN NOT NULL DEFAULT true,
  pipeline        TEXT,

  last_run_at     TIMESTAMPTZ,
  last_status     TEXT,
  last_error      TEXT,
  last_duration_ms INTEGER,
  consecutive_errors INTEGER NOT NULL DEFAULT 0,

  locked_at       TIMESTAMPTZ,
  lock_ttl_sec    INTEGER NOT NULL DEFAULT 300,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT scheduled_tasks_interval_chk CHECK (interval_sec > 0),
  CONSTRAINT scheduled_tasks_status_chk
    CHECK (last_status IS NULL OR last_status IN ('ok','error','skipped','timeout'))
);

-- Выбор «кому пора» идёт по enabled + locked_at + last_run_at на каждом тике,
-- то есть раз в минуту. Индекс держит его дешёвым.
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_due
  ON public.scheduled_tasks(enabled, locked_at, last_run_at);

REVOKE ALL ON public.scheduled_tasks FROM anon;
REVOKE ALL ON SEQUENCE public.scheduled_tasks_id_seq FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.scheduled_tasks TO service_role, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.scheduled_tasks_id_seq TO service_role, authenticated;

INSERT INTO public.system_config (key, value) VALUES
  ('dispatcher_max_per_tick', '8')
ON CONFLICT (key) DO NOTHING;

-- ── Расписание ──────────────────────────────────────────────────────────────
-- Интервалы взяты из ТОГО, ЧТО ЗАДУМАНО в worker.js, а не из того, что стоит
-- в wrangler.jsonc: конфиг как раз и разошёлся с кодом. Суточная ветка
-- возвращается к своим суткам, поисковая — к 12 минутам (см. ниже).
--
-- priority: меньше = важнее. При нехватке слотов в тике первыми идут отправка
-- и наполнение очереди — то, что напрямую производит письма. Диагностика и
-- архивация ждут: их опоздание на несколько минут не стоит ничего.
INSERT INTO public.scheduled_tasks (name, handler, interval_sec, priority, pipeline) VALUES
  -- Ядро: очередь и отправка (было */2)
  ('process-queue',          'process-queue',          120,  10, NULL),
  ('generate-queue',         'generate-queue',         120,  20, NULL),
  ('extract-contacts',       'extract-contacts',       120,  30, NULL),
  ('generate-queue-dfs',     'generate-queue-dfs',     120,  40, 'dataforseo'),
  ('process-partner-queue',  'process-partner-queue',  120,  50, NULL),

  -- Поиск — 720 секунд, а НЕ прежние 180.
  --
  -- Замедление с */3 до */12 было осознанным: DuckDuckGo начал банить,
  -- 20 прогонов в час × 5 ключей = 100 запросов в час с одного адреса
  -- дата-центра, и половина прогонов уходила впустую. Ошибка коммита 165bad5
  -- не в новом темпе, а в том, что ветку в коде под него не переименовали, и
  -- замедление превратилось в полную остановку.
  --
  -- Поэтому сюда переезжает намерение (12 минут), а не старое число: вернуть
  -- 180 значило бы под видом починки расписания молча воспроизвести тот самый
  -- темп, который привёл к бану.
  ('find-and-queue',         'find-and-queue',         720,  15, 'search'),
  ('dfs-qualify',            'dfs-qualify',            720,  60, 'dataforseo'),
  ('dfs-enrich',             'dfs-enrich',             720,  60, 'dataforseo'),
  ('find-contact-form',      'find-contact-form',      720,  70, NULL),
  ('process-form-queue',     'process-form-queue',     720,  70, NULL),

  -- Средний темп (было */7)
  ('poll-replies',           'poll-replies',           420,  35, NULL),
  ('process-queue-lp',       'process-queue-lp',       420,  55, NULL),
  ('youtube-search',         'youtube-search',         420,  80, NULL),
  ('find-appstore',          'find-appstore',          420,  80, NULL),
  ('recover-contacts',       'recover-contacts',       420,  85, NULL),

  -- Медленный темп (было */15)
  ('check-limits',           'check-limits',           900,  25, NULL),
  ('run-sequences',          'run-sequences',          900,  45, NULL),
  ('validate-emails',        'validate-emails',        900,  65, NULL),
  ('score-leads',            'score-leads',            900,  75, NULL),
  ('scan-tg-channels',       'scan-tg-channels',       900,  75, NULL),
  ('extract-tg-contact',     'extract-tg-contact',     900,  90, NULL),
  ('draft-tg-message',       'draft-tg-message',       900,  90, NULL),
  ('send-tg-leads',          'send-tg-leads',          900,  90, NULL),

  -- Суточные (было "0 7 * * *" — и не запускалось никогда)
  --
  -- daily-report несёт на себе обслуживание пула отправителей из Блока C:
  -- fn_reset_smtp_daily и fn_ramp_smtp_accounts. Пока эта строка не появилась,
  -- прогрев не двигался ни на день.
  ('daily-report',           'daily-report',           86400, 95, NULL),
  -- archive-keywords отбраковывает выгоревшие ключи. Телеметрия под это
  -- появилась в Блоке B, а запускать функцию было нечем: мест в кроне не было.
  ('archive-keywords',       'archive-keywords',       86400, 99, NULL)
ON CONFLICT (name) DO UPDATE
  SET handler      = EXCLUDED.handler,
      interval_sec = EXCLUDED.interval_sec,
      priority     = EXCLUDED.priority,
      pipeline     = EXCLUDED.pipeline;
-- ON CONFLICT DO UPDATE, но БЕЗ enabled: если задачу выключили руками или её
-- отключил счётчик ошибок, повторный прогон миграции не должен молча включать
-- её обратно. Состояние принадлежит системе, расписание — этому файлу.

-- ── Проверка ────────────────────────────────────────────────────────────────
DO $$
DECLARE n INT; need NUMERIC; cap INT;
BEGIN
  SELECT count(*) INTO n FROM public.scheduled_tasks;
  IF n < 25 THEN RAISE EXCEPTION 'ожидалось 25 задач, найдено %', n; END IF;

  -- Задача без обработчика — это тихо не запускающаяся задача, ровно то, что
  -- этот блок и чинит. Пустое имя обработчика ловим здесь, а не в проде.
  SELECT count(*) INTO n FROM public.scheduled_tasks WHERE btrim(handler) = '';
  IF n > 0 THEN RAISE EXCEPTION '% задач без обработчика', n; END IF;

  -- Тот самый расчёт из шапки, посчитанный по фактическим строкам. Если
  -- кто-то добавит задач и потребность перестанет помещаться в бюджет тика,
  -- это скажется здесь, а не в виде необъяснимо отстающего конвейера.
  SELECT sum(86400.0 / interval_sec) INTO need
    FROM public.scheduled_tasks WHERE enabled;
  SELECT (value #>> '{}')::INT INTO cap FROM public.system_config
   WHERE key = 'dispatcher_max_per_tick';
  RAISE NOTICE 'запусков в сутки нужно ~%, бюджет 1440 тиков × % = %',
    round(need), cap, 1440 * cap;
  IF need > 1440 * cap THEN
    RAISE EXCEPTION 'расписание не помещается в бюджет: нужно ~%, доступно %',
      round(need), 1440 * cap;
  END IF;

  PERFORM 1 FROM information_schema.role_table_grants
   WHERE table_schema='public' AND table_name='scheduled_tasks' AND grantee='anon';
  IF FOUND THEN RAISE EXCEPTION 'у anon остались права на scheduled_tasks'; END IF;
END $$;
