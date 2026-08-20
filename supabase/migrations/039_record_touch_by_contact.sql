-- 039 — Блок 2: fn_record_touch по email/домену
--
-- fn_record_touch (035) принимает готовый contact_hash — на момент захвата
-- (fn_capture_contact) он уже вычислен, но реальная отправка в process-queue.ts
-- происходит отдельным вызовом, минуты или дни спустя, и там email/домен
-- есть, а вычисленного хэша уже нет. Дублировать нормализацию
-- (email vs домен, lower/trim/www-strip) в TypeScript — ровно то, чего
-- fn_contact_hash был написан избегать: одно правило, а не две копии,
-- которые разойдутся при первом же нестандартном email.
CREATE OR REPLACE FUNCTION public.fn_record_touch_by_contact(
  p_email    TEXT,
  p_domain   TEXT,
  p_brand_id UUID,
  p_pipeline TEXT,
  p_channel  TEXT DEFAULT 'email',
  p_outcome  TEXT DEFAULT 'sent'
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_hash TEXT;
BEGIN
  v_hash := public.fn_contact_hash(p_email, p_domain);
  -- The row should already exist — fn_capture_contact created or renewed it
  -- when this send was queued. If it genuinely doesn't (row deleted, or this
  -- send bypassed the gate somehow), touching a contact that isn't in the
  -- registry yet is still meaningful signal, so create it rather than no-op.
  INSERT INTO public.contact_registry (contact_hash, domain, first_seen_brand_id, current_owner_brand_id, status)
    VALUES (v_hash, p_domain, p_brand_id, p_brand_id, 'active')
    ON CONFLICT (contact_hash) DO NOTHING;
  PERFORM public.fn_record_touch(v_hash, p_brand_id, p_pipeline, p_channel, p_outcome);
END;
$$;

GRANT EXECUTE ON FUNCTION public.fn_record_touch_by_contact(TEXT, TEXT, UUID, TEXT, TEXT, TEXT) TO anon, authenticated, service_role;
