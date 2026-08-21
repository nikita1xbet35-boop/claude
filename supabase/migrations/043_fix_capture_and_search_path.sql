-- 043 — Исправление двух дефектов в функциях Блока 1 (035/039)
--
-- 035 уже применена в проде, поэтому правки идут отдельным номером через
-- CREATE OR REPLACE, а не редактированием 035 (её содержимое уже в ledger и
-- повторно не выполнится).
--
-- ── ДЕФЕКТ 1: FOUND читался через посторонний SELECT ────────────────────────
-- fn_capture_contact определяла «нашли ли контакт» по неявной переменной
-- FOUND, но между её установкой и чтением стоял ДРУГОЙ SELECT INTO —
-- чтение max_touches_per_contact из system_config. FOUND отражает результат
-- ПОСЛЕДНЕГО SQL-запроса, поэтому при p_email IS NULL (ветка по домену,
-- заявленная в комментарии 035 как поддерживаемая) FOUND оставался true от
-- чтения конфига: поиск по домену пропускался, INSERT не выполнялся, и
-- функция возвращала allowed=false / 'owned_by_other_brand' для совершенно
-- нового контакта, ничего не записав в реестр.
-- Сейчас результат каждого поиска складывается в явный boolean v_found.
--
-- ── ДЕФЕКТ 2: SECURITY DEFINER без фиксированного search_path ───────────────
-- digest() живёт в схеме extensions, а вызывался неквалифицированно. Функция
-- перепарсивается при каждом вызове в сессии вызывающего, поэтому любой
-- клиент, у которого в search_path нет extensions, получал
-- «function digest(text, unknown) does not exist» — то есть вся цепочка
-- захвата/касаний контакта ломалась в зависимости от того, КТО зовёт.
-- Плюс SECURITY DEFINER без SET search_path — стандартная дыра в привилегиях.
-- Фиксируем search_path на всех функциях, которые его требуют.

-- pgcrypto нужен для digest(). На Supabase обычно уже стоит в схеме
-- extensions; ставим только если его нет, с откатом на схему по умолчанию.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') THEN
    BEGIN
      CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
    EXCEPTION WHEN OTHERS THEN
      CREATE EXTENSION pgcrypto;
    END;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.fn_contact_hash(p_email TEXT, p_domain TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE
SET search_path = public, extensions, pg_temp
AS $$
  SELECT encode(digest(
    CASE WHEN p_email IS NOT NULL AND trim(p_email) <> ''
      THEN lower(trim(p_email))
      ELSE regexp_replace(lower(trim(coalesce(p_domain, ''))), '^www\.', '')
    END, 'sha256'), 'hex');
$$;

CREATE OR REPLACE FUNCTION public.fn_capture_contact(
  p_email        TEXT,
  p_domain       TEXT,
  p_brand_id     UUID,
  p_cooldown_days INTEGER
) RETURNS TABLE(allowed BOOLEAN, reason TEXT, resolved_hash TEXT)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_row public.contact_registry%ROWTYPE;
  v_max_touches INTEGER;
  v_email_hash TEXT;
  v_domain_hash TEXT;
  v_contact_hash TEXT;
  v_found BOOLEAN := FALSE;   -- см. ДЕФЕКТ 1 в шапке: НЕ полагаться на FOUND
BEGIN
  v_email_hash  := CASE WHEN p_email IS NOT NULL AND trim(p_email) <> ''
                        THEN public.fn_contact_hash(p_email, NULL) END;
  v_domain_hash := CASE WHEN p_domain IS NOT NULL AND trim(p_domain) <> ''
                        THEN public.fn_contact_hash(NULL, p_domain) END;

  v_contact_hash := COALESCE(v_email_hash, v_domain_hash);
  -- Ни email, ни домена — идентифицировать контакт нечем. Раньше такой вызов
  -- дошёл бы до INSERT с NULL в первичном ключе.
  IF v_contact_hash IS NULL THEN
    RETURN QUERY SELECT FALSE, 'no email and no domain'::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  SELECT (value #>> '{}')::INTEGER INTO v_max_touches
    FROM public.system_config WHERE key = 'max_touches_per_contact';
  v_max_touches := COALESCE(v_max_touches, 5);

  -- Сначала по email (если он есть).
  IF v_email_hash IS NOT NULL THEN
    SELECT * INTO v_row FROM public.contact_registry
      WHERE contact_hash = v_email_hash FOR UPDATE;
    v_found := FOUND;
  END IF;

  -- Не нашли по email (или email не передали) — пробуем по домену. Найденная
  -- здесь строка при наличии email переносится на email-хэш.
  IF NOT v_found AND v_domain_hash IS NOT NULL THEN
    SELECT * INTO v_row FROM public.contact_registry
      WHERE contact_hash = v_domain_hash FOR UPDATE;
    v_found := FOUND;
    IF v_found AND v_email_hash IS NOT NULL THEN
      BEGIN
        UPDATE public.contact_registry SET contact_hash = v_email_hash, updated_at = now()
          WHERE contact_hash = v_domain_hash;  -- ON UPDATE CASCADE переносит contact_touches
        v_row.contact_hash := v_email_hash;
      EXCEPTION WHEN unique_violation THEN
        -- Гонка: параллельный вызов уже завёл строку под email-хэшем, пока мы
        -- держали заблокированной только доменную. Берём победившую строку.
        SELECT * INTO v_row FROM public.contact_registry
          WHERE contact_hash = v_email_hash FOR UPDATE;
        v_found := FOUND;
      END;
    END IF;
  END IF;

  -- Новый контакт — захватываем сразу.
  IF NOT v_found THEN
    INSERT INTO public.contact_registry
      (contact_hash, domain, first_seen_brand_id, current_owner_brand_id, owned_until, total_touches, status)
    VALUES
      (v_contact_hash, p_domain, p_brand_id, p_brand_id, now() + make_interval(days => p_cooldown_days), 0, 'active');
    RETURN QUERY SELECT TRUE, 'new'::TEXT, v_contact_hash;
    RETURN;
  END IF;

  -- Дальше работаем с хэшем найденной строки, а не с вычисленным: после
  -- переноса домен→email они совпадают, но при гонке выше могли разойтись.
  v_contact_hash := v_row.contact_hash;

  IF v_row.status = 'frozen' THEN
    RETURN QUERY SELECT FALSE, 'frozen: max_touches reached'::TEXT, v_contact_hash;
    RETURN;
  END IF;

  IF v_row.total_touches >= v_max_touches THEN
    UPDATE public.contact_registry SET status = 'frozen', updated_at = now()
      WHERE contact_hash = v_contact_hash;
    RETURN QUERY SELECT FALSE, 'frozen: max_touches reached'::TEXT, v_contact_hash;
    RETURN;
  END IF;

  -- Тот же бренд, ещё в окне владения — можно слать в рамках той же кампании.
  IF v_row.current_owner_brand_id = p_brand_id
     AND (v_row.owned_until IS NULL OR v_row.owned_until > now()) THEN
    RETURN QUERY SELECT TRUE, 'same_brand_active_ownership'::TEXT, v_contact_hash;
    RETURN;
  END IF;

  -- Другой бренд: разрешено только если владение истекло И ротация назвала
  -- именно этот бренд следующим.
  IF v_row.current_owner_brand_id IS DISTINCT FROM p_brand_id THEN
    IF (v_row.owned_until IS NOT NULL AND v_row.owned_until > now())
       OR v_row.next_eligible_brand_id IS DISTINCT FROM p_brand_id THEN
      RETURN QUERY SELECT FALSE, 'owned_by_other_brand'::TEXT, v_contact_hash;
      RETURN;
    END IF;

    UPDATE public.contact_registry SET
      current_owner_brand_id  = p_brand_id,
      owned_until              = now() + make_interval(days => p_cooldown_days),
      next_eligible_brand_id   = NULL,
      updated_at               = now()
    WHERE contact_hash = v_contact_hash;
    RETURN QUERY SELECT TRUE, 'rotated_to_this_brand'::TEXT, v_contact_hash;
    RETURN;
  END IF;

  -- Тот же бренд, владение истекло — просто продлеваем.
  UPDATE public.contact_registry SET
    owned_until = now() + make_interval(days => p_cooldown_days),
    updated_at  = now()
  WHERE contact_hash = v_contact_hash;
  RETURN QUERY SELECT TRUE, 'renewed'::TEXT, v_contact_hash;
END;
$$;

-- Остальные SECURITY DEFINER функции Блока 1 — только фиксация search_path,
-- тело не меняется.
CREATE OR REPLACE FUNCTION public.fn_record_touch(
  p_contact_hash TEXT,
  p_brand_id     UUID,
  p_pipeline     TEXT,
  p_channel      TEXT DEFAULT 'email',
  p_outcome      TEXT DEFAULT 'sent'
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_max_touches INTEGER;
  v_total INTEGER;
BEGIN
  SELECT (value #>> '{}')::INTEGER INTO v_max_touches
    FROM public.system_config WHERE key = 'max_touches_per_contact';
  v_max_touches := COALESCE(v_max_touches, 5);

  INSERT INTO public.contact_touches (contact_hash, brand_id, pipeline, channel, outcome)
    VALUES (p_contact_hash, p_brand_id, p_pipeline, p_channel, p_outcome);

  UPDATE public.contact_registry
    SET total_touches = total_touches + 1, updated_at = now()
    WHERE contact_hash = p_contact_hash
    RETURNING total_touches INTO v_total;

  IF v_total >= v_max_touches THEN
    UPDATE public.contact_registry SET status = 'frozen', updated_at = now()
      WHERE contact_hash = p_contact_hash;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_record_touch_by_contact(
  p_email    TEXT,
  p_domain   TEXT,
  p_brand_id UUID,
  p_pipeline TEXT,
  p_channel  TEXT DEFAULT 'email',
  p_outcome  TEXT DEFAULT 'sent'
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_hash TEXT;
BEGIN
  v_hash := public.fn_contact_hash(p_email, p_domain);
  IF v_hash IS NULL THEN RETURN; END IF;
  INSERT INTO public.contact_registry (contact_hash, domain, first_seen_brand_id, current_owner_brand_id, status)
    VALUES (v_hash, p_domain, p_brand_id, p_brand_id, 'active')
    ON CONFLICT (contact_hash) DO NOTHING;
  PERFORM public.fn_record_touch(v_hash, p_brand_id, p_pipeline, p_channel, p_outcome);
END;
$$;

-- Оставшиеся SECURITY DEFINER функции 035/038 — тело менять не нужно, поэтому
-- ALTER, а не переобъявление: так исключается риск разойтись с оригиналом при
-- копировании. Для 038 то же самое прописано прямо в объявлениях (она ещё не
-- применялась, править на месте безопаснее, чем чинить следом).
DO $$
DECLARE fn TEXT;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.fn_rotate_contacts()',
    'public.fn_next_api_key(text, uuid)',
    'public.fn_ban_api_key(uuid, text)',
    'public.fn_reset_api_key_usage()'
  ] LOOP
    BEGIN
      EXECUTE format('ALTER FUNCTION %s SET search_path = public, extensions, pg_temp', fn);
    EXCEPTION WHEN undefined_function THEN
      RAISE NOTICE 'нет функции % — пропускаю (миграция, где она объявлена, ещё не применена)', fn;
    END;
  END LOOP;
END $$;
