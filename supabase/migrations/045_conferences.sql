-- 045 — Блок 5: конференции как источник лидов
--
-- ── Конфликт с 044, который надо разрешить, а не обойти ─────────────────────
-- 044 включила leads.brand_id NOT NULL. ТЗ Блока 5 (§3.2) требует, чтобы
-- конференционный лид жил БЕЗ бренда до момента захвата: список спикеров
-- SiGMA одинаково интересен 1xBet, 1xCasino и LuckyPari, и назначать владельца
-- в момент харвестинга — значит решать за ротацию.
--
-- Решение не «снять NOT NULL обратно»: тогда исчезает гарантия для всех
-- остальных источников, которую мы только что выстроили. Вместо этого —
-- CHECK, разрешающий пустой бренд РОВНО для pipeline='conference'. Правило
-- становится явным и проверяемым в схеме: у любого лида есть бренд, кроме
-- конференционного, который его ещё не получил.
--
-- Триггер умолчания из 044 (fn_fill_default_brand_id) при этом обязан
-- перестать срабатывать на конференционных строках — иначе он проставит им
-- 1xBet раньше, чем ротация скажет своё слово, и весь смысл общего пула
-- пропадёт. Поэтому он тоже переопределяется ниже.

-- ── 1. Реестр конференций ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.conferences (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT NOT NULL,
  region           TEXT,
  event_date       DATE,
  source_type      TEXT NOT NULL,      -- speaker_list | exhibitor_list | telegram_chat
  source_url       TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL DEFAULT 'pending',   -- pending | harvested | skipped
  harvested_at     TIMESTAMPTZ,
  candidates_found INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Имя — естественный ключ: миграция должна переживать повторный накат, не
-- плодя вторую «MAC Moscow».
CREATE UNIQUE INDEX IF NOT EXISTS conferences_name_uniq ON public.conferences(name);

ALTER TABLE public.conferences DISABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.conferences TO anon, authenticated, service_role;

-- source_url пустой — его заполняет Ник конкретными ссылками. Харвестер
-- пропускает строки с пустым URL, а не выдумывает адрес.
INSERT INTO public.conferences (name, region, source_type, source_url, status) VALUES
  ('MAC Moscow',                              'CIS', 'speaker_list',   '', 'pending'),
  ('MAC Yerevan',                             'CIS', 'speaker_list',   '', 'pending'),
  ('Tbilisi Affiliate Conference (June 2026)','CIS', 'exhibitor_list', '', 'pending'),
  ('Sofia Affiliate Conference (July 2026)',  'EU',  'exhibitor_list', '', 'pending')
ON CONFLICT (name) DO NOTHING;

-- ── 2. Происхождение лида ───────────────────────────────────────────────────
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS conference_id UUID REFERENCES public.conferences(id);
CREATE INDEX IF NOT EXISTS leads_conference ON public.leads(conference_id) WHERE conference_id IS NOT NULL;

-- ── 3. Исключение из NOT NULL — явное, не «забытый nullable-хвост» ──────────
ALTER TABLE public.leads ALTER COLUMN brand_id DROP NOT NULL;

ALTER TABLE public.leads DROP CONSTRAINT IF EXISTS leads_brand_required;
ALTER TABLE public.leads ADD CONSTRAINT leads_brand_required
  CHECK (brand_id IS NOT NULL OR pipeline = 'conference');
-- Обычный ADD CONSTRAINT со сканом: миграция едет одним запросом, то есть
-- одной транзакцией, и приём NOT VALID + отдельный VALIDATE (который берёт
-- более слабую блокировку) здесь всё равно не сработал бы — скан случился бы
-- в той же транзакции. На ~8 тыс. строк это доли секунды.

-- ── 4. Умолчание не должно перебивать ротацию ───────────────────────────────
-- Триггер 044 проставляет бренд по умолчанию любой строке с пустым brand_id.
-- Для конференционного лида это ровно то, чего делать нельзя: он обязан
-- дождаться fn_capture_contact. Исключаем этот случай.
CREATE OR REPLACE FUNCTION public.fn_fill_default_brand_id()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Конференционный лид приходит без бренда СОЗНАТЕЛЬНО (Блок 5 §2): пул
  -- общий, владельца назначает ротация. Умолчание здесь сделало бы его
  -- 1xBet-овым в обход fn_capture_contact.
  IF TG_TABLE_NAME = 'leads' AND NEW.pipeline = 'conference' THEN
    RETURN NEW;
  END IF;

  IF NEW.brand_id IS NULL THEN
    SELECT b.id INTO NEW.brand_id
      FROM public.brands b
     WHERE b.slug = COALESCE(
       (SELECT value #>> '{}' FROM public.system_config WHERE key = 'default_brand_slug'),
       '1xbet');
  END IF;
  RETURN NEW;
END;
$$;
