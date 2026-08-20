-- 035 — Блок 1: слой данных мультибренда
--
-- Сейчас система заточена под один бренд: конфиг (ГЕО, RS, почта, лимиты)
-- размазан по коду и env, а "кто уже писал этому лиду" нигде не считается —
-- запусти второй бренд как есть, и оба начнут слать одному контакту
-- одновременно, без всякой видимой ошибки.
--
-- Решение: рабочие таблицы получают brand_id, конфиг бренда — одна строка в
-- brands, а владение контактом решает не бренд и не код пайплайна, а
-- отдельный реестр (contact_registry) с явными правилами захвата и ротации.
-- Тот же принцип, что и funnel_24h: правило живёт в одном месте, а не
-- пересчитывается параллельно в каждом пайплайне и рано или поздно расходится.

-- ════════════════════════════════════════════════════════════════════════════
-- 1. BRANDS — реестр брендов и их конфиг
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.brands (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            TEXT UNIQUE NOT NULL,
  name            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',        -- active | paused | draft
  visibility      TEXT NOT NULL DEFAULT 'public',         -- public | hidden
  role            TEXT NOT NULL DEFAULT 'affiliate_manager', -- affiliate_manager | sub_partner

  geo_list        JSONB NOT NULL DEFAULT '[]',
  rs_start        NUMERIC NOT NULL DEFAULT 25,
  rs_cap          NUMERIC NOT NULL,
  vertical        TEXT NOT NULL DEFAULT 'standard',        -- standard | casino_slots

  sender_email    TEXT,
  sender_tg       TEXT,
  sender_domain   TEXT,

  cron_weight     NUMERIC NOT NULL DEFAULT 20,             -- % прогонов, сумма активных ~100
  cooldown_days   INTEGER NOT NULL DEFAULT 3,               -- когда лид освобождается для след. бренда
  min_gap_after   JSONB NOT NULL DEFAULT '{}',               -- {"1xbet": 12} — доп. запрет после этих брендов

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.brands
  (slug, name, status, visibility, role, geo_list, rs_start, rs_cap, vertical, sender_email, sender_tg, cron_weight, cooldown_days, min_gap_after)
VALUES
('1xbet', '1xBet', 'active', 'public', 'affiliate_manager',
  '["worldwide_ex_tier1_brazil"]', 25, 40, 'standard',
  'nick.adflow@gmail.com', '@aff_manager_xbet', 50, 3, '{}'),

('1xcasino', '1xCasino', 'active', 'public', 'affiliate_manager',
  '["guinea","niger","ghana","zambia","south_africa","nigeria","kenya","burkina_faso","cameroon","benin","senegal","togo","cote_divoire","colombia","ecuador","bolivia","venezuela","peru","chile","brazil","russia","azerbaijan","egypt","somalia","uzbekistan","turkey","south_korea","kyrgyzstan","algeria","bangladesh","morocco","india","canada","pakistan","sri_lanka","japan","myanmar","philippines","argentina","mauritania","kazakhstan","mongolia","mexico","iran"]',
  25, 55, 'casino_slots',
  'nick.adflow@gmail.com', '@aff_manager_xbet', 25, 3, '{}'),

('luckypari', 'Lucky Pari', 'active', 'public', 'affiliate_manager',
  '["uzbekistan","russia","kazakhstan","kyrgyzstan","bangladesh","sri_lanka","philippines","egypt","morocco","somalia","kenya","zambia","tanzania","nigeria","cameroon","cote_divoire","senegal","benin","congo","burkina_faso","uganda","togo","poland","portugal"]',
  25, 50, 'standard',
  NULL, '@af_luckypari', 25, 12, '{"1xbet": 12, "1xcasino": 12}'),

('melbet', 'Melbet', 'draft', 'hidden', 'sub_partner', '[]', 25, 25, 'standard', NULL, NULL, 0, 3, '{}'),
('coldbet', 'Coldbet', 'draft', 'hidden', 'sub_partner', '[]', 25, 25, 'standard', NULL, NULL, 0, 3, '{}')
ON CONFLICT (slug) DO NOTHING;

ALTER TABLE public.brands DISABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.brands TO anon, authenticated, service_role;

-- ════════════════════════════════════════════════════════════════════════════
-- 2. CONTACT_REGISTRY — кто владеет контактом
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.contact_registry (
  contact_hash            TEXT PRIMARY KEY,      -- sha256(email) либо sha256(domain) без email
  domain                  TEXT,
  first_seen_brand_id     UUID REFERENCES public.brands(id),
  current_owner_brand_id  UUID REFERENCES public.brands(id),
  owned_until             TIMESTAMPTZ,
  next_eligible_brand_id  UUID REFERENCES public.brands(id),
  total_touches           INTEGER NOT NULL DEFAULT 0,
  status                  TEXT NOT NULL DEFAULT 'active',  -- active | cooldown | frozen
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contact_registry_owner       ON public.contact_registry(current_owner_brand_id);
CREATE INDEX IF NOT EXISTS idx_contact_registry_owned_until ON public.contact_registry(owned_until);
CREATE INDEX IF NOT EXISTS idx_contact_registry_domain      ON public.contact_registry(domain);

ALTER TABLE public.contact_registry DISABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.contact_registry TO anon, authenticated, service_role;

-- ════════════════════════════════════════════════════════════════════════════
-- 3. CONTACT_TOUCHES — журнал касаний
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.contact_touches (
  id            BIGSERIAL PRIMARY KEY,
  contact_hash  TEXT NOT NULL REFERENCES public.contact_registry(contact_hash),
  brand_id      UUID NOT NULL REFERENCES public.brands(id),
  pipeline      TEXT NOT NULL,                    -- search | dataforseo | brand | conference
  channel       TEXT NOT NULL DEFAULT 'email',     -- email | telegram
  outcome       TEXT NOT NULL DEFAULT 'sent',      -- sent | bounced | replied | opened
  touched_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contact_touches_hash ON public.contact_touches(contact_hash);

ALTER TABLE public.contact_touches DISABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.contact_touches TO anon, authenticated, service_role;
GRANT USAGE, SELECT ON SEQUENCE public.contact_touches_id_seq TO anon, authenticated, service_role;

-- ════════════════════════════════════════════════════════════════════════════
-- 4. API_KEYS — общий пул Groq/SerpApi с ротацией и детектом бана
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.api_keys (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider       TEXT NOT NULL,                    -- groq | serpapi
  brand_id       UUID REFERENCES public.brands(id), -- NULL = общий пул, доступен всем брендам
  key_secret_ref TEXT NOT NULL,                     -- ссылка на секрет, не сырой ключ
  status         TEXT NOT NULL DEFAULT 'active',    -- active | banned | paused
  daily_limit    INTEGER,
  daily_used     INTEGER NOT NULL DEFAULT 0,
  last_used_at   TIMESTAMPTZ,
  banned_at      TIMESTAMPTZ,
  ban_reason     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_api_keys_provider_status ON public.api_keys(provider, status);

ALTER TABLE public.api_keys DISABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.api_keys TO anon, authenticated, service_role;

-- ════════════════════════════════════════════════════════════════════════════
-- 5. SYSTEM_CONFIG — глобальные константы
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.system_config (
  key    TEXT PRIMARY KEY,
  value  JSONB NOT NULL
);

INSERT INTO public.system_config (key, value) VALUES
  ('max_touches_per_contact', '5'),
  ('rotation_order', '["1xbet","1xcasino","melbet","coldbet","luckypari"]')
ON CONFLICT (key) DO NOTHING;

ALTER TABLE public.system_config DISABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.system_config TO anon, authenticated, service_role;

-- ════════════════════════════════════════════════════════════════════════════
-- 6. brand_id на существующих таблицах — NULLABLE до бэкфилла (см. 036)
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE public.leads        ADD COLUMN IF NOT EXISTS brand_id UUID REFERENCES public.brands(id);
ALTER TABLE public.send_queue   ADD COLUMN IF NOT EXISTS brand_id UUID REFERENCES public.brands(id);
ALTER TABLE public.email_log    ADD COLUMN IF NOT EXISTS brand_id UUID REFERENCES public.brands(id);
ALTER TABLE public.api_usage    ADD COLUMN IF NOT EXISTS brand_id UUID REFERENCES public.brands(id);
ALTER TABLE public.error_log    ADD COLUMN IF NOT EXISTS brand_id UUID REFERENCES public.brands(id);
ALTER TABLE public.funnel_stats ADD COLUMN IF NOT EXISTS brand_id UUID REFERENCES public.brands(id);
ALTER TABLE public.dfs_domains  ADD COLUMN IF NOT EXISTS brand_id UUID REFERENCES public.brands(id);

CREATE INDEX IF NOT EXISTS idx_leads_brand      ON public.leads(brand_id);
CREATE INDEX IF NOT EXISTS idx_send_queue_brand ON public.send_queue(brand_id);

-- ════════════════════════════════════════════════════════════════════════════
-- 7. Функции — правило живёт в одном месте (см. funnel_24h выше по той же логике)
-- ════════════════════════════════════════════════════════════════════════════

-- sha256(lower(trim(email))) для нормализованного email, иначе sha256(domain).
-- Домен приводится к нижнему регистру и без www — так же, как во всех
-- пайплайнах сравнивается existingDomains.
CREATE OR REPLACE FUNCTION public.fn_contact_hash(p_email TEXT, p_domain TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(digest(
    CASE WHEN p_email IS NOT NULL AND trim(p_email) <> ''
      THEN lower(trim(p_email))
      ELSE regexp_replace(lower(trim(coalesce(p_domain, ''))), '^www\.', '')
    END, 'sha256'), 'hex');
$$;

-- Захват контакта под бренд (п. 4.4 ТЗ). SECURITY DEFINER + один UPDATE/INSERT
-- под общей блокировкой строки — нужен, чтобы два пайплайна не могли захватить
-- один и тот же контакт в одну и ту же миллисекунду мимо друг друга.
-- Возвращает allowed=false с reason, когда слать нельзя.
CREATE OR REPLACE FUNCTION public.fn_capture_contact(
  p_contact_hash TEXT,
  p_domain       TEXT,
  p_brand_id     UUID,
  p_cooldown_days INTEGER
) RETURNS TABLE(allowed BOOLEAN, reason TEXT)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_row public.contact_registry%ROWTYPE;
  v_max_touches INTEGER;
BEGIN
  SELECT (value #>> '{}')::INTEGER INTO v_max_touches
    FROM public.system_config WHERE key = 'max_touches_per_contact';
  v_max_touches := COALESCE(v_max_touches, 5);

  SELECT * INTO v_row FROM public.contact_registry
    WHERE contact_hash = p_contact_hash FOR UPDATE;

  -- Новый контакт — захватываем сразу.
  IF NOT FOUND THEN
    INSERT INTO public.contact_registry
      (contact_hash, domain, first_seen_brand_id, current_owner_brand_id, owned_until, total_touches, status)
    VALUES
      (p_contact_hash, p_domain, p_brand_id, p_brand_id, now() + make_interval(days => p_cooldown_days), 0, 'active');
    RETURN QUERY SELECT TRUE, 'new'::TEXT;
    RETURN;
  END IF;

  IF v_row.status = 'frozen' THEN
    RETURN QUERY SELECT FALSE, 'frozen: max_touches reached'::TEXT;
    RETURN;
  END IF;

  IF v_row.total_touches >= v_max_touches THEN
    UPDATE public.contact_registry SET status = 'frozen', updated_at = now()
      WHERE contact_hash = p_contact_hash;
    RETURN QUERY SELECT FALSE, 'frozen: max_touches reached'::TEXT;
    RETURN;
  END IF;

  -- Тот же бренд, ещё в окне владения — можно слать в рамках той же кампании.
  IF v_row.current_owner_brand_id = p_brand_id
     AND (v_row.owned_until IS NULL OR v_row.owned_until > now()) THEN
    RETURN QUERY SELECT TRUE, 'same_brand_active_ownership'::TEXT;
    RETURN;
  END IF;

  -- Другой бренд: разрешено только если владение истекло И ротация назвала
  -- именно этот бренд следующим.
  IF v_row.current_owner_brand_id IS DISTINCT FROM p_brand_id THEN
    IF (v_row.owned_until IS NOT NULL AND v_row.owned_until > now())
       OR v_row.next_eligible_brand_id IS DISTINCT FROM p_brand_id THEN
      RETURN QUERY SELECT FALSE, 'owned_by_other_brand'::TEXT;
      RETURN;
    END IF;

    UPDATE public.contact_registry SET
      current_owner_brand_id  = p_brand_id,
      owned_until              = now() + make_interval(days => p_cooldown_days),
      next_eligible_brand_id   = NULL,
      updated_at               = now()
    WHERE contact_hash = p_contact_hash;
    RETURN QUERY SELECT TRUE, 'rotated_to_this_brand'::TEXT;
    RETURN;
  END IF;

  -- Тот же бренд, владение истекло — просто продлеваем.
  UPDATE public.contact_registry SET
    owned_until = now() + make_interval(days => p_cooldown_days),
    updated_at  = now()
  WHERE contact_hash = p_contact_hash;
  RETURN QUERY SELECT TRUE, 'renewed'::TEXT;
END;
$$;

-- Записать факт отправки (последняя часть п. 4.4) — total_touches++ и журнал.
CREATE OR REPLACE FUNCTION public.fn_record_touch(
  p_contact_hash TEXT,
  p_brand_id     UUID,
  p_pipeline     TEXT,
  p_channel      TEXT DEFAULT 'email',
  p_outcome      TEXT DEFAULT 'sent'
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO public.contact_touches (contact_hash, brand_id, pipeline, channel, outcome)
    VALUES (p_contact_hash, p_brand_id, p_pipeline, p_channel, p_outcome);
  UPDATE public.contact_registry
    SET total_touches = total_touches + 1, updated_at = now()
    WHERE contact_hash = p_contact_hash;
END;
$$;

-- Расчёт следующего бренда по кругу (п. 4.3). Читает rotation_order и
-- min_gap_after так же, как их видит человек в brands — не дублирует
-- отдельную конфигурацию для крона.
CREATE OR REPLACE FUNCTION public.fn_rotate_contacts() RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_order        TEXT[];
  v_row          RECORD;
  v_cur_slug     TEXT;
  v_cur_idx      INTEGER;
  v_try_idx      INTEGER;
  v_next_slug    TEXT;
  v_next_brand   public.brands%ROWTYPE;
  v_gap_days     INTEGER;
  v_last_touch   TIMESTAMPTZ;
  v_count        INTEGER := 0;
  v_n            INTEGER;
BEGIN
  SELECT ARRAY(SELECT jsonb_array_elements_text(value)) INTO v_order
    FROM public.system_config WHERE key = 'rotation_order';
  v_n := array_length(v_order, 1);
  IF v_n IS NULL OR v_n = 0 THEN RETURN 0; END IF;

  FOR v_row IN
    SELECT cr.*, b.slug AS cur_slug
    FROM public.contact_registry cr
    JOIN public.brands b ON b.id = cr.current_owner_brand_id
    WHERE cr.owned_until <= now() AND cr.status = 'active'
  LOOP
    v_cur_slug := v_row.cur_slug;
    v_cur_idx := array_position(v_order, v_cur_slug);
    IF v_cur_idx IS NULL THEN CONTINUE; END IF;

    v_next_slug := NULL;
    FOR i IN 1..v_n LOOP
      v_try_idx := ((v_cur_idx - 1 + i) % v_n) + 1;
      SELECT * INTO v_next_brand FROM public.brands
        WHERE slug = v_order[v_try_idx] AND status = 'active';
      IF NOT FOUND THEN CONTINUE; END IF;

      v_gap_days := (v_next_brand.min_gap_after ->> v_cur_slug)::INTEGER;
      IF v_gap_days IS NOT NULL THEN
        SELECT max(touched_at) INTO v_last_touch FROM public.contact_touches
          WHERE contact_hash = v_row.contact_hash AND brand_id =
            (SELECT id FROM public.brands WHERE slug = v_cur_slug);
        IF v_last_touch IS NOT NULL AND v_last_touch > now() - make_interval(days => v_gap_days) THEN
          CONTINUE; -- min_gap_after не истёк, пропускаем этот бренд по кругу
        END IF;
      END IF;

      v_next_slug := v_next_brand.slug;
      EXIT;
    END LOOP;

    IF v_next_slug IS NOT NULL THEN
      UPDATE public.contact_registry
        SET next_eligible_brand_id = (SELECT id FROM public.brands WHERE slug = v_next_slug),
            updated_at = now()
        WHERE contact_hash = v_row.contact_hash;
      v_count := v_count + 1;
    END IF;
  END LOOP;

  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.fn_contact_hash(TEXT, TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_capture_contact(TEXT, TEXT, UUID, INTEGER) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_record_touch(TEXT, UUID, TEXT, TEXT, TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_rotate_contacts() TO anon, authenticated, service_role;
