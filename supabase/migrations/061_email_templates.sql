-- 061 — тексты писем в базу (Блок C §4)
--
-- Тексты жили в process-queue.ts, и правка одного слова требовала деплоя всего
-- конвейера отправки. Здесь они переезжают в таблицу СЛОВО В СЛОВО: ни одна
-- формулировка не переписана, ТЗ §7 это прямо запрещает. Меняется только место
-- хранения.
--
-- ── Плейсхолдеры ────────────────────────────────────────────────────────────
--   {site}       имя сайта или канала
--   {geo_word}   название страны, либо 'your market' когда гео неизвестно
--   {geo_clause} ' in Nigeria' либо пустая строка — кусок фразы вместе с
--                предлогом, потому что при неизвестном гео из предложения
--                должен исчезнуть и предлог тоже
--   {keyword}    запрос, по которому сайт нашёлся (только brand_intent)
--
-- geo_clause вынесен отдельным плейсхолдером, а не собран из {geo_word}, ровно
-- по этой причине: подстановка 'your market' в « in ...» дала бы «I came
-- across your channel X in your market», чего в исходном тексте нет.
--
-- ── attempt_no — это варианты ТЕМЫ, а не касания ────────────────────────────
-- В коде три темы на письмо, и выбирается одна. Для brand_intent — по id лида
-- (повторная попытка обязана прийти под той же темой, что и первая), для
-- cold_* — случайно. Здесь это три строки с одинаковым телом и разными темами;
-- логика выбора остаётся в коде, потому что она разная и ТЗ просит перенести
-- тексты, а не переписать поведение.

CREATE TABLE IF NOT EXISTS public.email_templates (
  id           BIGSERIAL PRIMARY KEY,
  brand_id     UUID NOT NULL REFERENCES public.brands(id),
  variant      TEXT NOT NULL,
  language     TEXT NOT NULL DEFAULT 'EN',
  subject      TEXT NOT NULL,
  body         TEXT NOT NULL,
  attempt_no   INTEGER NOT NULL DEFAULT 1,
  active       BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT email_templates_uniq UNIQUE (brand_id, variant, language, attempt_no)
);

CREATE INDEX IF NOT EXISTS idx_email_templates_pick
  ON public.email_templates(brand_id, variant, language, attempt_no) WHERE active;

-- Тексты писем — не публичные данные: по ним видно, как устроена кампания.
-- В этом проекте ALTER DEFAULT PRIVILEGES выдаёт anon права на каждую новую
-- таблицу, поэтому сначала отбираем.
REVOKE ALL ON public.email_templates FROM anon;
REVOKE ALL ON SEQUENCE public.email_templates_id_seq FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.email_templates TO service_role, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.email_templates_id_seq TO service_role, authenticated;

-- ── Перенос текстов ─────────────────────────────────────────────────────────
-- Все существующие письма написаны от лица 1xPartners про 1xBet, поэтому
-- заводятся под брендом 1xbet. Для 1xcasino и luckypari шаблонов НЕТ, и это
-- намеренно: по ТЗ §4 письмо без шаблона своего бренда не уходит вовсе.
-- Подставить чужой текст значило бы отправить партнёру LuckyPari письмо про
-- 1xBet и вскрыть связку брендов — ровно то, что §2.2 запрещает.
INSERT INTO public.email_templates (brand_id, variant, language, attempt_no, subject, body)
SELECT b.id, v.variant, v.language, v.attempt_no, v.subject, v.body
  FROM public.brands b,
  (VALUES
    -- ── Холодное письмо владельцу сайта (source=seo, по умолчанию) ─────────
    ('cold_geo', 'EN', 1,
     'Exclusive 1xBet deal for {geo_word}',
     E'Hi, I came by {site} — strong work in {geo_word}. I''m Nick from 1xPartners. 1xBet is the #1 betting brand across Africa, fully licensed in your market, and right now I''ve got an exclusive RevShare deal (up to 40%) for partners here. Clean share, no admin fee, weekly payouts, and you deal with me directly. Want me to send the offer?'),
    ('cold_geo', 'EN', 2,
     'Your {geo_word} traffic — up to 40%',
     E'Hi, I came by {site} — strong work in {geo_word}. I''m Nick from 1xPartners. 1xBet is the #1 betting brand across Africa, fully licensed in your market, and right now I''ve got an exclusive RevShare deal (up to 40%) for partners here. Clean share, no admin fee, weekly payouts, and you deal with me directly. Want me to send the offer?'),
    ('cold_geo', 'EN', 3,
     '#1 in Africa, licensed in {geo_word}',
     E'Hi, I came by {site} — strong work in {geo_word}. I''m Nick from 1xPartners. 1xBet is the #1 betting brand across Africa, fully licensed in your market, and right now I''ve got an exclusive RevShare deal (up to 40%) for partners here. Clean share, no admin fee, weekly payouts, and you deal with me directly. Want me to send the offer?'),

    -- ── Владелец YouTube-канала (source=youtube) ───────────────────────────
    ('cold_youtube', 'EN', 1,
     'Exclusive 1xBet deal for {geo_word}',
     E'Hi, I came across your channel {site}{geo_clause} — you''ve built a real, engaged audience, and that''s worth more than most programs pay creators for it. I''m Nick from 1xPartners. You''re already sending this audience somewhere; I can make it pay you more: clean RevShare on 1xBet, no admin fee, no hidden cuts, terms built around your actual numbers, plus creator-friendly promo codes and assets. You deal with me directly, not a support desk. Want me to send a short proposal? Or ping me on Telegram: @aff_manager_xbet'),
    ('cold_youtube', 'EN', 2,
     'Your {geo_word} traffic — up to 40%',
     E'Hi, I came across your channel {site}{geo_clause} — you''ve built a real, engaged audience, and that''s worth more than most programs pay creators for it. I''m Nick from 1xPartners. You''re already sending this audience somewhere; I can make it pay you more: clean RevShare on 1xBet, no admin fee, no hidden cuts, terms built around your actual numbers, plus creator-friendly promo codes and assets. You deal with me directly, not a support desk. Want me to send a short proposal? Or ping me on Telegram: @aff_manager_xbet'),
    ('cold_youtube', 'EN', 3,
     '#1 in Africa, licensed in {geo_word}',
     E'Hi, I came across your channel {site}{geo_clause} — you''ve built a real, engaged audience, and that''s worth more than most programs pay creators for it. I''m Nick from 1xPartners. You''re already sending this audience somewhere; I can make it pay you more: clean RevShare on 1xBet, no admin fee, no hidden cuts, terms built around your actual numbers, plus creator-friendly promo codes and assets. You deal with me directly, not a support desk. Want me to send a short proposal? Or ping me on Telegram: @aff_manager_xbet'),

    -- ── Разработчик приложения (source=appstore) ───────────────────────────
    ('cold_appstore', 'EN', 1,
     'Exclusive 1xBet deal for {geo_word}',
     E'Hi, I came by your app {site} — strong work in {geo_word}. I''m Nick from 1xPartners. 1xBet is the #1 betting brand across Africa, fully licensed in your market, and right now I''ve got an exclusive RevShare deal (up to 40%) for partners here. Clean share, no admin fee, weekly payouts, deep links and API integration, and you deal with me directly. Want me to send the offer?'),
    ('cold_appstore', 'EN', 2,
     'Your {geo_word} traffic — up to 40%',
     E'Hi, I came by your app {site} — strong work in {geo_word}. I''m Nick from 1xPartners. 1xBet is the #1 betting brand across Africa, fully licensed in your market, and right now I''ve got an exclusive RevShare deal (up to 40%) for partners here. Clean share, no admin fee, weekly payouts, deep links and API integration, and you deal with me directly. Want me to send the offer?'),
    ('cold_appstore', 'EN', 3,
     '#1 in Africa, licensed in {geo_word}',
     E'Hi, I came by your app {site} — strong work in {geo_word}. I''m Nick from 1xPartners. 1xBet is the #1 betting brand across Africa, fully licensed in your market, and right now I''ve got an exclusive RevShare deal (up to 40%) for partners here. Clean share, no admin fee, weekly payouts, deep links and API integration, and you deal with me directly. Want me to send the offer?'),

    -- ── Письмо по брендовому трафику (pipeline=brand), англ. ───────────────
    ('brand_intent', 'EN', 1,
     'Quick one about {site}',
     E'Hey, I came by {site} — you''re ranking for {keyword}, solid work. That''s not easy to hold.\n\nI''m Nick, I work with 1xBet on the partnerships side. We work with people who send us brand-intent traffic like this, and the terms tend to work out well for both sides — clean RevShare, no admin fee, weekly payouts.\n\nNot trying to sell you anything right now — just curious if you''re open to hearing the numbers. Takes two minutes.\n\nTelegram: @aff_manager_xbet'),
    ('brand_intent', 'EN', 2,
     'Saw your ranking for {keyword}',
     E'Hey, I came by {site} — you''re ranking for {keyword}, solid work. That''s not easy to hold.\n\nI''m Nick, I work with 1xBet on the partnerships side. We work with people who send us brand-intent traffic like this, and the terms tend to work out well for both sides — clean RevShare, no admin fee, weekly payouts.\n\nNot trying to sell you anything right now — just curious if you''re open to hearing the numbers. Takes two minutes.\n\nTelegram: @aff_manager_xbet'),
    ('brand_intent', 'EN', 3,
     '{site} - a partnership worth 5 minutes',
     E'Hey, I came by {site} — you''re ranking for {keyword}, solid work. That''s not easy to hold.\n\nI''m Nick, I work with 1xBet on the partnerships side. We work with people who send us brand-intent traffic like this, and the terms tend to work out well for both sides — clean RevShare, no admin fee, weekly payouts.\n\nNot trying to sell you anything right now — just curious if you''re open to hearing the numbers. Takes two minutes.\n\nTelegram: @aff_manager_xbet'),

    -- ── То же письмо по-узбекски (lead.geo = UZ) ──────────────────────────
    ('brand_intent', 'UZ', 1,
     '{site} haqida qisqa savol',
     E'Salom, {site} saytingizga kirdim — {keyword} bo''yicha yaxshi o''rinda turibsiz, zo''r ish. Bu o''rinni ushlab turish oson emas.\n\nMen Nikman, 1xBet''da hamkorlik yo''nalishida ishlayman. Biz shunday brend-trafik yuboradigan odamlar bilan ishlaymiz va shartlar odatda ikkala tomon uchun ham qulay chiqadi — toza RevShare, admin to''lovisiz, haftalik to''lovlar.\n\nHozir sizga hech narsa sotmoqchi emasman — shunchaki raqamlarni eshitishga qiziqasizmi, bilmoqchiman. Ikki daqiqa vaqt oladi.\n\nTelegram: @aff_manager_xbet'),
    ('brand_intent', 'UZ', 2,
     '{keyword} bo''yicha o''rningizni ko''rdim',
     E'Salom, {site} saytingizga kirdim — {keyword} bo''yicha yaxshi o''rinda turibsiz, zo''r ish. Bu o''rinni ushlab turish oson emas.\n\nMen Nikman, 1xBet''da hamkorlik yo''nalishida ishlayman. Biz shunday brend-trafik yuboradigan odamlar bilan ishlaymiz va shartlar odatda ikkala tomon uchun ham qulay chiqadi — toza RevShare, admin to''lovisiz, haftalik to''lovlar.\n\nHozir sizga hech narsa sotmoqchi emasman — shunchaki raqamlarni eshitishga qiziqasizmi, bilmoqchiman. Ikki daqiqa vaqt oladi.\n\nTelegram: @aff_manager_xbet'),
    ('brand_intent', 'UZ', 3,
     '{site} - 5 daqiqaga arziydigan hamkorlik',
     E'Salom, {site} saytingizga kirdim — {keyword} bo''yicha yaxshi o''rinda turibsiz, zo''r ish. Bu o''rinni ushlab turish oson emas.\n\nMen Nikman, 1xBet''da hamkorlik yo''nalishida ishlayman. Biz shunday brend-trafik yuboradigan odamlar bilan ishlaymiz va shartlar odatda ikkala tomon uchun ham qulay chiqadi — toza RevShare, admin to''lovisiz, haftalik to''lovlar.\n\nHozir sizga hech narsa sotmoqchi emasman — shunchaki raqamlarni eshitishga qiziqasizmi, bilmoqchiman. Ikki daqiqa vaqt oladi.\n\nTelegram: @aff_manager_xbet')
  ) AS v(variant, language, attempt_no, subject, body)
 WHERE b.slug = '1xbet'
ON CONFLICT ON CONSTRAINT email_templates_uniq DO NOTHING;

-- ── Проверка ────────────────────────────────────────────────────────────────
DO $$
-- total считается отдельной переменной: n по ходу блока переиспользуется под
-- каждую следующую проверку, и итоговая строка печатала бы результат
-- последней из них — ноль пустых тел вместо числа шаблонов.
DECLARE n INT; total INT; bad TEXT;
BEGIN
  SELECT count(*) INTO total FROM public.email_templates;
  n := total;
  IF n <> 15 THEN
    RAISE EXCEPTION 'ожидалось 15 шаблонов (5 вариантов × 3 темы), найдено %', n;
  END IF;

  -- Вариант, у которого не все три темы, — это письмо, которое иногда не
  -- находится. Проверяем комплектность, а не общее число: оно сойдётся и при
  -- перекосе.
  SELECT string_agg(variant || '/' || language || ':' || cnt, ', ') INTO bad
    FROM (SELECT variant, language, count(*) AS cnt
            FROM public.email_templates GROUP BY variant, language) t
   WHERE cnt <> 3;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'у этих вариантов не три темы: %', bad;
  END IF;

  SELECT count(*) INTO n FROM public.email_templates WHERE btrim(body) = '' OR btrim(subject) = '';
  IF n > 0 THEN RAISE EXCEPTION '% шаблонов с пустой темой или телом', n; END IF;

  -- Плейсхолдер, написанный с опечаткой, уедет в письмо как есть — партнёр
  -- получит буквальное «{site}». Проверяем, что в текстах нет фигурных скобок,
  -- кроме известного набора.
  SELECT string_agg(DISTINCT m[1], ', ') INTO bad
    FROM public.email_templates t,
         LATERAL regexp_matches(t.subject || ' ' || t.body, '\{([a-z_]+)\}', 'g') m
   WHERE m[1] NOT IN ('site', 'geo_word', 'geo_clause', 'keyword');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'неизвестные плейсхолдеры в шаблонах: %', bad;
  END IF;

  PERFORM 1 FROM information_schema.role_table_grants
   WHERE table_schema='public' AND table_name='email_templates' AND grantee='anon';
  IF FOUND THEN RAISE EXCEPTION 'у anon остались права на email_templates'; END IF;

  RAISE NOTICE 'шаблонов перенесено: %, все под брендом 1xbet', total;
END $$;
