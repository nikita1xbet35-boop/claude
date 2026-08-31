-- 048 — Telegram-боты партнёрской программы (6 гео, один код)
--
-- Задача отдельная от AffiliateOS: боты не ищут лидов и не пишут писем, они
-- выдают человеку персональную ссылку на регистрацию партнёра и записывают
-- факт выдачи. Пересечение с остальной схемой — только общий проект Supabase.
--
-- ── Почему тот же проект, а не отдельный ────────────────────────────────────
-- ТЗ оставляет выбор. Отдельный проект дал бы изоляцию, но ценой второго
-- набора секретов, второго пайплайна миграций и второго места, куда Нику
-- ходить смотреть. Таблицы ниже ни с чем не пересекаются по именам и не
-- ссылаются на существующие, так что изоляция здесь достигается префиксом
-- bot_, а не отдельным проектом.
--
-- ── Почему RLS включён, в отличие от остальных таблиц ───────────────────────
-- В bot_leads лежат telegram id и юзернеймы живых людей. Anon-ключ этого
-- проекта опубликован открытым текстом в index.html — он обязан там быть, это
-- его назначение. Оставить bot_leads доступной anon значит выложить список
-- контактов всем, кто откроет исходник страницы. Поэтому здесь anon не
-- получает вообще ничего, а читает только authenticated (дашборд через /db с
-- подписанным JWT) и service_role (сам воркер, он BYPASSRLS).

-- ── 1. Конфигурация ботов ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.bot_configs (
  slug            TEXT PRIMARY KEY,
  geo_label       TEXT NOT NULL,
  default_lang    TEXT NOT NULL,                      -- en | fr | uz
  manager_contact TEXT NOT NULL DEFAULT '@aff_manager_xbet',

  -- Шаблон ссылки регистрации. Пустой СОЗНАТЕЛЬНО.
  --
  -- ТЗ §5 прямо запрещает решать за Ника две вещи: точный signup_path и
  -- источник живого домена. Захардкоженный адрес выглядел бы как рабочая
  -- ссылка и вёл бы людей в никуда — худший исход для функции, которая в этом
  -- боте главная. Пока поле пусто, бот честно говорит «ссылка ещё не
  -- настроена» и отдаёт контакт менеджера.
  --
  -- Заполняется одним UPDATE, без передеплоя воркера. Подстановка: {ref}.
  -- Пример: 'https://partners.example.com/signup?ref={ref}'
  signup_url_tpl  TEXT NOT NULL DEFAULT '',

  active          BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.bot_configs (slug, geo_label, default_lang) VALUES
  ('india',      'India',              'en'),
  ('africa',     'Africa',             'en'),
  ('bangladesh', 'Bangladesh',         'en'),
  ('worldwide',  'Worldwide',          'en'),
  ('afrique',    'Francophone Africa', 'fr'),
  ('uzbekistan', 'Uzbekistan',         'uz')
ON CONFLICT (slug) DO NOTHING;

-- ── 2. Лиды ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.bot_leads (
  id                  BIGSERIAL PRIMARY KEY,
  bot_slug            TEXT NOT NULL REFERENCES public.bot_configs(slug),
  tg_user_id          BIGINT NOT NULL,
  tg_username         TEXT,
  lang                TEXT NOT NULL,
  ref_code            TEXT NOT NULL,
  link_issued_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_interaction_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reminder_sent       BOOLEAN NOT NULL DEFAULT false,
  status              TEXT NOT NULL DEFAULT 'link_issued',  -- link_issued | contacted_manager | inactive
  UNIQUE (bot_slug, tg_user_id)
);

-- Индекс из ТЗ: выборка реминдера идёт по ещё не отправленным.
CREATE INDEX IF NOT EXISTS idx_bot_leads_reminder
  ON public.bot_leads(link_issued_at) WHERE reminder_sent = false;

-- ── 3. Язык до первой ссылки ────────────────────────────────────────────────
-- /lang доступна сразу, а lang в bot_leads появляется только вместе с
-- ref_code, который NOT NULL. Класть выбор языка в bot_leads означало бы либо
-- заводить лид на того, кто ничего не запрашивал (и портить смысл таблицы —
-- по ней считают выдачи), либо делать ref_code nullable и терять гарантию.
-- Отдельная таблица предпочтений решает это, ничего не искажая.
CREATE TABLE IF NOT EXISTS public.bot_user_prefs (
  bot_slug   TEXT NOT NULL REFERENCES public.bot_configs(slug),
  tg_user_id BIGINT NOT NULL,
  lang       TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (bot_slug, tg_user_id)
);

-- ── 4. Тексты FAQ ───────────────────────────────────────────────────────────
-- В базе, а не в коде: ТЗ §5 требует тексты от Ника, а §3.3 запрещает
-- сочинять факты о лицензиях и условиях RevShare самостоятельно. Ответ,
-- придуманный мной, — это обещание от лица компании, которое никто не
-- согласовывал. Пустая таблица позволяет запустить всё остальное и наполнить
-- FAQ потом, без передеплоя.
CREATE TABLE IF NOT EXISTS public.bot_faq (
  lang       TEXT NOT NULL,                       -- en | fr | uz
  key        TEXT NOT NULL,                       -- payouts | revshare | geo | license
  question   TEXT NOT NULL,                       -- подпись кнопки
  answer     TEXT NOT NULL DEFAULT '',            -- пусто = ещё не согласовано
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (lang, key)
);

-- Засеваются ТОЛЬКО подписи кнопок — они заданы в ТЗ §3.3 дословно и ничего
-- не утверждают. Ответы остаются пустыми до текстов от Ника.
INSERT INTO public.bot_faq (lang, key, question, sort_order) VALUES
  ('en','payouts',  '💵 Payouts',         1),
  ('en','revshare', '📊 RevShare terms',  2),
  ('en','geo',      '🌍 GEO coverage',    3),
  ('en','license',  '🔒 Licensed?',       4),
  ('fr','payouts',  '💵 Paiements',       1),
  ('fr','revshare', '📊 Conditions RevShare', 2),
  ('fr','geo',      '🌍 Couverture GEO',  3),
  ('fr','license',  '🔒 Licences ?',      4),
  ('uz','payouts',  '💵 To''lovlar',      1),
  ('uz','revshare', '📊 RevShare shartlari', 2),
  ('uz','geo',      '🌍 GEO qamrovi',     3),
  ('uz','license',  '🔒 Litsenziya?',     4)
ON CONFLICT (lang, key) DO NOTHING;

-- ── 5. Доступ ───────────────────────────────────────────────────────────────
ALTER TABLE public.bot_configs    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_leads      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_user_prefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_faq        ENABLE ROW LEVEL SECURITY;

-- ── Сначала отобрать, потом выдать ──────────────────────────────────────────
-- Не перестраховка: в Supabase на схему public настроены ALTER DEFAULT
-- PRIVILEGES, выдающие права anon, authenticated и service_role на КАЖДУЮ
-- новую таблицу. То есть к этому месту anon уже получил полный доступ ко всем
-- четырём таблицам — просто потому, что они созданы. «Не упоминать anon»
-- ничего не даёт: молчание здесь означает согласие с умолчанием.
--
-- Именно на этом первая версия миграции и упала в проде: проверка внизу
-- насчитала 28 прав у anon и остановила накат. Проверка сработала верно,
-- ошибкой было предположение, что новая таблица начинает жизнь без грантов.
--
-- PUBLIC тоже: права, выданные ему, наследует любая роль, включая anon.
-- authenticated отбирается по той же причине: умолчание выдало ему полный
-- доступ, а по замыслу у дашборда только чтение — писать в эти таблицы должен
-- воркер, и больше никто.
REVOKE ALL ON public.bot_configs, public.bot_leads, public.bot_user_prefs, public.bot_faq
  FROM anon, authenticated, PUBLIC;
REVOKE ALL ON SEQUENCE public.bot_leads_id_seq FROM anon, authenticated, PUBLIC;

GRANT SELECT ON public.bot_configs, public.bot_leads, public.bot_user_prefs, public.bot_faq
  TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.bot_configs, public.bot_leads, public.bot_user_prefs, public.bot_faq
  TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.bot_leads_id_seq TO service_role;

-- Дашборду — только чтение: боты пишут сами, руками там править нечего, а
-- право записи из браузера пришлось бы отдельно объяснять.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['bot_configs','bot_leads','bot_user_prefs','bot_faq'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_read', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (true)',
      t || '_read', t);
  END LOOP;
END $$;

-- ── 6. Проверка ─────────────────────────────────────────────────────────────
-- Ошибка в грантах здесь означала бы утечку персональных данных, а заметить её
-- глазами нельзя — таблица просто читается, и это выглядит нормально.
DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n FROM information_schema.role_table_grants
   WHERE table_schema = 'public'
     AND table_name IN ('bot_configs','bot_leads','bot_user_prefs','bot_faq')
     AND grantee = 'anon';
  IF n > 0 THEN
    RAISE EXCEPTION 'anon получил % прав на bot_*-таблицы — в них telegram id живых людей', n;
  END IF;

  -- Дашборд должен только читать. Право записи здесь означало бы, что лида
  -- можно подделать или стереть из браузера, а таблица считает выдачи ссылок.
  SELECT count(*) INTO n FROM information_schema.role_table_grants
   WHERE table_schema = 'public'
     AND table_name IN ('bot_configs','bot_leads','bot_user_prefs','bot_faq')
     AND grantee = 'authenticated'
     AND privilege_type <> 'SELECT';
  IF n > 0 THEN
    RAISE EXCEPTION 'у authenticated % прав кроме SELECT — дашборд должен только читать', n;
  END IF;

  SELECT count(*) INTO n FROM public.bot_configs;
  IF n <> 6 THEN RAISE EXCEPTION 'ожидалось 6 конфигов ботов, найдено %', n; END IF;

  RAISE NOTICE 'bot_*: 6 конфигов, anon без доступа, чтение только у authenticated';
END $$;
