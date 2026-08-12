-- ═══════════════════════════════════════════════════════════════════════════
-- Расширение пула layer A — снятие потолка объёма
--
-- ПОЧЕМУ
-- Миграция 024 сменила информационные ключи на коммерческие. Качество выросло,
-- но объём упёрся в стену: она оставила ВСЕГО 40 ключей layer A на 15 рынков —
-- от 1 (Мали, Буркина) до 5 (Нигерия) на пресет.
--
-- Выборка в find-and-queue: kwStart = (cycle * KW_PER_RUN) % pool_size, при
-- KW_PER_RUN = 5. Для пула из 5 ключей это (cycle*5) % 5 = 0 ВСЕГДА. То есть
-- каждый прогон по Нигерии искал одни и те же пять запросов, вечно; менялись
-- только страница выдачи и город. Всё поисковое пространство пресета:
-- 5 ключей × 3 страницы × 5 вариантов города = 75 запросов, дальше цикл
-- повторяется и дедуп выбрасывает всё как уже известное.
--
-- Это и есть причина «раньше было больше, сейчас 36 лидов в сутки»: за 24 часа
-- 1009 найденных URL превратились в 33 сохранённых (3.3%) — не потому что
-- источник плохой, а потому что мы ищем по кругу.
--
-- ЧТО ДЕЛАЕТ ЭТА МИГРАЦИЯ
-- Расширяет пул примерно в 5 раз (40 → ~200), сохраняя правило отбора из 024:
-- ключ берём только если за позицию по нему в SEO платят деньги. Никаких
-- «как вывести выигрыш» — там хобби-блоги, которые нам не партнёры.
--
-- Шаблоны через cross join, а не 160 литералов: добавить рынок или запрос
-- должно быть правкой в одну строку, а не упражнением в переписывании.
--
-- Идемпотентно: можно перезапускать.
-- ═══════════════════════════════════════════════════════════════════════════

WITH markets(preset, geo_word, lang) AS (
  VALUES
    ('1xb-ng', 'nigeria',        'en'),
    ('1xb-ke', 'kenya',          'en'),
    ('1xb-gh', 'ghana',          'en'),
    ('1xb-tz', 'tanzania',       'en'),
    ('1xb-ug', 'uganda',         'en'),
    ('1xb-zm', 'zambia',         'en'),
    ('1xb-et', 'ethiopia',       'en'),
    ('1xb-cm', 'cameroun',       'fr'),
    ('1xb-ci', 'cote d''ivoire', 'fr'),
    ('1xb-sn', 'senegal',        'fr'),
    ('1xb-bf', 'burkina faso',   'fr'),
    ('1xb-ml', 'mali',           'fr'),
    ('1xb-cd', 'rdc',            'fr'),
    ('1xb-mz', 'mocambique',     'pt'),
    ('1xb-agency', 'africa',     'en')
),
-- tpl_lang NULL = для всех рынков; иначе только для совпадающего языка.
--
-- Отбор: каждый шаблон — это запрос, по которому аффилиаты реально конкурируют
-- за позицию. «Aviator» и «virtual» здесь не случайно: в Африке это отдельные
-- крупные вертикали со своими обзорниками, и их выдачу занимают ровно те, кто
-- нам нужен.
templates(tpl, tpl_lang) AS (
  VALUES
    -- Английский
    ('top betting sites {geo}',                    'en'),
    ('best odds betting sites {geo}',              'en'),
    ('new betting sites {geo}',                    'en'),
    ('best betting app {geo}',                     'en'),
    ('bookmaker comparison {geo}',                 'en'),
    ('betting sites with welcome bonus {geo}',     'en'),
    ('free bet offers {geo}',                      'en'),
    ('best football betting site {geo}',           'en'),
    ('online betting sites {geo} review',          'en'),
    ('betting promo code {geo}',                   'en'),
    ('best casino sites {geo}',                    'en'),
    ('best aviator betting site {geo}',            'en'),
    ('best virtual betting site {geo}',            'en'),
    ('highest odds betting site {geo}',            'en'),
    -- Французский
    ('meilleurs sites de paris sportifs {geo}',    'fr'),
    ('comparatif bookmakers {geo}',                'fr'),
    ('meilleures cotes paris sportifs {geo}',      'fr'),
    ('bonus de bienvenue paris sportifs {geo}',    'fr'),
    ('code promo paris sportifs {geo}',            'fr'),
    ('meilleur site de paris en ligne {geo}',      'fr'),
    ('meilleur casino en ligne {geo}',             'fr'),
    ('meilleur site aviator {geo}',                'fr'),
    ('nouveau site de paris sportifs {geo}',       'fr'),
    -- Португальский
    ('melhores casas de apostas {geo}',            'pt'),
    ('comparacao casas de apostas {geo}',          'pt'),
    ('melhores odds apostas {geo}',                'pt'),
    ('bonus de boas vindas apostas {geo}',         'pt'),
    ('codigo promocional apostas {geo}',           'pt'),
    ('melhor casino online {geo}',                 'pt'),
    ('melhor site aviator {geo}',                  'pt')
)
INSERT INTO public.keywords (preset, layer, keyword, lang, source_pref, active)
SELECT
  m.preset,
  'A',
  replace(t.tpl, '{geo}', m.geo_word),
  m.lang,
  'ddg',          -- layer A остаётся на DuckDuckGo: бесплатно и широко
  TRUE
FROM markets m
JOIN templates t ON t.tpl_lang = m.lang
ON CONFLICT (preset, keyword) DO UPDATE
  SET active = TRUE, archived_at = NULL, layer = EXCLUDED.layer,
      lang = EXCLUDED.lang, source_pref = EXCLUDED.source_pref;


-- ── Обзоры конкретных букмекеров по крупным рынкам ─────────────────────────
-- Самый коммерческий класс запросов: «<букмекер> review» — это витрина
-- аффилиата, за неё платят больше всего. Шаблоном не берётся, потому что набор
-- букмекеров у каждого рынка свой, а подставлять чужие — значит искать выдачу,
-- которой не существует.
INSERT INTO public.keywords (preset, layer, keyword, lang, source_pref, active)
VALUES
  -- Нигерия
  ('1xb-ng', 'A', 'betano nigeria review',        'en', 'ddg', TRUE),
  ('1xb-ng', 'A', 'msport nigeria review',        'en', 'ddg', TRUE),
  ('1xb-ng', 'A', 'parimatch nigeria review',     'en', 'ddg', TRUE),
  ('1xb-ng', 'A', 'bangbet nigeria review',       'en', 'ddg', TRUE),
  ('1xb-ng', 'A', 'nairabet promo code',          'en', 'ddg', TRUE),
  ('1xb-ng', 'A', 'betano promo code nigeria',    'en', 'ddg', TRUE),
  -- Кения
  ('1xb-ke', 'A', 'betway kenya review',          'en', 'ddg', TRUE),
  ('1xb-ke', 'A', 'mozzartbet kenya bonus',       'en', 'ddg', TRUE),
  ('1xb-ke', 'A', 'shabiki review kenya',         'en', 'ddg', TRUE),
  ('1xb-ke', 'A', 'betlion kenya review',         'en', 'ddg', TRUE),
  -- Гана
  ('1xb-gh', 'A', 'msport ghana review',          'en', 'ddg', TRUE),
  ('1xb-gh', 'A', 'premier bet ghana review',     'en', 'ddg', TRUE),
  ('1xb-gh', 'A', 'soccabet bonus code',          'en', 'ddg', TRUE),
  -- Танзания / Уганда / Замбия
  ('1xb-tz', 'A', 'betpawa tanzania review',      'en', 'ddg', TRUE),
  ('1xb-tz', 'A', 'premier bet tanzania bonus',   'en', 'ddg', TRUE),
  ('1xb-ug', 'A', 'betpawa uganda review',        'en', 'ddg', TRUE),
  ('1xb-ug', 'A', 'sportybet uganda review',      'en', 'ddg', TRUE),
  ('1xb-zm', 'A', 'betpawa zambia review',        'en', 'ddg', TRUE),
  ('1xb-zm', 'A', 'gal sport betting zambia',     'en', 'ddg', TRUE),
  -- Франкофония
  ('1xb-cm', 'A', 'betwinner cameroun avis',      'fr', 'ddg', TRUE),
  ('1xb-cm', 'A', 'melbet cameroun avis',         'fr', 'ddg', TRUE),
  ('1xb-ci', 'A', 'premier bet cote d''ivoire avis', 'fr', 'ddg', TRUE),
  ('1xb-ci', 'A', 'betclic cote d''ivoire avis',  'fr', 'ddg', TRUE),
  ('1xb-sn', 'A', 'betclic senegal avis',         'fr', 'ddg', TRUE),
  ('1xb-cd', 'A', 'premier bet rdc avis',         'fr', 'ddg', TRUE),
  ('1xb-bf', 'A', 'premier bet burkina avis',     'fr', 'ddg', TRUE),
  ('1xb-ml', 'A', 'premier bet mali avis',        'fr', 'ddg', TRUE),
  -- Мозамбик
  ('1xb-mz', 'A', 'premier bet mocambique analise', 'pt', 'ddg', TRUE),
  ('1xb-mz', 'A', 'betpawa mocambique analise',   'pt', 'ddg', TRUE)
ON CONFLICT (preset, keyword) DO UPDATE
  SET active = TRUE, archived_at = NULL, layer = EXCLUDED.layer,
      source_pref = EXCLUDED.source_pref;


-- Проверка результата: сколько активных ключей layer A стало на пресет.
-- Меньше KW_PER_RUN (5) — значит пресет всё ещё ищет по кругу.
COMMENT ON TABLE public.keywords IS
  'Пул поисковых запросов. Layer A (DuckDuckGo) — интент игрока, layers B/C — '
  'издатели и футпринты аффилиатов. ВАЖНО: пул на пресет должен быть заметно '
  'больше KW_PER_RUN из find-and-queue (сейчас 5), иначе выборка '
  '(cycle * KW_PER_RUN) %% pool_size вырождается в одни и те же ключи на каждом '
  'прогоне — ровно это и обрубило объём после миграции 024.';
