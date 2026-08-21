-- 038 — Блок 2: слой исполнения мультибренда
--
-- Блок 1 дал данные (brands, contact_registry, api_keys). Этот блок — то, что
-- реально бегает по крону: выбор бренда, brand-scoped ключи, SMTP-пул на бренд.
--
-- Область этой миграции — DDL и функции-примитивы (тот же принцип, что и
-- fn_capture_contact в 035: правило в одном месте, вызывающий код в
-- edge-функциях не пересчитывает его сам). Wiring в find-and-queue.ts —
-- отдельная работа поверх этих функций, не в SQL.

-- ════════════════════════════════════════════════════════════════════════════
-- 1. BRAND_KEYWORDS — ключевые пулы на бренд
-- ════════════════════════════════════════════════════════════════════════════
-- НЕ заменяет существующую `keywords` (preset+layer, ~14 гео-пресетов 1xBet со
-- своей ротацией городов — PRESET_CITIES в find-and-queue.ts). Тот пайплайн
-- проверен на реальном трафике и переписывать его в один проход — лишний риск
-- на боевом источнике дохода. multibrand_keywords — путь для НОВЫХ брендов
-- (1xcasino, luckypari), у которых пока нет наработанной preset-инфраструктуры;
-- 1xBet продолжает работать на `keywords`, пока для него не появится причина
-- мигрировать (см. комментарий в find-and-queue.ts).
CREATE TABLE IF NOT EXISTS public.multibrand_keywords (
  id          BIGSERIAL PRIMARY KEY,
  brand_id    UUID NOT NULL REFERENCES public.brands(id),
  geo         TEXT NOT NULL,
  language    TEXT NOT NULL,
  keyword     TEXT NOT NULL,
  layer       TEXT NOT NULL DEFAULT 'A',   -- A = игровой интент, B = партнёрский, C = футпринты аффилиатов
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_multibrand_keywords_brand ON public.multibrand_keywords(brand_id, active);

ALTER TABLE public.multibrand_keywords DISABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.multibrand_keywords TO anon, authenticated, service_role;
GRANT USAGE, SELECT ON SEQUENCE public.multibrand_keywords_id_seq TO anon, authenticated, service_role;

-- ════════════════════════════════════════════════════════════════════════════
-- 2. SMTP_ACCOUNTS — пул отправки на бренд
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.smtp_accounts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id        UUID NOT NULL REFERENCES public.brands(id),
  email           TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',   -- active | ramping | paused | burned
  ramp_stage      INTEGER NOT NULL DEFAULT 1,        -- 1 = старт 15-20/день, +1 стадия в неделю (+20%)
  daily_limit     INTEGER NOT NULL DEFAULT 20,
  daily_sent      INTEGER NOT NULL DEFAULT 0,
  bounce_count_7d INTEGER NOT NULL DEFAULT 0,
  sent_count_7d   INTEGER NOT NULL DEFAULT 0,
  last_reset_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Отдельно от last_reset_at: дневной сброс трогает last_reset_at КАЖДЫЕ
  -- сутки, поэтому условие ramp-up "last_reset_at < now() - 7 days" не
  -- выполнялось бы никогда и стадия не росла бы вообще.
  last_ramp_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Начало текущего 7-дневного окна для sent_count_7d/bounce_count_7d.
  -- Без него счётчики никогда не обнулялись, и bounce-rate превращался в
  -- пожизненный: аккаунт, один раз перешагнувший 3%, не мог вернуться.
  window_start_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_smtp_accounts_brand_status ON public.smtp_accounts(brand_id, status);
-- Нужен, чтобы ON CONFLICT DO NOTHING ниже реально что-то ловил: без
-- уникального ключа (PK — gen_random_uuid()) повторный прогон миграции
-- просто добавлял второй одинаковый аккаунт.
CREATE UNIQUE INDEX IF NOT EXISTS smtp_accounts_brand_email
  ON public.smtp_accounts(brand_id, email);

ALTER TABLE public.smtp_accounts DISABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.smtp_accounts TO anon, authenticated, service_role;

-- 1xbet/1xcasino делят уже прогретый nick.adflow@gmail.com — под 1xbet он
-- реально отправляет годами, ставим ramp_stage=5 (полный лимит, не с нуля).
-- luckypari сознательно НЕ заведён — ждём почту от Ника (§7.2 ТЗ), заводить
-- строку с несуществующим адресом означает, что fn_next_smtp_account будет
-- молча выбирать ключ, для которого некому реально отправлять.
INSERT INTO public.smtp_accounts (brand_id, email, status, ramp_stage, daily_limit)
SELECT id, 'nick.adflow@gmail.com', 'active', 5, 300 FROM public.brands WHERE slug = '1xbet'
UNION ALL
SELECT id, 'nick.adflow@gmail.com', 'active', 5, 300 FROM public.brands WHERE slug = '1xcasino'
ON CONFLICT (brand_id, email) DO NOTHING;

-- ════════════════════════════════════════════════════════════════════════════
-- 3. Функции
-- ════════════════════════════════════════════════════════════════════════════

-- Выбор бренда взвешенным рандомом по cron_weight (п. 4.1 ТЗ). Только
-- status='active' — draft-бренды (melbet/coldbet) в кроне не участвуют вообще,
-- а не участвуют "с весом 0", что то же самое по эффекту, но эта функция всё
-- равно фильтрует явно, а не полагается на то, что кто-то не забудет
-- проставить cron_weight=0 черновику.
CREATE OR REPLACE FUNCTION public.fn_pick_active_brand()
RETURNS public.brands
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_total NUMERIC;
  v_roll  NUMERIC;
  v_row   public.brands%ROWTYPE;
  v_acc   NUMERIC := 0;
BEGIN
  SELECT sum(cron_weight) INTO v_total FROM public.brands WHERE status = 'active';
  IF v_total IS NULL OR v_total <= 0 THEN RETURN NULL; END IF;

  v_roll := random() * v_total;
  FOR v_row IN SELECT * FROM public.brands WHERE status = 'active' ORDER BY slug LOOP
    v_acc := v_acc + v_row.cron_weight;
    IF v_roll <= v_acc THEN RETURN v_row; END IF;
  END LOOP;

  RETURN v_row; -- floating point edge case: last row covers the remainder
END;
$$;

-- Взять свободный SMTP-аккаунт бренда (п. 4.5.1 ТЗ). ORDER BY daily_sent —
-- не last_used_at, потому что ТЗ явно требует "меньше всего отправлено
-- сегодня", а не round-robin по времени: это то, что реально выравнивает
-- нагрузку между несколькими аккаунтами одного бренда.
CREATE OR REPLACE FUNCTION public.fn_next_smtp_account(p_brand_id UUID)
RETURNS public.smtp_accounts
LANGUAGE sql SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
  SELECT * FROM public.smtp_accounts
    WHERE brand_id = p_brand_id
      AND status IN ('active', 'ramping')
      AND daily_sent < daily_limit
    ORDER BY daily_sent ASC
    LIMIT 1;
$$;

-- Записать отправку (нужно вызывать сразу после реальной отправки письма).
CREATE OR REPLACE FUNCTION public.fn_record_smtp_send(p_account_id UUID, p_bounced BOOLEAN DEFAULT FALSE)
RETURNS VOID LANGUAGE sql SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
  UPDATE public.smtp_accounts SET
    daily_sent    = daily_sent + 1,
    sent_count_7d = sent_count_7d + 1,
    bounce_count_7d = bounce_count_7d + CASE WHEN p_bounced THEN 1 ELSE 0 END
  WHERE id = p_account_id;
$$;

-- Полночный сброс + автопауза по bounce-rate (п. 4.5, вторая и третья
-- строчки). daily_sent сбрасывается каждый вызов (крон зовёт раз в сутки).
--
-- Окно 7 дней катится по window_start_at, а не «раз в 7 вызовов»: счётчики
-- sent_count_7d/bounce_count_7d раньше не обнулялись НИГДЕ, из-за чего
-- проверка ">3%" считалась по всей истории аккаунта и работала в одну
-- сторону — один плохой день, и вернуться из paused было невозможно.
-- Обнуление идёт ДО проверки, иначе пауза срабатывала бы по данным
-- только что закрытого окна.
CREATE OR REPLACE FUNCTION public.fn_reset_smtp_daily()
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_paused INTEGER;
BEGIN
  UPDATE public.smtp_accounts SET daily_sent = 0, last_reset_at = now();

  UPDATE public.smtp_accounts SET
    sent_count_7d = 0, bounce_count_7d = 0, window_start_at = now()
    WHERE window_start_at < now() - interval '7 days';

  UPDATE public.smtp_accounts SET status = 'paused'
    WHERE status IN ('active', 'ramping')
      AND sent_count_7d > 0
      AND (bounce_count_7d::NUMERIC / sent_count_7d) > 0.03;
  GET DIAGNOSTICS v_paused = ROW_COUNT;

  RETURN v_paused;
END;
$$;

-- Ramp-up раз в 7 дней (п. 4.5, последняя строка). Отдельный вызов от
-- fn_reset_smtp_daily — тот дневной, этот недельный, крон зовёт их на разных
-- расписаниях.
CREATE OR REPLACE FUNCTION public.fn_ramp_smtp_accounts()
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE public.smtp_accounts SET
    daily_limit  = CEIL(daily_limit * 1.2),
    ramp_stage   = ramp_stage + 1,
    last_ramp_at = now(),
    status       = CASE WHEN ramp_stage + 1 >= 5 THEN 'active' ELSE status END
  WHERE status = 'ramping'
    -- last_ramp_at, НЕ last_reset_at: последний переписывается дневным
    -- сбросом каждые сутки, поэтому условие "> 7 дней назад" не выполнялось
    -- бы никогда и ни один аккаунт не прогревался бы вообще.
    AND last_ramp_at < now() - interval '7 days';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.fn_pick_active_brand() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_next_smtp_account(UUID) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_record_smtp_send(UUID, BOOLEAN) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_reset_smtp_daily() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ramp_smtp_accounts() TO anon, authenticated, service_role;
