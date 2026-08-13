-- ═══════════════════════════════════════════════════════════════════════════
-- Автозапуск бренд-пайплайна
--
-- ЗАЧЕМ
-- Модуль v8 приехал с кнопкой «Прогнать поиск» и без расписания — то есть
-- работал ровно тогда, когда кто-то про него вспомнит. Это не пайплайн, это
-- ручной инструмент. Здесь он ставится на крон наравне с двумя остальными.
--
-- ПОЧЕМУ ФОРМАТ ВЫЗОВА НЕ ЗАХАРДКОЖЕН
-- Существующие кроны (find-and-queue, dfs-qualify, recover-contacts) заведены
-- в базе, а не в этом репозитории, и внутри у них полный URL проекта и ключ
-- авторизации. Прописать их здесь заново значило бы:
--   а) положить ключ в git;
--   б) угадывать формат — а если он не совпадёт, крон будет молча падать,
--      и узнаем мы об этом по отсутствию лидов через неделю.
-- Поэтому команда берётся из УЖЕ РАБОТАЮЩЕГО задания и в ней подменяется имя
-- функции. Что бы там ни стояло — net.http_post, pg_net с заголовками, иная
-- схема — новые задания получат ровно тот же вызов, который уже проверен
-- временем на этом проекте.
--
-- Если ни одного подходящего задания не нашлось (pg_cron не используется или
-- расписания заведены иначе), миграция НИЧЕГО не делает и пишет NOTICE.
-- Молча создать сломанный крон здесь хуже, чем не создать никакого.
--
-- Идемпотентно: существующие задания с теми же именами пересоздаются.
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  tmpl        TEXT;
  src_job     TEXT;
  new_cmd     TEXT;
  j           RECORD;
  -- Функция → расписание.
  --   brand-search   каждые 3 мин, но внутри стоит собственный гейт: работает
  --                  один тик из трёх, и НЕ тот, на котором работает
  --                  find-and-queue. Общий egress-IP не должен получать два
  --                  обращения к DuckDuckGo в одну минуту.
  --   brand-enrich   каждые 5 мин: сетевые загрузки страниц, к поисковику не
  --                  ходит, делить с кем-либо нечего.
  --   generate-queue-brand — каждые 10 мин, как у соседнего пайплайна. Внутри
  --                  всё равно стоит пауза (шаблона письма ещё нет), так что
  --                  задание будет отрабатывать вхолостую и это правильно:
  --                  когда шаблон появится, достаточно снять паузу в
  --                  интерфейсе, а не вспоминать, что надо ещё и крон завести.
  jobs        TEXT[][] := ARRAY[
    ARRAY['brand-search',         '*/3 * * * *'],
    ARRAY['brand-enrich',         '*/5 * * * *'],
    ARRAY['generate-queue-brand', '*/10 * * * *']
  ];
  i INT;
BEGIN
  -- pg_cron может быть не установлен — тогда просто выходим.
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron не установлен — расписание бренд-пайплайна не заведено. Завести вручную.';
    RETURN;
  END IF;

  -- Берём образец у функции, которая заведомо вызывается по расписанию.
  -- Порядок предпочтения — от самой похожей задачи к любой подходящей.
  FOR j IN
    SELECT jobname, command FROM cron.job
     WHERE command LIKE '%dfs-qualify%'
        OR command LIKE '%find-and-queue%'
        OR command LIKE '%recover-contacts%'
        OR command LIKE '%dfs-enrich%'
        OR command LIKE '%generate-queue%'
     ORDER BY CASE
       WHEN command LIKE '%dfs-qualify%'    THEN 1
       WHEN command LIKE '%dfs-enrich%'     THEN 2
       WHEN command LIKE '%recover-contacts%' THEN 3
       WHEN command LIKE '%generate-queue%' THEN 4
       ELSE 5 END
     LIMIT 1
  LOOP
    tmpl := j.command;
    -- Какое именно имя функции стоит в образце — его и будем подменять.
    src_job := CASE
      WHEN j.command LIKE '%dfs-qualify%'      THEN 'dfs-qualify'
      WHEN j.command LIKE '%dfs-enrich%'       THEN 'dfs-enrich'
      WHEN j.command LIKE '%recover-contacts%' THEN 'recover-contacts'
      WHEN j.command LIKE '%generate-queue-dfs%' THEN 'generate-queue-dfs'
      WHEN j.command LIKE '%generate-queue%'   THEN 'generate-queue'
      ELSE 'find-and-queue' END;
  END LOOP;

  IF tmpl IS NULL THEN
    RAISE NOTICE 'В cron.job не нашлось задания-образца — расписание бренд-пайплайна не заведено. Завести вручную.';
    RETURN;
  END IF;

  RAISE NOTICE 'Образец вызова взят у задания для %', src_job;

  FOR i IN 1 .. array_length(jobs, 1) LOOP
    -- Пересоздаём: миграция должна быть перезапускаемой, а cron.schedule на
    -- существующее имя в части версий обновляет, а в части — дублирует.
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = jobs[i][1]) THEN
      PERFORM cron.unschedule(jobs[i][1]);
    END IF;

    new_cmd := replace(tmpl, src_job, jobs[i][1]);

    -- Страховка от тихой поломки: если подмена не сработала (в образце не
    -- оказалось ожидаемой подстроки), имя новой функции в команде не появится,
    -- и мы бы завели крон, дёргающий чужую функцию по расписанию новой.
    IF position(jobs[i][1] IN new_cmd) = 0 THEN
      RAISE NOTICE 'Не удалось подставить % в образец — задание пропущено', jobs[i][1];
      CONTINUE;
    END IF;

    PERFORM cron.schedule(jobs[i][1], jobs[i][2], new_cmd);
    RAISE NOTICE 'Заведено расписание % (%)', jobs[i][1], jobs[i][2];
  END LOOP;

EXCEPTION WHEN OTHERS THEN
  -- Схема модуля (миграция 029) уже применена и работоспособна; отсутствие
  -- расписания — деградация, а не поломка, и валить из-за неё весь деплой
  -- нельзя. Молчаливой эта ветка не будет: секция 1b в dfs-healthcheck.yml
  -- печатает содержимое cron.job, и пустой список там виден сразу.
  RAISE NOTICE 'Не удалось завести расписание бренд-пайплайна: %. Проверить cron.job вручную.', SQLERRM;
END $$;


COMMENT ON TABLE public.brand_keywords IS
  'Пул брендовых ключей. Обход строго по last_run_at NULLS FIRST — сначала те, '
  'что не запускались ни разу, поэтому пул проходится целиком до первого '
  'повтора. Расписание: brand-search каждые 3 минуты с внутренним гейтом на '
  'один тик из трёх, смещённым относительно find-and-queue, потому что обе '
  'функции ходят в DuckDuckGo с одного egress-IP.';
