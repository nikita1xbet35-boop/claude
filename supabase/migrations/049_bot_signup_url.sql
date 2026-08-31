-- 049 — адрес регистрации новых партнёров для Telegram-ботов
--
-- 048 оставила signup_url_tpl пустым сознательно: ТЗ §5 запрещало выбирать
-- адрес самостоятельно, а захардкоженная догадка выглядела бы как рабочая
-- ссылка и вела бы людей в никуда. Ник назвал адрес — заполняем.
--
-- Один на все шесть ботов: подтверждено явно («во всех ботах одна и та же»),
-- поэтому UPDATE без WHERE, а не шесть отдельных.
--
-- ── Про имя параметра ───────────────────────────────────────────────────────
-- ?ref= взято из ТЗ §3.2, где ссылка записана как
--   {live_domain}/{signup_path}?ref={ref_code}
-- Отдельного подтверждения, что 1xPartners ждёт параметр именно с таким
-- именем, не было (ТЗ §5 просило его подтвердить, ответ касался только
-- адреса). Если на стороне партнёрки он называется иначе — sub_id, refcode,
-- p — это правится одним UPDATE ниже, без передеплоя воркера: шаблон целиком
-- лежит в базе, код подставляет только {ref}.

UPDATE public.bot_configs
   SET signup_url_tpl = 'https://1xaffiliate.org/newreg?ref={ref}';

-- ── Проверка ────────────────────────────────────────────────────────────────
-- Пустой шаблон у бота = его главная кнопка не работает, и снаружи это
-- выглядит как «бот отвечает, но ссылку не даёт». Ошибка тихая, поэтому
-- проверяется здесь.
DO $$
DECLARE
  n_empty INT;
  sample  TEXT;
BEGIN
  SELECT count(*) INTO n_empty FROM public.bot_configs WHERE signup_url_tpl = '';
  IF n_empty > 0 THEN
    RAISE EXCEPTION 'у % ботов пустой signup_url_tpl — кнопка выдачи ссылки у них не сработает', n_empty;
  END IF;

  SELECT count(*) INTO n_empty FROM public.bot_configs WHERE signup_url_tpl NOT LIKE '%{ref}%';
  IF n_empty > 0 THEN
    RAISE EXCEPTION 'у % ботов в шаблоне нет {ref} — все получат одну безличную ссылку', n_empty;
  END IF;

  SELECT replace(signup_url_tpl, '{ref}', 'tg_india_483920117')
    INTO sample FROM public.bot_configs WHERE slug = 'india';
  RAISE NOTICE 'ссылка задана всем 6 ботам, пример: %', sample;
END $$;
