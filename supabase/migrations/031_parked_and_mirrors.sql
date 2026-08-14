-- ═══════════════════════════════════════════════════════════════════════════
-- v8.1 — запаркованные домены и зеркала операторов
--
-- Две проблемы с первого прогона бренд-модуля, обе кладут в лиды то, что
-- партнёром не является:
--
--   support@ps.kz     — контакт хостера/регистратора, а не владельца сайта.
--                       Писать туда бессмысленно: человек по ту сторону не
--                       имеет отношения к содержимому домена.
--   business@1win.xyz — официальное зеркало 1win на альтернативном TLD.
--                       В точный блок-лист не попало и не могло: операторы
--                       держат зеркала на десятках зон именно для обхода
--                       блокировок, и перечислить их заранее нельзя.
--
-- Идемпотентно: можно перезапускать.
-- ═══════════════════════════════════════════════════════════════════════════


-- ── Регистраторы, хостеры и парковочные сервисы ────────────────────────────
-- Почта на этих доменах — это техподдержка инфраструктуры, а не владелец
-- сайта. Таблицей, а не списком в коде: набор пополняется по мере того, как
-- всплывают новые, и это должно быть строкой в базе, а не деплоем функции.
CREATE TABLE IF NOT EXISTS public.registrar_domains (
  id       BIGSERIAL PRIMARY KEY,
  domain   TEXT UNIQUE NOT NULL,
  note     TEXT,
  added_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.registrar_domains DISABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.registrar_domains TO anon, authenticated, service_role;
GRANT USAGE, SELECT ON SEQUENCE public.registrar_domains_id_seq TO anon, authenticated, service_role;

INSERT INTO public.registrar_domains (domain, note) VALUES
  ('ps.kz',           'Хостер/регистратор, Казахстан'),
  ('godaddy.com',     'Регистратор'),
  ('secureserver.net','Инфраструктура GoDaddy'),
  ('namecheap.com',   'Регистратор'),
  ('reg.ru',          'Регистратор РФ'),
  ('nic.ru',          'Регистратор РФ'),
  ('timeweb.ru',      'Хостер РФ'),
  ('beget.com',       'Хостер РФ'),
  ('hostinger.com',   'Хостер'),
  ('bluehost.com',    'Хостер'),
  ('hostgator.com',   'Хостер'),
  ('siteground.com',  'Хостер'),
  ('ionos.com',       'Хостер'),
  ('ovh.net',         'Хостер'),
  ('hetzner.com',     'Хостер'),
  ('cloudflare.com',  'CDN/DNS'),
  ('domains.google',  'Регистратор Google'),
  ('name.com',        'Регистратор'),
  ('dynadot.com',     'Регистратор'),
  ('enom.com',        'Регистратор'),
  ('tucows.com',      'Регистратор'),
  ('publicdomainregistry.com', 'Регистратор'),
  ('whoisguard.com',  'WHOIS-прокси'),
  ('withheldforprivacy.com', 'WHOIS-прокси'),
  ('privacyprotect.org',     'WHOIS-прокси'),
  ('sedo.com',        'Маркетплейс доменов / парковка'),
  ('above.com',       'Парковка доменов'),
  ('bodis.com',       'Парковка доменов'),
  ('parkingcrew.net', 'Парковка доменов'),
  ('afternic.com',    'Маркетплейс доменов'),
  ('dan.com',         'Маркетплейс доменов'),
  ('squadhelp.com',   'Маркетплейс доменов')
ON CONFLICT (domain) DO NOTHING;


-- ── Диагноз отказа на лиде ─────────────────────────────────────────────────
-- Отдельно от exclude_reason, и вот почему они оба нужны.
-- exclude_reason — ВОРОТА: на него уже завязаны все три наполнителя очереди
-- (`.is('exclude_reason', null)`), и трогать эту проверку в трёх функциях ради
-- нового поля значило бы рисковать отправкой там, где сейчас всё работает.
-- reject_reason — ДИАГНОЗ: чем именно плох лид, для фильтров и разбора во
-- вкладке. Пишутся оба и одним значением; это осознанное дублирование, а не
-- недосмотр.
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS reject_reason    TEXT;
-- Человекочитаемое обоснование эвристики зеркала: по нему решают вручную,
-- а «подозрительно» без причины решать не даёт.
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS suspected_reason TEXT;

CREATE INDEX IF NOT EXISTS leads_reject_reason
  ON public.leads (pipeline, reject_reason) WHERE reject_reason IS NOT NULL;


COMMENT ON TABLE public.registrar_domains IS
  'Домены регистраторов, хостеров, WHOIS-прокси и парковочных сервисов. Почта '
  'на них — техподдержка инфраструктуры, а не владелец сайта. Сравнивается '
  'только с ЧУЖИМ доменом: mail@hostinger.com на сайте hostinger.com был бы '
  'как раз законным контактом владельца.';

COMMENT ON COLUMN public.leads.reject_reason IS
  'Диагноз: parked_domain | brand_mismatch | registrar_contact | '
  'official_operator | occupied | suspected_official. Дублирует значение в '
  'exclude_reason намеренно — exclude_reason это ворота отправки (на него '
  'завязаны наполнители очередей), reject_reason это причина для человека.';

COMMENT ON COLUMN public.leads.suspected_reason IS
  'Почему сработала эвристика зеркала оператора, словами. Например '
  '"bare brand domain + login form + same-domain contact". Без этого флаг '
  'suspected_official нечем проверять вручную.';
