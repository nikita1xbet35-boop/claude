-- 034 — Блок A: телеметрия воронки
--
-- Сейчас видно вход («запущен поиск») и выход («отправлено 50 писем»), а между
-- ними чёрный ящик. Из-за этого причина падения объёма называется гипотезой, а
-- не фактом: исчерпание выдачи, мягкий бан поисковика, троттлинг LLM, нехватка
-- таймбюджета и провал извлечения контактов дают СНАРУЖИ один и тот же симптом.
--
-- Каждый прогон любого пайплайна пишет сюда строку. Даже упавший — с тем, что
-- успело посчитаться. Отсутствие строки само по себе диагноз: пайплайн не
-- запускался.

CREATE TABLE IF NOT EXISTS public.funnel_stats (
  id                BIGSERIAL PRIMARY KEY,
  run_id            UUID NOT NULL,
  pipeline          TEXT NOT NULL,          -- search | dataforseo | brand | telegram | youtube
  started_at        TIMESTAMPTZ DEFAULT NOW(),
  finished_at       TIMESTAMPTZ,
  duration_ms       INT,

  -- ── Этапы воронки ────────────────────────────────────────────────────────
  keywords_used     INT DEFAULT 0,
  urls_returned     INT DEFAULT 0,          -- сырьё от поисковика
  urls_after_noise  INT DEFAULT 0,          -- пережившие шумовые фильтры
  urls_after_dedup  INT DEFAULT 0,          -- КЛЮЧЕВАЯ: сколько реально новых
  sent_to_llm       INT DEFAULT 0,
  llm_ok            INT DEFAULT 0,
  llm_failed        INT DEFAULT 0,
  passed_criteria   INT DEFAULT 0,
  contacts_tried    INT DEFAULT 0,
  contacts_found    INT DEFAULT 0,          -- КЛЮЧЕВАЯ: тут ломается чаще всего
  leads_created     INT DEFAULT 0,
  queued_for_send   INT DEFAULT 0,

  -- ── Диагностика ──────────────────────────────────────────────────────────
  search_errors     INT DEFAULT 0,
  llm_429           INT DEFAULT 0,
  llm_other_errors  INT DEFAULT 0,
  fetch_timeouts    INT DEFAULT 0,
  budget_exhausted  BOOLEAN DEFAULT FALSE,
  notes             TEXT
);

CREATE INDEX IF NOT EXISTS funnel_stats_recent
  ON public.funnel_stats (pipeline, started_at DESC);

ALTER TABLE public.funnel_stats DISABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.funnel_stats TO anon, authenticated, service_role;
GRANT USAGE, SELECT ON SEQUENCE public.funnel_stats_id_seq TO anon, authenticated, service_role;


-- ── Блок C.1: учёт выгорания ключей ─────────────────────────────────────────
-- keywords уже считает runs / urls_found / leads_created, но НЕ считает главного:
-- сколько найденных URL оказались новыми. Без этого «ключ отработал 30 раз и дал
-- 400 URL» не отличается от «ключ отработал 30 раз и все 400 URL уже были в базе»,
-- а это ровно разница между рабочим ключом и выгоревшим.
ALTER TABLE public.keywords ADD COLUMN IF NOT EXISTS new_urls INT DEFAULT 0;

-- geo хранился только внутри preset-строки. Отдельная колонка нужна, чтобы
-- добавление ГЕО стало операцией с данными, а не правкой кода (блок C.2).
ALTER TABLE public.keywords ADD COLUMN IF NOT EXISTS geo TEXT;

-- Ротация по last_run_at NULLS FIRST — равномерный обход всего пула вместо
-- циклического повтора одних и тех же ключей. Частичный индекс по active,
-- потому что архивные строки в ротации не участвуют никогда.
CREATE INDEX IF NOT EXISTS keywords_rotation
  ON public.keywords (preset, last_run_at NULLS FIRST) WHERE active = TRUE;


-- ── Свод воронки за сутки ───────────────────────────────────────────────────
-- Проценты перехода между этапами считаются здесь, а не в UI: те же числа нужны
-- алертам, и два независимых вычисления рано или поздно разойдутся.
CREATE OR REPLACE VIEW public.funnel_24h AS
SELECT
  pipeline,
  count(*)                                        AS runs,
  count(*) FILTER (WHERE budget_exhausted)        AS runs_out_of_budget,
  sum(keywords_used)                              AS keywords_used,
  sum(urls_returned)                              AS urls_returned,
  sum(urls_after_noise)                           AS urls_after_noise,
  sum(urls_after_dedup)                           AS urls_after_dedup,
  sum(sent_to_llm)                                AS sent_to_llm,
  sum(llm_ok)                                     AS llm_ok,
  sum(llm_failed)                                 AS llm_failed,
  sum(llm_429)                                    AS llm_429,
  sum(passed_criteria)                            AS passed_criteria,
  sum(contacts_tried)                             AS contacts_tried,
  sum(contacts_found)                             AS contacts_found,
  sum(leads_created)                              AS leads_created,
  -- Доля новых URL. Ниже 5% — выдача исчерпана, нужны новые ключи и ГЕО.
  ROUND(100.0 * NULLIF(sum(urls_after_dedup), 0)
        / NULLIF(sum(urls_after_noise), 0), 1)    AS pct_new_urls,
  -- Доля добытых контактов. Ниже 20% — ломается извлечение, а не поиск.
  ROUND(100.0 * NULLIF(sum(contacts_found), 0)
        / NULLIF(sum(passed_criteria), 0), 1)     AS pct_contacts,
  -- Среднее число результатов на запрос. Ниже 5 — мягкий бан поисковика.
  ROUND(1.0 * NULLIF(sum(urls_returned), 0)
        / NULLIF(sum(keywords_used), 0), 1)       AS avg_urls_per_keyword,
  max(started_at)                                 AS last_run_at
FROM public.funnel_stats
WHERE started_at > now() - interval '24 hours'
GROUP BY pipeline;

GRANT SELECT ON public.funnel_24h TO anon, authenticated, service_role;
