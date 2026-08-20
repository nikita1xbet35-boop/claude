-- 041 — Полная остановка системы на время правок мультибренд-UI
--
-- Зачем отдельная миграция, а не просто "выключить в интерфейсе": в системе
-- НЕТ единого выключателя. system_paused (admin-reset.ts) нигде не читается —
-- мёртвый флаг. pipeline_limits.paused останавливает только отправку
-- (process-queue) и доливку очереди (generate-queue-brand/dfs) — сам поиск
-- (find-and-queue, brand-search, scan-tg-channels, youtube-search,
-- dfs-harvest/qualify) продолжил бы жечь Groq/SerpApi/DuckDuckGo-лимиты
-- по расписанию независимо от этого флага: find-and-queue.ts прямо
-- прокомментирован "never pauses — finding new leads is always valuable".
--
-- Единственное, что реально останавливает крон — сам pg_cron (см. рассуждение
-- в 030_brand_crons.sql: расписания живут в cron.job этой базы, не в репо).
-- Отключаем через active=false, а не cron.unschedule() — обратимо одной
-- строкой, не нужно помнить расписание, чтобы включить обратно:
--
--   UPDATE cron.job SET active = true
--     WHERE jobname IN (SELECT jobname FROM cron.job WHERE active = false)
--     AND command ~* 'find-and-queue|brand-search|brand-enrich|scan-tg|youtube-search|dfs-|generate-queue|process-queue|check-limits|poll-replies|score-leads|validate-emails';
--
-- (или прицельно по конкретному jobname — см. NOTICE, которые эта миграция
-- печатает при выполнении, там весь список того, что было выключено.)

DO $$
DECLARE
  j RECORD;
  n INT := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron не установлен — нечего останавливать на уровне БД. Если крон настроен иначе (внешний Worker), останавливать нужно там.';
  ELSE
    FOR j IN
      SELECT jobid, jobname, command FROM cron.job
      WHERE active = true
        AND command ~* 'find-and-queue|brand-search|brand-enrich|scan-tg|youtube-search|dfs-|generate-queue|process-queue|check-limits|poll-replies|score-leads|validate-emails|recover-contacts'
    LOOP
      UPDATE cron.job SET active = false WHERE jobid = j.jobid;
      RAISE NOTICE 'Остановлено: % (jobid %)', j.jobname, j.jobid;
      n := n + 1;
    END LOOP;

    IF n = 0 THEN
      RAISE NOTICE 'Ни одного подходящего активного задания в cron.job не найдено — либо уже остановлено, либо расписания заведены не через pg_cron.';
    ELSE
      RAISE NOTICE 'Итого остановлено заданий: %', n;
    END IF;
  END IF;
END $$;

-- Пояс и подтяжки: даже если что-то из перечисленного выше дозапустится
-- вручную (кнопкой в интерфейсе) — отправка и доливка очереди всё равно
-- заблокированы этим флагом.
UPDATE public.pipeline_limits SET paused = true;
