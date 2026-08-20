-- 037 — Блок 1, финальный шаг: brand_id NOT NULL
--
-- ⚠️ НЕ деплоить вместе с 035/036. Применять вручную, и только после того как
-- все edge-функции, пишущие в эти семь таблиц (find-and-queue, brand-search,
-- dfs-качественная цепочка, generate-queue*, poll-replies, check-limits и
-- т.д.), обновлены проставлять brand_id на каждой вставке — это код Блока 2.
--
-- Применённая раньше времени, эта миграция ломает каждую вставку в проде
-- (error_log/api_usage/funnel_stats пишутся каждые 15 минут крона) тем же
-- способом, что несуществующий quiet() однажды уронил find-and-queue на
-- 3.5 часа — только тут это не пройдёт незаметно, а остановит всё сразу.
--
-- Перед запуском вручную проверить (все семь должны вернуть 0):
--   SELECT count(*) FROM leads        WHERE brand_id IS NULL;
--   SELECT count(*) FROM send_queue   WHERE brand_id IS NULL;
--   SELECT count(*) FROM email_log    WHERE brand_id IS NULL;
--   SELECT count(*) FROM api_usage    WHERE brand_id IS NULL;
--   SELECT count(*) FROM error_log    WHERE brand_id IS NULL;
--   SELECT count(*) FROM funnel_stats WHERE brand_id IS NULL;
--   SELECT count(*) FROM dfs_domains  WHERE brand_id IS NULL;

ALTER TABLE public.leads        ALTER COLUMN brand_id SET NOT NULL;
ALTER TABLE public.send_queue   ALTER COLUMN brand_id SET NOT NULL;
ALTER TABLE public.email_log    ALTER COLUMN brand_id SET NOT NULL;
ALTER TABLE public.api_usage    ALTER COLUMN brand_id SET NOT NULL;
ALTER TABLE public.error_log    ALTER COLUMN brand_id SET NOT NULL;
ALTER TABLE public.funnel_stats ALTER COLUMN brand_id SET NOT NULL;
ALTER TABLE public.dfs_domains  ALTER COLUMN brand_id SET NOT NULL;
