-- 036 — Блок 1: бэкфилл под мультибренд
--
-- Отдельная миграция от 035 намеренно: между "добавить nullable колонку" и
-- "включить NOT NULL" по ТЗ обязана быть проверка (п.6 порядка работ) — если
-- проверка когда-нибудь не пройдёт на бою, откатывать нужно только эту
-- миграцию, не трогая уже созданные таблицы и функции.
--
-- Вся существующая база (~8000+ leads, ~4678 с контактом) на сегодня — 1xBet.
-- Ничего не помечено под другой бренд, потому что второго бренда ещё не было.

DO $$
DECLARE
  v_1xbet_id UUID;
BEGIN
  SELECT id INTO v_1xbet_id FROM public.brands WHERE slug = '1xbet';
  IF v_1xbet_id IS NULL THEN
    RAISE EXCEPTION 'brands.1xbet not found — run 035 first';
  END IF;

  UPDATE public.leads        SET brand_id = v_1xbet_id WHERE brand_id IS NULL;
  UPDATE public.send_queue   SET brand_id = v_1xbet_id WHERE brand_id IS NULL;
  UPDATE public.email_log    SET brand_id = v_1xbet_id WHERE brand_id IS NULL;
  UPDATE public.api_usage    SET brand_id = v_1xbet_id WHERE brand_id IS NULL;
  UPDATE public.error_log    SET brand_id = v_1xbet_id WHERE brand_id IS NULL;
  UPDATE public.funnel_stats SET brand_id = v_1xbet_id WHERE brand_id IS NULL;
  UPDATE public.dfs_domains  SET brand_id = v_1xbet_id WHERE brand_id IS NULL;

  -- ── Наполнение contact_registry из leads с валидным email (п. 4.1-4.2) ────
  -- Email → sha256(email). Без email, но с доменом → sha256(domain), чтобы
  -- когда контакт для этого домена найдётся позже, upsert на конфликт по
  -- contact_hash не задвоил запись, а обновил существующую.
  INSERT INTO public.contact_registry
    (contact_hash, domain, first_seen_brand_id, current_owner_brand_id, owned_until, status)
  SELECT
    public.fn_contact_hash(l.contact_email, l.url) AS contact_hash,
    regexp_replace(lower(coalesce(l.url, '')), '^https?://(www\.)?([^/]+).*$', '\2') AS domain,
    v_1xbet_id,
    v_1xbet_id,
    -- last_email_sent_at недоступен как отдельная колонка везде — берём самое
    -- позднее из email_log для этого лида, иначе created_at, как в ТЗ (4.1).
    COALESCE(
      (SELECT max(el.sent_at) FROM public.email_log el WHERE el.lead_id = l.id),
      l.created_at
    ) + interval '3 days' AS owned_until,
    'active'
  FROM public.leads l
  WHERE l.contact_email IS NOT NULL AND trim(l.contact_email) <> ''
  ON CONFLICT (contact_hash) DO NOTHING;

  RAISE NOTICE 'Backfill done. leads without brand_id: %',
    (SELECT count(*) FROM public.leads WHERE brand_id IS NULL);
END $$;

-- п.6 ТЗ (проверка count(*) WHERE brand_id IS NULL = 0) и п.7 (NOT NULL)
-- НАМЕРЕННО не в этой миграции — см. 037_multibrand_not_null.sql. Ни одна
-- edge-функция ещё не проставляет brand_id при вставке (это код Блока 2), а
-- error_log/api_usage/funnel_stats пишутся каждый прогон крона. Включить
-- NOT NULL здесь — значит уронить каждую вставку в проде в течение 15 минут
-- после деплоя этой миграции, тем же способом, что убивал find-and-queue на
-- отсутствующий quiet(). NOT NULL накатывается отдельным шагом ПОСЛЕ того как
-- код начнёт писать brand_id на каждую вставку.
