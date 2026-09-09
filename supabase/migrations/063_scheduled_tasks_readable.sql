-- 063 — дашборду нужно читать расписание
--
-- Миграция 062 закрыла scheduled_tasks для anon целиком, и это оказалось
-- слишком широким жестом: под anon-ключом ходит не только посторонний, но и
-- сам дашборд. Экран диагностики, ради которого таблица и заводилась, показывал
-- «Планировщик недоступен».
--
-- Здесь anon получает РОВНО SELECT. Запись остаётся закрытой, и это
-- принципиально: диспетчер занимает блокировки, пишет статусы и отключает
-- задачи, а anon-ключ лежит открытым текстом в index.html. Дай ему UPDATE —
-- и любой, кто открыл исходник страницы, остановит систему одним запросом.
--
-- Само расписание секретом не является: имена функций и интервалы не дают
-- ничего сверх того, что уже известно — edge-функции развёрнуты с
-- --no-verify-jwt, то есть вызываются публично и так.
--
-- Отдельно: сам диспетчер под anon больше не ходит. Он переехал в
-- edge-функцию dispatch-tasks с ключом service_role — та версия, что жила в
-- воркере, падала на первом же запросе именно из-за отзыва прав в 062 и
-- простояла 41 час, выглядя при этом живой.

GRANT SELECT ON public.scheduled_tasks TO anon;

DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n FROM information_schema.role_table_grants
   WHERE table_schema = 'public' AND table_name = 'scheduled_tasks'
     AND grantee = 'anon' AND privilege_type = 'SELECT';
  IF n <> 1 THEN RAISE EXCEPTION 'anon не получил SELECT на scheduled_tasks'; END IF;

  -- Обратная проверка, и она здесь важнее прямой: право на запись у anon —
  -- это выключатель всей системы, доступный любому.
  SELECT count(*) INTO n FROM information_schema.role_table_grants
   WHERE table_schema = 'public' AND table_name = 'scheduled_tasks'
     AND grantee = 'anon' AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE');
  IF n > 0 THEN
    RAISE EXCEPTION 'у anon есть права на запись в scheduled_tasks — это выключатель системы';
  END IF;

  RAISE NOTICE 'anon: только чтение расписания';
END $$;
