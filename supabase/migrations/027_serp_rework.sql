-- ═══════════════════════════════════════════════════════════════════════════
-- AffiliateOS v7.1 — переделка метода добычи DataForSEO
--
-- ПОЧЕМУ
-- v7 добывала лиды из профиля обратных ссылок букмекеров. Практика: прогон на
-- $1 (~16 000 строк) дал ноль пригодных лидов. У bet9ja.com 18 115 ссылающихся
-- доменов, живых аффилиатов среди них 3-5%; остальное — сокращатели, скраперы,
-- каталоги, разовые упоминания. Наш собственный прогон это подтвердил в цифрах:
-- 30 доменов из пересечения дошли до квалификатора, все 30 отклонены с
-- причиной no_audience.
--
-- Две ошибки метода. Первая: фильтровали по домену и rank, а признак аффилиата
-- сидит в тексте анкора. Вторая, главная: ссылка — косвенный признак («он
-- когда-то поставил ссылку»). Есть прямой: кто ПРЯМО СЕЙЧАС в топе выдачи по
-- коммерческим запросам.
--
-- Логика переворачивается: не «возьмём все ссылки бука и отфильтруем», а «вот
-- 200 коммерческих запросов — покажи, кто владеет этой выдачей». Мусор по
-- коммерческим запросам не ранжируется в принципе, и отсев делает Google, а не
-- мы.
--
-- Схема, вкладка и отдельная очередь отправки из v7 остаются как есть.
-- Идемпотентно: можно перезапускать.
-- ═══════════════════════════════════════════════════════════════════════════


-- ── Метрики владения выдачей (шаг 1: serp_competitors) ─────────────────────
ALTER TABLE public.dfs_domains ADD COLUMN IF NOT EXISTS keyword_cluster  TEXT;
ALTER TABLE public.dfs_domains ADD COLUMN IF NOT EXISTS etv              NUMERIC(12,2);
ALTER TABLE public.dfs_domains ADD COLUMN IF NOT EXISTS median_position  NUMERIC(5,1);
ALTER TABLE public.dfs_domains ADD COLUMN IF NOT EXISTS visibility       NUMERIC(6,4);
ALTER TABLE public.dfs_domains ADD COLUMN IF NOT EXISTS relevance        NUMERIC(4,3);
ALTER TABLE public.dfs_domains ADD COLUMN IF NOT EXISTS keywords_matched INT;

-- ── Метрики квалификации (шаг 2: ranked_keywords) ──────────────────────────
-- Живут на dfs_domains, а не только на leads: это ФИЛЬТР перед квалификатором,
-- а не украшение готового лида. Домен без частотности не должен доходить до
-- платного LLM-вызова.
ALTER TABLE public.dfs_domains ADD COLUMN IF NOT EXISTS commercial_keywords INT;
ALTER TABLE public.dfs_domains ADD COLUMN IF NOT EXISTS total_search_volume BIGINT;
ALTER TABLE public.dfs_domains ADD COLUMN IF NOT EXISTS top3_keywords       INT;
-- Отметка «этот домен уже прогоняли через ranked_keywords». Отдельно от самих
-- чисел: домен может честно вернуть ноль коммерческих ключей, и это результат,
-- а не повод платить за него ещё раз на следующем тике.
ALTER TABLE public.dfs_domains ADD COLUMN IF NOT EXISTS rank_checked_at TIMESTAMPTZ;
-- То же для шага 3: у семени может не оказаться похожих доменов, и это ответ,
-- а не повод покупать его заново на каждом прогоне.
ALTER TABLE public.dfs_domains ADD COLUMN IF NOT EXISTS similar_pulled_at TIMESTAMPTZ;

-- ── Квалификация на лиде ───────────────────────────────────────────────────
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS total_search_volume BIGINT;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS top3_keywords       INT;
-- Суффикс UA-ID: UA-12345678-23 значит, что у владельца минимум 23 ресурса в
-- аккаунте. Прямой индикатор размера портфеля, и его не надо ниоткуда выводить.
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS ua_portfolio_hint   INT;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS dfs_etv             NUMERIC(12,2);
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS dfs_median_position NUMERIC(5,1);
-- Каким методом домен найден. Скоринг это взвешивает: владение выдачей — это
-- другой класс доказательства, чем поставленная когда-то ссылка, и лид должен
-- нести это на себе, а не выясняться джойном на каждой отрисовке списка.
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS dfs_source          TEXT;

ALTER TABLE public.owner_clusters ADD COLUMN IF NOT EXISTS total_search_volume BIGINT;

-- Курсор по паттернам анкоров: backlinks теперь гоняются не одним запросом на
-- конкурента, а по одному на паттерн («%promo code%», «%bonus code%», …).
-- Без курсора повторный прогон покупал бы первый паттерн заново — ровно тот же
-- баг, что уже был у пересечений с offset:0.
ALTER TABLE public.dfs_competitors ADD COLUMN IF NOT EXISTS anchor_cursor INT DEFAULT 0;

-- Приоритет очереди: домены из serp_competitors выше backlinks-находок.
-- etv DESC ставит вперёд тех, кто реально собирает трафик с коммерческой
-- выдачи; intersect_count остаётся вторым ключом для старых backlinks-строк,
-- у которых etv нет вовсе.
CREATE INDEX IF NOT EXISTS dfs_domains_prio
  ON public.dfs_domains (status, etv DESC NULLS LAST, intersect_count DESC);


-- ── Кластеры коммерческих ключей ───────────────────────────────────────────
-- Отдельная таблица, а не константа в коде: список ключей — это то, что правят
-- по результатам, и правка не должна требовать деплоя функции.
--
-- Принцип отбора ключа: если за позицию по этому запросу в SEO платят деньги —
-- ключ наш. «Как вывести выигрыш» и «правила ставок» — мимо, там хобби-блоги.
CREATE TABLE IF NOT EXISTS public.dfs_keyword_clusters (
  id              BIGSERIAL PRIMARY KEY,
  geo             TEXT UNIQUE NOT NULL,
  location_code   INT  NOT NULL,
  language_code   TEXT NOT NULL DEFAULT 'en',
  keywords        TEXT[] NOT NULL,
  priority        INT DEFAULT 5,          -- 1 = гнать первым
  active          BOOLEAN DEFAULT TRUE,
  last_run_at     TIMESTAMPTZ,
  domains_found   INT DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.dfs_keyword_clusters DISABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dfs_keyword_clusters TO anon, authenticated, service_role;
GRANT USAGE, SELECT ON SEQUENCE public.dfs_keyword_clusters_id_seq TO anon, authenticated, service_role;

COMMENT ON TABLE public.dfs_keyword_clusters IS
  'Кластеры коммерческих запросов для serp_competitors — основного входа '
  'добычи. Один кластер = один запрос к API = «кто владеет этой выдачей». '
  'location_code сверять с /v3/dataforseo_labs/locations_and_languages: коды '
  'меняются, а неверный код возвращает пустой результат без ошибки.';

-- Приоритеты: Нигерия первой — самый крупный рынок и на нём проверяем метод.
-- Франкофонная Африка выше англоязычной мелочи: лучше конвертит на RevShare.
INSERT INTO public.dfs_keyword_clusters (geo, location_code, language_code, priority, keywords)
VALUES
  ('NG', 2566, 'en', 1, ARRAY[
    'best betting sites nigeria','top bookmakers nigeria','bet9ja review',
    'betking review','sportybet nigeria review','nairabet review',
    'bet9ja promo code','betking bonus code','sportybet promo code nigeria',
    'best odds betting site nigeria','new betting sites nigeria',
    'betting sites comparison nigeria','highest odds bookmaker nigeria',
    'best betting app nigeria']),

  ('KE', 2404, 'en', 2, ARRAY[
    'best betting sites kenya','top bookmakers kenya','betika review',
    'sportpesa review','odibets review','mozzartbet kenya review',
    'betika bonus code','odibets promo code','sportpesa promo code',
    'best odds betting kenya','new betting sites kenya',
    'betting sites comparison kenya','best betting app kenya']),

  ('GH', 2288, 'en', 2, ARRAY[
    'best betting sites ghana','top bookmakers ghana','betway ghana review',
    'sportybet ghana review','soccabet review','betpawa ghana review',
    'betway ghana bonus code','betpawa promo code ghana',
    'best odds betting ghana','new betting sites ghana',
    'betting sites comparison ghana']),

  ('CM', 2120, 'fr', 2, ARRAY[
    'meilleurs sites de paris sportifs cameroun','meilleur bookmaker cameroun',
    'premier bet cameroun avis','1win cameroun avis','betclic cameroun avis',
    'code promo premier bet cameroun','code promo 1win cameroun',
    'comparatif sites paris sportifs cameroun',
    'meilleures cotes paris sportifs cameroun']),

  ('SN', 2686, 'fr', 3, ARRAY[
    'meilleurs sites de paris sportifs senegal','meilleur bookmaker senegal',
    'sunubet avis','premier bet senegal avis','1win senegal avis',
    'code promo premier bet senegal','comparatif bookmakers senegal',
    'meilleures cotes paris senegal']),

  ('CI', 2384, 'fr', 3, ARRAY[
    'meilleurs sites de paris sportifs cote d ivoire','meilleur bookmaker abidjan',
    'premier bet cote d ivoire avis','1win cote d ivoire avis',
    'code promo paris sportifs cote d ivoire','comparatif sites paris sportifs civ']),

  ('TZ', 2834, 'en', 4, ARRAY[
    'best betting sites tanzania','top bookmakers tanzania',
    'betway tanzania review','meridianbet tanzania review',
    'premier bet tanzania review','betpawa tanzania bonus',
    'best odds betting tanzania','betting sites comparison tanzania']),

  ('UG', 2800, 'en', 4, ARRAY[
    'best betting sites uganda','top bookmakers uganda','fortebet review',
    'betway uganda review','gal sport betting review',
    'betpawa uganda bonus code','best odds betting uganda',
    'new betting sites uganda']),

  ('CD', 2180, 'fr', 4, ARRAY[
    'meilleurs sites de paris sportifs rdc','meilleur bookmaker kinshasa',
    'premier bet rdc avis','1win rdc avis','betway congo avis',
    'comparatif paris sportifs rdc']),

  ('ZM', 2894, 'en', 5, ARRAY[
    'best betting sites zambia','top bookmakers zambia','betway zambia review',
    'premier bet zambia review','betpawa zambia bonus code',
    'best odds betting zambia']),

  ('ET', 2231, 'en', 5, ARRAY[
    'best betting sites ethiopia','top bookmakers ethiopia','hulusport review',
    'abyssinia bet review','betting sites comparison ethiopia',
    'best odds betting ethiopia']),

  ('MZ', 2508, 'pt', 5, ARRAY[
    'melhores casas de apostas mocambique','melhor casa de apostas mocambique',
    'premier bet mocambique analise','betpawa mocambique analise',
    'codigo promocional apostas mocambique',
    'comparacao casas de apostas mocambique']),

  ('ML', 2466, 'fr', 6, ARRAY[
    'meilleurs sites de paris sportifs mali','meilleur bookmaker bamako',
    'premier bet mali avis']),

  ('BF', 2854, 'fr', 6, ARRAY[
    'meilleurs sites de paris sportifs burkina faso','premier bet burkina avis',
    'code promo paris sportifs burkina']),

  ('AFRICA', 2566, 'en', 7, ARRAY[
    'best betting sites africa','african bookmaker comparison',
    'best betting apps africa','meilleurs bookmakers afrique',
    'comparatif paris sportifs afrique'])
ON CONFLICT (geo) DO UPDATE
  SET location_code = EXCLUDED.location_code,
      language_code = EXCLUDED.language_code,
      keywords      = EXCLUDED.keywords,
      priority      = EXCLUDED.priority;


-- ── Апсерт доменов из Labs-эндпоинтов ──────────────────────────────────────
-- Отдельная функция от dfs_upsert_domains: у serp-строки нет конкурента и нет
-- intersect_count, зато есть etv/relevance/median_position. Пихать обе формы в
-- один recordset — значит получить функцию, половина аргументов которой всегда
-- NULL, и потерять возможность понять, какая ветка что записала.
--
-- Домен, уже найденный через backlinks, не создаётся заново, а ОБОГАЩАЕТСЯ
-- метриками выдачи и повышается в источнике: владение выдачей — сильнее
-- сигнал, чем ссылка, и очередь должна это учитывать.
CREATE OR REPLACE FUNCTION public.dfs_upsert_serp_domains(p_rows JSONB)
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE
  affected INTEGER;
BEGIN
  WITH incoming AS (
    SELECT * FROM jsonb_to_recordset(p_rows) AS x(
      domain           TEXT,
      source           TEXT,
      keyword_cluster  TEXT,
      etv              NUMERIC,
      median_position  NUMERIC,
      visibility       NUMERIC,
      relevance        NUMERIC,
      keywords_matched INT)
  ),
  agg AS (
    SELECT
      i.domain,
      min(i.source)          AS source,
      min(i.keyword_cluster) AS keyword_cluster,
      max(i.etv)             AS etv,
      min(i.median_position) AS median_position,
      max(i.visibility)      AS visibility,
      max(i.relevance)       AS relevance,
      max(i.keywords_matched) AS keywords_matched
    FROM incoming i
    WHERE i.domain IS NOT NULL AND i.domain <> ''
    GROUP BY i.domain
  )
  INSERT INTO public.dfs_domains AS d (
    domain, source, keyword_cluster, etv, median_position,
    visibility, relevance, keywords_matched, intersect_count)
  SELECT
    a.domain, a.source, a.keyword_cluster, a.etv, a.median_position,
    a.visibility, a.relevance, a.keywords_matched, 0
  FROM agg a
  ON CONFLICT (domain) DO UPDATE SET
    -- Источник повышается, но не понижается: домен, найденный и в выдаче, и в
    -- ссылках, остаётся serp-находкой.
    source           = CASE WHEN d.source IN ('serp_competitors','competitors_domain')
                            THEN d.source ELSE EXCLUDED.source END,
    keyword_cluster  = COALESCE(d.keyword_cluster, EXCLUDED.keyword_cluster),
    etv              = GREATEST(COALESCE(EXCLUDED.etv, 0), COALESCE(d.etv, 0)),
    median_position  = LEAST(COALESCE(EXCLUDED.median_position, 999),
                             COALESCE(d.median_position, 999)),
    visibility       = GREATEST(COALESCE(EXCLUDED.visibility, 0), COALESCE(d.visibility, 0)),
    relevance        = GREATEST(COALESCE(EXCLUDED.relevance, 0), COALESCE(d.relevance, 0)),
    keywords_matched = GREATEST(COALESCE(EXCLUDED.keywords_matched, 0),
                                COALESCE(d.keywords_matched, 0)),
    -- Домен, ранее отклонённый как backlinks-мусор, возвращается в очередь,
    -- если оказался владельцем коммерческой выдачи: это другой класс
    -- доказательства, и старый вердикт по нему больше не действует.
    status           = CASE WHEN d.status = 'rejected'
                             AND d.reject_reason IN ('no_audience','low_score','irrelevant')
                            THEN 'raw' ELSE d.status END,
    reject_reason    = CASE WHEN d.status = 'rejected'
                             AND d.reject_reason IN ('no_audience','low_score','irrelevant')
                            THEN NULL ELSE d.reject_reason END;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;

GRANT EXECUTE ON FUNCTION public.dfs_upsert_serp_domains(JSONB) TO anon, authenticated, service_role;


COMMENT ON COLUMN public.dfs_domains.etv IS
  'Оценка трафика с ключей кластера. Главная сортировка очереди: позиция без '
  'частотности ничего не стоит — это либо нулевые ключи, либо позиции 15-50, '
  'либо PBN-нода, которая трафик получать и не должна.';

COMMENT ON COLUMN public.dfs_domains.relevance IS
  '0-1, совпадение профиля домена с кластером. Фильтр > 0.5 обязателен: он '
  'отсекает Википедию и новостных генералистов, которые попадают в выдачу по '
  'одному запросу из двухсот.';

COMMENT ON COLUMN public.dfs_domains.total_search_volume IS
  'Суммарная частотность коммерческих ключей домена в топ-10. Главная метрика '
  'ценности лида: сайт с 3000 визитов по «best betting site nigeria» ценнее '
  'сайта с 300000 визитов по «live football scores».';
