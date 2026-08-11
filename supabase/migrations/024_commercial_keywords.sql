-- ═══════════════════════════════════════════════════════════════════════════
-- Search pool v7 — commercial intent
--
-- WHY
-- The layer-A pool was informational long-tail: "opay betting nigeria", "how to
-- cash out bet naija", "jinsi ya kushinda kubet". Those are beginners' questions,
-- and the sites ranking for them are hobby blogs. The partner this program
-- actually wants is a professional SEO affiliate — and professionals fight over
-- the queries where the money is: "best betting sites nigeria", "bet9ja review",
-- "betking bonus code".
--
-- Selection rule for anything added here: if people PAY for SEO position on this
-- query, it belongs in the pool. If it is a newbie asking how to withdraw
-- winnings, it does not.
--
-- The old pool is archived (active = FALSE), not deleted. Search results turn
-- over; in three or four months those keys may be worth another pass, and their
-- accumulated yield stats are the evidence for deciding that.
--
-- Layers B and C route to DataForSEO SERP rather than DuckDuckGo: Google indexes
-- corporate pages (/advertise, media kits) and exact quoted footprints
-- ("affiliate disclosure") far better, which is precisely what those layers hunt.
--
-- Idempotent: safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Archive the burned-out layer-A pool ────────────────────────────────────
UPDATE public.keywords
   SET active = FALSE,
       archived_at = COALESCE(archived_at, now())
 WHERE layer = 'A'
   AND active = TRUE
   AND preset LIKE '1xb-%';


-- ── Layer A: commercial intent, per market ─────────────────────────────────
INSERT INTO public.keywords (preset, layer, keyword, lang, source_pref, active)
VALUES
  -- Anglophone Africa
  ('1xb-ng', 'A', 'best betting sites nigeria',            'en', 'ddg', TRUE),
  ('1xb-ng', 'A', 'top bookmakers nigeria ranked',         'en', 'ddg', TRUE),
  ('1xb-ng', 'A', 'bet9ja review',                         'en', 'ddg', TRUE),
  ('1xb-ng', 'A', 'sportybet review nigeria',              'en', 'ddg', TRUE),
  ('1xb-ng', 'A', 'betking bonus code',                    'en', 'ddg', TRUE),
  ('1xb-ke', 'A', 'best betting sites kenya',              'en', 'ddg', TRUE),
  ('1xb-ke', 'A', 'betika review kenya',                   'en', 'ddg', TRUE),
  ('1xb-ke', 'A', 'odibets bonus code',                    'en', 'ddg', TRUE),
  ('1xb-ke', 'A', 'sportpesa review',                      'en', 'ddg', TRUE),
  ('1xb-gh', 'A', 'best betting sites ghana',              'en', 'ddg', TRUE),
  ('1xb-gh', 'A', 'betway ghana review',                   'en', 'ddg', TRUE),
  ('1xb-gh', 'A', 'betpawa bonus code ghana',              'en', 'ddg', TRUE),
  ('1xb-tz', 'A', 'top betting sites tanzania',            'en', 'ddg', TRUE),
  ('1xb-tz', 'A', 'best bookmaker tanzania review',        'en', 'ddg', TRUE),
  ('1xb-ug', 'A', 'best betting sites uganda',             'en', 'ddg', TRUE),
  ('1xb-ug', 'A', 'fortebet review uganda',                'en', 'ddg', TRUE),
  ('1xb-zm', 'A', 'betting sites comparison zambia',       'en', 'ddg', TRUE),
  ('1xb-zm', 'A', 'best betting site zambia review',       'en', 'ddg', TRUE),
  ('1xb-et', 'A', 'bookmaker comparison ethiopia',         'en', 'ddg', TRUE),
  ('1xb-et', 'A', 'best betting sites ethiopia',           'en', 'ddg', TRUE),

  -- Francophone Africa — converts better on RevShare, so it carries real weight
  ('1xb-sn', 'A', 'meilleurs sites paris sportifs senegal', 'fr', 'ddg', TRUE),
  ('1xb-sn', 'A', 'premier bet avis senegal',               'fr', 'ddg', TRUE),
  ('1xb-sn', 'A', 'sunubet avis',                           'fr', 'ddg', TRUE),
  ('1xb-cm', 'A', '1win avis cameroun',                     'fr', 'ddg', TRUE),
  ('1xb-cm', 'A', 'code promo premier bet cameroun',        'fr', 'ddg', TRUE),
  ('1xb-cm', 'A', 'meilleurs bookmakers cameroun',          'fr', 'ddg', TRUE),
  ('1xb-ci', 'A', 'meilleurs bookmakers cote d''ivoire',    'fr', 'ddg', TRUE),
  ('1xb-ci', 'A', 'comparatif paris sportifs abidjan',      'fr', 'ddg', TRUE),
  ('1xb-ml', 'A', 'comparatif sites paris sportifs mali',   'fr', 'ddg', TRUE),
  ('1xb-bf', 'A', 'meilleur site pari sportif burkina faso','fr', 'ddg', TRUE),
  ('1xb-cd', 'A', 'avis paris sportifs rdc',                'fr', 'ddg', TRUE),
  ('1xb-cd', 'A', 'meilleurs bookmakers congo',             'fr', 'ddg', TRUE),

  -- Lusophone
  ('1xb-mz', 'A', 'melhores casas de apostas mocambique',   'pt', 'ddg', TRUE),
  ('1xb-mz', 'A', 'premier bet mocambique analise',         'pt', 'ddg', TRUE),
  ('1xb-mz', 'A', 'codigo promocional apostas mocambique',  'pt', 'ddg', TRUE),

  -- Pan-African
  ('1xb-agency', 'A', 'best betting sites africa',          'en', 'ddg', TRUE),
  ('1xb-agency', 'A', 'african bookmaker comparison',       'en', 'ddg', TRUE),
  ('1xb-agency', 'A', 'betting affiliate africa',           'en', 'ddg', TRUE),
  ('1xb-agency', 'A', 'top betting apps africa ranked',     'en', 'ddg', TRUE),
  ('1xb-agency', 'A', 'betclic avis afrique',               'fr', 'ddg', TRUE)
ON CONFLICT (preset, keyword) DO UPDATE
  SET active = TRUE, archived_at = NULL, layer = EXCLUDED.layer,
      lang = EXCLUDED.lang, source_pref = EXCLUDED.source_pref;


-- ── Layers B and C: generated per market from templates ────────────────────
-- Written as a cross join rather than 100 literal rows so that adding a market
-- or a footprint stays a one-line change instead of a transcription exercise.
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
-- tpl_lang NULL = applies to every market; otherwise only to matching language.
templates(layer, tpl, tpl_lang) AS (
  VALUES
    -- Layer B — publisher / monetisation intent: who SELLS ad inventory
    ('B', 'sports website advertise with us {geo}',      NULL),
    ('B', 'media kit sports {geo} advertising rates',    NULL),
    ('B', 'sponsored post betting blog {geo}',           NULL),
    ('B', 'regie publicitaire sport {geo}',              'fr'),
    ('B', 'kit media site sport {geo}',                  'fr'),
    -- Layer C — affiliate footprints: the phrases affiliates are obliged to print
    ('C', '"affiliate disclosure" betting {geo}',        NULL),
    ('C', '"we may earn a commission" betting {geo}',    NULL),
    ('C', '"liens affilies" paris sportifs {geo}',       'fr'),
    ('C', 'best betting sites {geo} review comparison',  NULL)
)
INSERT INTO public.keywords (preset, layer, keyword, lang, source_pref, active)
SELECT
  m.preset,
  t.layer,
  replace(t.tpl, '{geo}', m.geo_word),
  m.lang,
  'dataforseo',   -- Google indexes corporate pages and quoted phrases; DDG does not
  TRUE
FROM markets m
JOIN templates t ON t.tpl_lang IS NULL OR t.tpl_lang = m.lang
ON CONFLICT (preset, keyword) DO UPDATE
  SET active = TRUE, archived_at = NULL, layer = EXCLUDED.layer,
      source_pref = EXCLUDED.source_pref;


-- Layers B and C predate this migration (019 seeded a pool of them) and defaulted
-- to 'ddg'. Route the whole of both layers, not just the rows added above —
-- otherwise the routing depends on which migration happened to create a keyword,
-- which is not a property anyone would ever reason about correctly.
UPDATE public.keywords
   SET source_pref = 'dataforseo'
 WHERE layer IN ('B', 'C')
   AND source_pref IS DISTINCT FROM 'dataforseo';


COMMENT ON COLUMN public.keywords.source_pref IS
  'Which search source this keyword should be sent to. Layer A rides DuckDuckGo '
  '(free, wide); layers B and C go to DataForSEO SERP because Google indexes '
  'corporate pages and exact quoted footprints far better than DDG does.';
