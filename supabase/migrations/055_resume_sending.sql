-- 055 — снять паузу с отправки по основному пайплайну
--
-- Замков было два, и оба ставились сознательно (041 + пустой массив кронов в
-- wrangler.jsonc). Этот снимает первый: флаг pipeline_limits.paused, который
-- читает process-queue перед каждой отправкой. Второй — расписание */2 —
-- снимается в том же коммите, в wrangler.jsonc.
--
-- Разрешение получено явно: «можешь запустить отправку, это не проблема».
--
-- ── Почему только 'search' ──────────────────────────────────────────────────
-- В таблице два пайплайна. 'search' — тот, что мы весь день чинили и чьи лиды
-- готовы: 252 адреса с контактами, ни одному ещё не писали.
--
-- 'dataforseo' остаётся на паузе. Это отдельный источник лидов со своей
-- стоимостью и своим качеством, его никто не просил включать, и запускать две
-- разные рассылки одним движением — верный способ потом не понять, откуда
-- пришли жалобы. Включается одной строкой:
--   UPDATE public.pipeline_limits SET paused = false WHERE pipeline = 'dataforseo';
UPDATE public.pipeline_limits SET paused = false WHERE pipeline = 'search';

-- ── Проверка ────────────────────────────────────────────────────────────────
DO $$
DECLARE n INT; lim INT;
BEGIN
  SELECT count(*) INTO n FROM public.pipeline_limits
   WHERE pipeline = 'search' AND paused = false;
  IF n <> 1 THEN RAISE EXCEPTION 'пайплайн search не снялся с паузы'; END IF;

  -- Дневной потолок — единственное, что стоит между «пошла рассылка» и
  -- «разослали всё разом». Ноль или отсутствие строки означали бы отправку без
  -- ограничения, а это репутация домена.
  SELECT daily_limit INTO lim FROM public.pipeline_limits WHERE pipeline = 'search';
  IF lim IS NULL OR lim <= 0 THEN
    RAISE EXCEPTION 'у search нет дневного потолка — отправка пошла бы без ограничения';
  END IF;

  SELECT count(*) INTO n FROM public.pipeline_limits WHERE pipeline = 'dataforseo' AND paused;
  RAISE NOTICE 'search снят с паузы, потолок % писем в сутки; dataforseo на паузе: %', lim, n;
END $$;
