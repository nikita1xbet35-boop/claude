-- 042 — Откат ошибочного авто-применения 037_multibrand_not_null.sql
-- (передеплой #2: прошлый прогон дошёл дальше — 041 применилась, но 042
-- упала на явном 524 от Cloudflare-эджа самого Supabase (подтверждённый
-- сбой на их стороне, не сеть раннера и не наш SQL) — SQL передан пользователю на ручное
-- применение через SQL Editor параллельно с этими ретраями)
--
-- 037 была написана с пометкой "применять только вручную" — но это был
-- ТОЛЬКО комментарий в файле. Деплой (.github/workflows/deploy-supabase.yml)
-- применяет каждый supabase/migrations/*.sql подряд без исключений,
-- комментарии не читает. 037 применилась автоматически вместе со всеми
-- остальными.
--
-- Результат: brand_id стал NOT NULL на leads/send_queue/email_log/
-- api_usage/error_log/funnel_stats/dfs_domains, а почти ни одна
-- edge-функция кроме find-and-queue.ts brand_id не проставляет. Каждая
-- вставка в error_log (буквально любая функция на любом тике крона,
-- включая логирование чужих ошибок) стала падать на нарушении constraint.
-- Это правдоподобно объясняет и деградацию самой базы (каскад падающих
-- вставок, удержанные соединения/локи) — включая то, что простой SELECT
-- из brands с фронтенда начал зависать.
--
-- Возврат к nullable — brand_id остаётся в схеме и продолжает
-- проставляться там, где уже работает (find-and-queue.ts), просто больше
-- не required для вставок откуда угодно.

ALTER TABLE public.leads        ALTER COLUMN brand_id DROP NOT NULL;
ALTER TABLE public.send_queue   ALTER COLUMN brand_id DROP NOT NULL;
ALTER TABLE public.email_log    ALTER COLUMN brand_id DROP NOT NULL;
ALTER TABLE public.api_usage    ALTER COLUMN brand_id DROP NOT NULL;
ALTER TABLE public.error_log    ALTER COLUMN brand_id DROP NOT NULL;
ALTER TABLE public.funnel_stats ALTER COLUMN brand_id DROP NOT NULL;
ALTER TABLE public.dfs_domains  ALTER COLUMN brand_id DROP NOT NULL;
-- retry 1787240343
-- retry 1787240665
