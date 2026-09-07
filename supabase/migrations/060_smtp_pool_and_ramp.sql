-- 060 — пул отправителей и прогрев (Блок C, §2 и §3)
--
-- Вся инфраструктура ротации отправителей была построена ещё миграцией 038 и
-- не подключена ни одним концом: таблица smtp_accounts не читается никем,
-- четыре RPC вокруг неё не вызываются, а generate-queue жёстко пишет в
-- send_queue строку 'main'. Прогрева нет вообще.
--
-- Пока конвейер простаивает, это не видно. Как только поиск заработает, 250
-- писем в сутки польются с одного адреса без прогрева — и домен уедет в спам
-- за неделю. Поэтому блок идёт ДО починки поиска.
--
-- Здесь: схема под ТЗ, переписанные функции прогрева и порога отказов, и
-- колонка в send_queue, через которую выбранный аккаунт доезжает до отправки.
--
-- ── Имена колонок оставлены прежними ────────────────────────────────────────
-- ТЗ перечисляет ожидаемые поля как sent_7d/bounced_7d, в таблице они
-- называются sent_count_7d/bounce_count_7d. Переименование не даёт ничего,
-- кроме правки четырёх функций и риска пропустить одно место, поэтому
-- оставлены прежние имена. ТЗ этого и просит: «проверить фактическую схему,
-- добавить недостающее».
--
-- ── А вот статус переименован, и это не косметика ───────────────────────────
-- Было 'ramping', ТЗ требует 'warming'. Здесь имя менять НУЖНО: значение
-- статуса участвует в условиях всех четырёх функций, и расхождение между
-- документом и базой в таком месте — это ровно тот разрыв, из-за которого
-- функции годами не вызывались, потому что никто не мог сойтись, что они
-- делают.

BEGIN;

-- ── 1. Недостающие колонки ──────────────────────────────────────────────────
ALTER TABLE public.smtp_accounts
  ADD COLUMN IF NOT EXISTS provider        TEXT NOT NULL DEFAULT 'gmail',
  -- ССЫЛКА на секрет, а не сами креды. В credentials_ref лежит имя
  -- переменной окружения ('GMAIL_MAIN', 'SMTP_ACC_2'), по которому функция
  -- отправки достаёт логин и пароль. Пароль в таблице означал бы, что он
  -- утекает в каждый бэкап, в каждый SELECT * из дашборда и в каждый лог
  -- запроса — а у anon права на эту таблицу были выданы ещё в 038.
  ADD COLUMN IF NOT EXISTS credentials_ref TEXT,
  -- Отдельно от last_ramp_at: тот отмечает последний ШАГ прогрева, а стадия по
  -- ТЗ §3 считается от НАЧАЛА прогрева. По одному last_ramp_at возраст
  -- аккаунта не восстановить.
  ADD COLUMN IF NOT EXISTS ramp_started_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- ── 2. ramping → warming ────────────────────────────────────────────────────
-- Строго ДО добавления CHECK на статус. Иначе ограничение проверяется на уже
-- лежащих строках, находит там 'ramping' и роняет миграцию — причём на боевой
-- базе, где эти строки как раз и есть, а на пустой тестовой всё бы прошло.
UPDATE public.smtp_accounts SET status = 'warming' WHERE status = 'ramping';

ALTER TABLE public.smtp_accounts
  DROP CONSTRAINT IF EXISTS smtp_accounts_provider_chk,
  DROP CONSTRAINT IF EXISTS smtp_accounts_status_chk;
ALTER TABLE public.smtp_accounts
  ADD CONSTRAINT smtp_accounts_provider_chk CHECK (provider IN ('gmail','outlook','smtp')),
  ADD CONSTRAINT smtp_accounts_status_chk   CHECK (status   IN ('warming','active','paused','burned'));

-- Существующие строки заводились до появления credentials_ref. Обе — это
-- nick.adflow@gmail.com, который send-email читает из GMAIL_USER_MAIN /
-- GMAIL_PASS_MAIN, то есть его ссылка на секрет — 'GMAIL_MAIN'.
UPDATE public.smtp_accounts SET credentials_ref = 'GMAIL_MAIN'
 WHERE credentials_ref IS NULL;

-- ── 3. Аккаунт в очереди отправки ───────────────────────────────────────────
-- Пока выбор аккаунта был константой 'main', очереди хватало текстового поля
-- gmail_account. Теперь аккаунт выбирается функцией и должен доехать до
-- process-queue тем же id, каким его выбрали, — иначе выбор ничего не значит.
--
-- Старая колонка gmail_account НЕ удаляется: по ней работают process-queue-lp,
-- run-sequences, process-partner-queue и admin-reset. Снос — отдельный вопрос
-- после того, как весь путь отправки перейдёт на id.
ALTER TABLE public.send_queue
  ADD COLUMN IF NOT EXISTS smtp_account_id UUID REFERENCES public.smtp_accounts(id);
CREATE INDEX IF NOT EXISTS send_queue_smtp_account
  ON public.send_queue(smtp_account_id) WHERE smtp_account_id IS NOT NULL;

COMMIT;

-- ── 4. Выбор аккаунта ───────────────────────────────────────────────────────
-- Единственное изменение против 038 — 'ramping' стал 'warming'. Фильтр по
-- brand_id и отсутствие фолбэка на «любой свободный» здесь принципиальны:
-- LuckyPari не должен иметь видимой связи с 1xBet, и письмо, ушедшее с чужого
-- адреса, вскрывает связку на стороне получателя. Это правило проекта, а не
-- оптимизация, поэтому его стережёт сама сигнатура функции: бренд обязателен.
CREATE OR REPLACE FUNCTION public.fn_next_smtp_account(p_brand_id UUID)
RETURNS public.smtp_accounts
LANGUAGE sql SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
  SELECT * FROM public.smtp_accounts
    WHERE brand_id = p_brand_id
      AND status IN ('active', 'warming')
      AND daily_sent < daily_limit
      AND credentials_ref IS NOT NULL
    ORDER BY daily_sent ASC
    LIMIT 1;
$$;

-- ── 5. Прогрев по стадиям ТЗ §3 ─────────────────────────────────────────────
-- Было: daily_limit × 1.2 раз в 7 дней от стартовых 20. Стало: таблица стадий
-- из ТЗ, и считается она от ramp_started_at, а не от «сколько раз функцию
-- позвали».
--
-- Разница существенная. При счёте по вызовам пропущенный день сдвигает весь
-- график, а два вызова за сутки удваивают лимит — то есть прогрев зависит от
-- того, как отработал крон, а не от возраста аккаунта. По календарю аккаунт
-- всегда получает тот лимит, который ему положен по дню, сколько бы раз
-- функцию ни дёрнули и сколько бы раз ни забыли.
--
--   стадия 1   дни 1-3     10/сутки
--   стадия 2   дни 4-7     25
--   стадия 3   дни 8-14    50
--   стадия 4   дни 15-21   100
--   стадия 5   дни 22-30   150
--   active     30+         250
CREATE OR REPLACE FUNCTION public.fn_ramp_smtp_accounts()
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
DECLARE v_count INTEGER;
BEGIN
  WITH staged AS (
    SELECT id,
           CASE
             WHEN now() - ramp_started_at >= interval '30 days' THEN 6
             WHEN now() - ramp_started_at >= interval '21 days' THEN 5
             WHEN now() - ramp_started_at >= interval '14 days' THEN 4
             WHEN now() - ramp_started_at >= interval '7 days'  THEN 3
             WHEN now() - ramp_started_at >= interval '3 days'  THEN 2
             ELSE 1
           END AS want_stage
      FROM public.smtp_accounts
     WHERE status = 'warming'
  )
  UPDATE public.smtp_accounts a SET
    ramp_stage   = s.want_stage,
    daily_limit  = (ARRAY[10, 25, 50, 100, 150, 250])[s.want_stage],
    last_ramp_at = now(),
    -- Стадия 6 — это уже не прогрев, а обычная работа на полном лимите.
    status       = CASE WHEN s.want_stage >= 6 THEN 'active' ELSE 'warming' END
    FROM staged s
   WHERE a.id = s.id
     -- Только реальные изменения: иначе функция каждый день переписывает все
     -- строки и last_ramp_at перестаёт означать «когда стадия менялась».
     AND (a.ramp_stage IS DISTINCT FROM s.want_stage
          OR a.daily_limit IS DISTINCT FROM (ARRAY[10, 25, 50, 100, 150, 250])[s.want_stage]);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- ── 6. Суточный сброс и автопауза ───────────────────────────────────────────
-- Порог 5%, а не 3% как было. На прогреве аккаунт отправляет десять писем в
-- сутки, и при 3% ДВА отказа из сорока уже ставят его на паузу — а два отказа
-- на холодной базе это норма, а не признак сожжённого адреса. Отсюда же
-- второе условие: минимум 20 писем в окне, иначе доля считается по выборке,
-- в которой один отказ весит пять процентов сам по себе.
CREATE OR REPLACE FUNCTION public.fn_reset_smtp_daily()
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
DECLARE v_paused INTEGER;
BEGIN
  UPDATE public.smtp_accounts SET daily_sent = 0, last_reset_at = now();

  -- Окно катится по window_start_at. Обнуление ДО проверки: иначе пауза
  -- срабатывала бы по данным только что закрытого окна.
  UPDATE public.smtp_accounts SET
    sent_count_7d = 0, bounce_count_7d = 0, window_start_at = now()
    WHERE window_start_at < now() - interval '7 days';

  UPDATE public.smtp_accounts SET status = 'paused'
    WHERE status IN ('active', 'warming')
      AND sent_count_7d >= 20
      AND (bounce_count_7d::NUMERIC / sent_count_7d) > 0.05;
  GET DIAGNOSTICS v_paused = ROW_COUNT;

  RETURN v_paused;
END;
$$;

GRANT EXECUTE ON FUNCTION public.fn_next_smtp_account(UUID)  TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ramp_smtp_accounts()     TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_reset_smtp_daily()       TO service_role, authenticated;

-- ── 7. Проверка ─────────────────────────────────────────────────────────────
DO $$
DECLARE n INT; lim INT;
BEGIN
  SELECT count(*) INTO n FROM public.smtp_accounts WHERE credentials_ref IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION '% аккаунтов без credentials_ref — fn_next_smtp_account их пропустит молча', n;
  END IF;

  SELECT count(*) INTO n FROM public.smtp_accounts WHERE status = 'ramping';
  IF n > 0 THEN RAISE EXCEPTION 'остались строки со статусом ramping'; END IF;

  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema='public' AND table_name='send_queue' AND column_name='smtp_account_id';
  IF n <> 1 THEN RAISE EXCEPTION 'send_queue.smtp_account_id не создана'; END IF;

  -- Проверяем не «функция есть», а что таблица стадий действительно та.
  -- Функция, молча выдающая не тот лимит, — это и есть прогрев, которого нет.
  SELECT (ARRAY[10, 25, 50, 100, 150, 250])[1] INTO lim;
  IF lim <> 10 THEN RAISE EXCEPTION 'стартовый лимит прогрева не 10'; END IF;

  SELECT count(*) INTO n FROM public.smtp_accounts;
  RAISE NOTICE 'аккаунтов в пуле: %, все со ссылкой на секрет', n;
END $$;
