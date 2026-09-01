-- 052 — справочник ГЕО из PDF (194 строк)
--
-- Источник: Work_GEOs_partners1xbet_EN_-_GEOs___EN.pdf, приложен к дополнению
-- ТЗ. Разобран программно (pypdfium2), вручную не транскрибировался — ТЗ §1
-- это запрещает прямо, и не зря: строк почти две сотни, а ошибка в статусе
-- доступности превращается в обещание от лица компании.
--
-- ── Как разбирали, и почему не проще ────────────────────────────────────────
-- Таблица в PDF не размечена как таблица — это позиционированный текст. Разбор
-- по пробелам невозможен: названия стран и списки языков сами содержат пробелы.
-- Склейка символов строки по горизонтали тоже не работает — шрифт мелкий,
-- перенос внутри ячейки идёт всего в 3pt ниже основной строки, а буквы p/g/y
-- опускаются на 1-2pt, и цепочка выносных дотягивается до строки переноса.
-- Результат такой склейки — наложенные тексты вида 'SReepvSahraatree' вместо
-- 'Separate RevShare'; поймано на строке России.
--
-- Поэтому: границы колонок вычислены как пустые вертикальные коридоры самого
-- документа, границы строк — по колонке Availability, а текст каждой ячейки
-- извлечён из прямоугольника средствами pdfium, которое само соблюдает порядок
-- чтения. Отдельная поправка: длинные значения не помещаются в свою колонку и
-- вылезают левее (Confirm with manager начинается на x=47 при колонке от 63) —
-- из-за обрезки по границе колонки три страны с этим статусом сначала молча
-- выпали из выгрузки.
--
-- ── Сверка ──────────────────────────────────────────────────────────────────
-- Для каждой из 194 строк проверено, что сцепка
-- availability+geo_en+geo_ru+iso_code встречается в тексте PDF ДОСЛОВНО.
-- Несовпадений: 0. Плюс: пустых обязательных полей нет, все ISO — две заглавные
-- буквы, дублей ISO нет, суммы по регионам и статусам сходятся с общим числом.
--
-- Обновление: ТЗ просит перезаливать целиком, без diff-логики. Именно это
-- миграция и делает, поэтому она безопасна для повторного наката.

TRUNCATE public.geo_availability;

INSERT INTO public.geo_availability (geo_en, geo_ru, iso_code, region, availability, note) VALUES
  ('Abkhazia', 'Абхазия', 'AB', 'Asia', 'available', NULL),
  ('Afghanistan', 'Афганистан', 'AF', 'Asia', 'available', NULL),
  ('Albania', 'Албания', 'AL', 'Europe', 'available', NULL),
  ('Algeria', 'Алжир', 'DZ', 'Africa', 'available', NULL),
  ('Andorra', 'Андорра', 'AD', 'Europe', 'local_program_only', 'Traffic is not accepted through the main affiliate program'),
  ('Angola', 'Ангола', 'AO', 'Africa', 'available', NULL),
  ('Anguilla', 'Ангилья', 'AI', 'Americas', 'available', NULL),
  ('Argentina', 'Аргентина', 'AR', 'Americas', 'available', NULL),
  ('Armenia', 'Армения', 'AM', 'Asia', 'available', NULL),
  ('Aruba', 'Аруба', 'AW', 'Americas', 'available', NULL),
  ('Australia', 'Австралия', 'AU', 'Oceania', 'not_available', NULL),
  ('Austria', 'Австрия', 'AT', 'Europe', 'not_available', NULL),
  ('Azerbaijan', 'Азербайджан', 'AZ', 'Asia', 'available', NULL),
  ('Bahamas', 'Багамы', 'BS', 'Americas', 'available', NULL),
  ('Bahrain', 'Бахрейн', 'BH', 'Asia', 'available', NULL),
  ('Bangladesh', 'Бангладеш', 'BD', 'Asia', 'available', 'Special commission scale — confirm with manager'),
  ('Barbados', 'Барбадос', 'BB', 'Americas', 'available', NULL),
  ('Belarus', 'Беларусь', 'BY', 'Europe', 'available', NULL),
  ('Belgium', 'Бельгия', 'BE', 'Europe', 'not_available', NULL),
  ('Belize', 'Белиз', 'BZ', 'Americas', 'available', NULL),
  ('Benin', 'Бенин', 'BJ', 'Africa', 'available', NULL),
  ('Bermuda', 'Бермудские о-ва', 'BM', 'Americas', 'available', NULL),
  ('Bhutan', 'Бутан', 'BT', 'Asia', 'available', NULL),
  ('Bolivia', 'Боливия', 'BO', 'Americas', 'available', NULL),
  ('Bosnia & Herzegovina', 'Босния и Герцеговина', 'BA', 'Europe', 'not_available', NULL),
  ('Botswana', 'Ботсвана', 'BW', 'Africa', 'available', NULL),
  ('Brazil', 'Бразилия', 'BR', 'Americas', 'local_program_only', NULL),
  ('Brunei', 'Бруней', 'BN', 'Asia', 'available', NULL),
  ('Bulgaria', 'Болгария', 'BG', 'Europe', 'not_available', NULL),
  ('Burkina Faso', 'Буркина-Фасо', 'BF', 'Africa', 'available', NULL),
  ('Burundi', 'Бурунди', 'BI', 'Africa', 'available', NULL),
  ('Cambodia', 'Камбоджа', 'KH', 'Asia', 'available', NULL),
  ('Cameroon', 'Камерун', 'CM', 'Africa', 'available', NULL),
  ('Canada', 'Канада', 'CA', 'Americas', 'available', NULL),
  ('Cape Verde', 'Кабо-Верде', 'CV', 'Africa', 'available', NULL),
  ('Central African Republic', 'Центрально-Африканская Республика', 'CF', 'Africa', 'available', NULL),
  ('Chad', 'Чад', 'TD', 'Africa', 'available', NULL),
  ('Chile', 'Чили', 'CL', 'Americas', 'available', NULL),
  ('China', 'Китай', 'CN', 'Asia', 'available', 'Special commission scale — confirm with manager'),
  ('Colombia', 'Колумбия', 'CO', 'Americas', 'available', NULL),
  ('Comoros', 'Коморы', 'KM', 'Africa', 'available', NULL),
  ('Congo - Brazzaville', 'Конго - Браззавиль', 'CG', 'Africa', 'available', NULL),
  ('Congo - Kinshasa', 'Конго - Киншаса', 'CD', 'Africa', 'available', NULL),
  ('Costa Rica', 'Коста-Рика', 'CR', 'Americas', 'available', NULL),
  ('Côte d’Ivoire', 'Кот-д’Ивуар', 'CI', 'Africa', 'available', NULL),
  ('Croatia', 'Хорватия', 'HR', 'Europe', 'not_available', NULL),
  ('Cuba', 'Куба', 'CU', 'Americas', 'available', NULL),
  ('Curaçao', 'Кюрасао', 'CW', 'Americas', 'available', NULL),
  ('Cyprus', 'Кипр', 'CY', 'Asia', 'not_available', NULL),
  ('Czechia', 'Чехия', 'CZ', 'Europe', 'not_available', NULL),
  ('Denmark', 'Дания', 'DK', 'Europe', 'not_available', NULL),
  ('Djibouti', 'Джибути', 'DJ', 'Africa', 'available', NULL),
  ('Dominica', 'Доминика', 'DM', 'Americas', 'available', NULL),
  ('Dominican Republic', 'Доминиканская Республика', 'DO', 'Americas', 'available', NULL),
  ('Ecuador', 'Эквадор', 'EC', 'Americas', 'available', NULL),
  ('Egypt', 'Египет', 'EG', 'Africa', 'available', 'Special commission scale — confirm with manager'),
  ('El Salvador', 'Сальвадор', 'SV', 'Americas', 'available', NULL),
  ('Equatorial Guinea', 'Экваториальная Гвинея', 'GQ', 'Africa', 'available', NULL),
  ('Eritrea', 'Эритрея', 'ER', 'Africa', 'available', NULL),
  ('Estonia', 'Эстония', 'EE', 'Europe', 'not_available', NULL),
  ('Eswatini', 'Эсватини', 'SZ', 'Africa', 'available', NULL),
  ('Ethiopia', 'Эфиопия', 'ET', 'Africa', 'available', NULL),
  ('Fiji', 'Фиджи', 'FJ', 'Oceania', 'available', NULL),
  ('Finland', 'Финляндия', 'FI', 'Europe', 'not_available', NULL),
  ('France', 'Франция', 'FR', 'Europe', 'local_program_only', NULL),
  ('Gabon', 'Габон', 'GA', 'Africa', 'available', NULL),
  ('Gambia', 'Гамбия', 'GM', 'Africa', 'available', NULL),
  ('Georgia', 'Грузия', 'GE', 'Asia', 'available', NULL),
  ('Germany', 'Германия', 'DE', 'Europe', 'not_available', NULL),
  ('Ghana', 'Гана', 'GH', 'Africa', 'available', NULL),
  ('Greece', 'Греция', 'GR', 'Europe', 'not_available', NULL),
  ('Grenada', 'Гренада', 'GD', 'Americas', 'available', NULL),
  ('Guadeloupe', 'Гваделупа', 'GP', 'Americas', 'available', NULL),
  ('Guam', 'Гуам', 'GU', 'Oceania', 'available', NULL),
  ('Guatemala', 'Гватемала', 'GT', 'Americas', 'available', NULL),
  ('Guinea', 'Гвинея', 'GN', 'Africa', 'available', NULL),
  ('Guinea-Bissau', 'Гвинея-Бисау', 'GW', 'Africa', 'available', NULL),
  ('Guyana', 'Гайана', 'GY', 'Americas', 'available', NULL),
  ('Haiti', 'Гаити', 'HT', 'Americas', 'available', NULL),
  ('Honduras', 'Гондурас', 'HN', 'Americas', 'available', NULL),
  ('Hong Kong', 'Гонконг', 'HK', 'Asia', 'available', NULL),
  ('Hungary', 'Венгрия', 'HU', 'Europe', 'not_available', NULL),
  ('Iceland', 'Исландия', 'IS', 'Europe', 'not_available', NULL),
  ('India', 'Индия', 'IN', 'Asia', 'available', NULL),
  ('Indonesia', 'Индонезия', 'ID', 'Asia', 'available', NULL),
  ('Iran', 'Иран', 'IR', 'Asia', 'available', NULL),
  ('Iraq', 'Ирак', 'IQ', 'Asia', 'available', NULL),
  ('Ireland', 'Ирландия', 'IE', 'Europe', 'not_available', NULL),
  ('Israel', 'Израиль', 'IL', 'Asia', 'not_available', NULL),
  ('Italy', 'Италия', 'IT', 'Europe', 'local_program_only', NULL),
  ('Jamaica', 'Ямайка', 'JM', 'Americas', 'available', NULL),
  ('Japan', 'Япония', 'JP', 'Asia', 'available', NULL),
  ('Jersey', 'Джерси', 'JE', 'Europe', 'available', NULL),
  ('Jordan', 'Иордания', 'JO', 'Asia', 'available', NULL),
  ('Kazakhstan', 'Казахстан', 'KZ', 'Asia', 'available', NULL),
  ('Kenya', 'Кения', 'KE', 'Africa', 'available', NULL),
  ('Kuwait', 'Кувейт', 'KW', 'Asia', 'available', NULL),
  ('Kyrgyzstan', 'Киргизия', 'KG', 'Asia', 'available', NULL),
  ('Laos', 'Лаос', 'LA', 'Asia', 'available', NULL),
  ('Latvia', 'Латвия', 'LV', 'Europe', 'not_available', NULL),
  ('Lebanon', 'Ливан', 'LB', 'Asia', 'available', NULL),
  ('Lesotho', 'Лесото', 'LS', 'Africa', 'available', NULL),
  ('Liberia', 'Либерия', 'LR', 'Africa', 'available', NULL),
  ('Libya', 'Ливия', 'LY', 'Africa', 'available', NULL),
  ('Liechtenstein', 'Лихтенштейн', 'LI', 'Europe', 'not_available', NULL),
  ('Lithuania', 'Литва', 'LT', 'Europe', 'not_available', NULL),
  ('Luxembourg', 'Люксембург', 'LU', 'Europe', 'not_available', NULL),
  ('Macao', 'Макао', 'MO', 'Asia', 'available', NULL),
  ('Madagascar', 'Мадагаскар', 'MG', 'Africa', 'available', NULL),
  ('Malawi', 'Малави', 'MW', 'Africa', 'available', NULL),
  ('Malaysia', 'Малайзия', 'MY', 'Asia', 'available', NULL),
  ('Maldives', 'Мальдивы', 'MV', 'Asia', 'available', NULL),
  ('Mali', 'Мали', 'ML', 'Africa', 'available', NULL),
  ('Malta', 'Мальта', 'MT', 'Europe', 'not_available', NULL),
  ('Mauritania', 'Мавритания', 'MR', 'Africa', 'available', NULL),
  ('Mauritius', 'Маврикий', 'MU', 'Africa', 'available', NULL),
  ('Mayotte', 'Майотта', 'YT', 'Africa', 'available', NULL),
  ('Mexico', 'Мексика', 'MX', 'Americas', 'available', NULL),
  ('Moldova', 'Молдова', 'MD', 'Europe', 'not_available', NULL),
  ('Monaco', 'Монако', 'MC', 'Europe', 'not_available', NULL),
  ('Mongolia', 'Монголия', 'MN', 'Asia', 'available', NULL),
  ('Montenegro', 'Черногория', 'ME', 'Europe', 'not_available', NULL),
  ('Morocco', 'Марокко', 'MA', 'Africa', 'available', NULL),
  ('Mozambique', 'Мозамбик', 'MZ', 'Africa', 'available', NULL),
  ('Myanmar (Burma)', 'Мьянма (Бирма)', 'MM', 'Asia', 'available', NULL),
  ('Namibia', 'Намибия', 'NA', 'Africa', 'available', NULL),
  ('Nepal', 'Непал', 'NP', 'Asia', 'available', NULL),
  ('Netherlands', 'Нидерланды', 'NL', 'Europe', 'not_available', NULL),
  ('New Zealand', 'Новая Зеландия', 'NZ', 'Oceania', 'confirm_with_manager', NULL),
  ('Nicaragua', 'Никарагуа', 'NI', 'Americas', 'available', NULL),
  ('Niger', 'Нигер', 'NE', 'Africa', 'available', NULL),
  ('Nigeria', 'Нигерия', 'NG', 'Africa', 'available', NULL),
  ('North Korea', 'КНДР', 'KP', 'Asia', 'confirm_with_manager', NULL),
  ('North Macedonia', 'Северная Македония', 'MK', 'Europe', 'not_available', NULL),
  ('Norway', 'Норвегия', 'NO', 'Europe', 'not_available', NULL),
  ('Oman', 'Оман', 'OM', 'Asia', 'available', NULL),
  ('Pakistan', 'Пакистан', 'PK', 'Asia', 'available', NULL),
  ('Panama', 'Панама', 'PA', 'Americas', 'available', NULL),
  ('Papua New Guinea', 'Папуа — Новая Гвинея', 'PG', 'Oceania', 'available', NULL),
  ('Paraguay', 'Парагвай', 'PY', 'Americas', 'available', NULL),
  ('Peru', 'Перу', 'PE', 'Americas', 'available', NULL),
  ('Philippines', 'Филиппины', 'PH', 'Asia', 'available', NULL),
  ('Poland', 'Польша', 'PL', 'Europe', 'not_available', NULL),
  ('Portugal', 'Португалия', 'PT', 'Europe', 'local_program_only', NULL),
  ('Puerto Rico', 'Пуэрто-Рико', 'PR', 'Americas', 'available', NULL),
  ('Qatar', 'Катар', 'QA', 'Asia', 'available', NULL),
  ('Réunion', 'Реюньон', 'RE', 'Africa', 'available', NULL),
  ('Romania', 'Румыния', 'RO', 'Europe', 'not_available', NULL),
  ('Russia', 'Россия', 'RU', 'Europe', 'available', 'Separate RUB campaign; maximum RevShare — 25%'),
  ('Rwanda', 'Руанда', 'RW', 'Africa', 'available', NULL),
  ('Samoa', 'Самоа', 'WS', 'Oceania', 'available', NULL),
  ('San Marino', 'Сан-Марино', 'SM', 'Europe', 'not_available', NULL),
  ('Saudi Arabia', 'Саудовская Аравия', 'SA', 'Asia', 'available', NULL),
  ('Senegal', 'Сенегал', 'SN', 'Africa', 'available', NULL),
  ('Serbia', 'Сербия', 'RS', 'Europe', 'local_program_only', NULL),
  ('Sierra Leone', 'Сьерра-Леоне', 'SL', 'Africa', 'available', NULL),
  ('Singapore', 'Сингапур', 'SG', 'Asia', 'available', NULL),
  ('Slovakia', 'Словакия', 'SK', 'Europe', 'not_available', NULL),
  ('Slovenia', 'Словения', 'SI', 'Europe', 'not_available', NULL),
  ('Solomon Islands', 'Соломоновы о-ва', 'SB', 'Oceania', 'available', NULL),
  ('Somalia', 'Сомали', 'SO', 'Africa', 'available', NULL),
  ('South Africa', 'Южно-Африканская Республика', 'ZA', 'Africa', 'available', NULL),
  ('South Korea', 'Республика Корея', 'KR', 'Asia', 'available', NULL),
  ('South Ossetia', 'Южная Осетия', 'OS', 'Asia', 'available', NULL),
  ('South Sudan', 'Южный Судан', 'SS', 'Africa', 'available', NULL),
  ('Spain', 'Испания', 'ES', 'Europe', 'local_program_only', NULL),
  ('Sri Lanka', 'Шри-Ланка', 'LK', 'Asia', 'available', NULL),
  ('St. Helena', 'о-в Св. Елены', 'SH', 'Africa', 'available', NULL),
  ('Sudan', 'Судан', 'SD', 'Africa', 'available', NULL),
  ('Suriname', 'Суринам', 'SR', 'Americas', 'available', NULL),
  ('Sweden', 'Швеция', 'SE', 'Europe', 'not_available', NULL),
  ('Switzerland', 'Швейцария', 'CH', 'Europe', 'not_available', NULL),
  ('Syria', 'Сирия', 'SY', 'Asia', 'available', NULL),
  ('Taiwan', 'Тайвань', 'TW', 'Asia', 'available', NULL),
  ('Tajikistan', 'Таджикистан', 'TJ', 'Asia', 'available', NULL),
  ('Tanzania', 'Танзания', 'TZ', 'Africa', 'available', NULL),
  ('Thailand', 'Таиланд', 'TH', 'Asia', 'available', NULL),
  ('Togo', 'Того', 'TG', 'Africa', 'available', NULL),
  ('Tokelau', 'Токелау', 'TK', 'Oceania', 'available', NULL),
  ('Tunisia', 'Тунис', 'TN', 'Africa', 'available', NULL),
  ('Türkiye', 'Турция', 'TR', 'Asia', 'available', NULL),
  ('Turkmenistan', 'Туркменистан', 'TM', 'Asia', 'available', NULL),
  ('Uganda', 'Уганда', 'UG', 'Africa', 'available', NULL),
  ('Ukraine', 'Украина', 'UA', 'Europe', 'confirm_with_manager', NULL),
  ('United Arab Emirates', 'ОАЭ', 'AE', 'Asia', 'available', NULL),
  ('United Kingdom', 'Великобритания', 'GB', 'Europe', 'not_available', NULL),
  ('United States', 'Соединенные Штаты', 'US', 'Americas', 'not_available', NULL),
  ('Uruguay', 'Уругвай', 'UY', 'Americas', 'available', NULL),
  ('Uzbekistan', 'Узбекистан', 'UZ', 'Asia', 'available', 'Special commission scale — confirm with manager'),
  ('Venezuela', 'Венесуэла', 'VE', 'Americas', 'available', NULL),
  ('Vietnam', 'Вьетнам', 'VN', 'Asia', 'available', NULL),
  ('Yemen', 'Йемен', 'YE', 'Asia', 'available', NULL),
  ('Zambia', 'Замбия', 'ZM', 'Africa', 'available', NULL),
  ('Zimbabwe', 'Зимбабве', 'ZW', 'Africa', 'available', NULL);

-- ── Проверка ────────────────────────────────────────────────────────────────
DO $$
DECLARE n INT; bad INT;
BEGIN
  SELECT count(*) INTO n FROM public.geo_availability;
  IF n <> 194 THEN
    RAISE EXCEPTION 'ожидалось 194 строк справочника, в таблице %', n;
  END IF;

  SELECT count(*) INTO bad FROM public.geo_availability
   WHERE availability NOT IN ('available','not_available','local_program_only','confirm_with_manager');
  IF bad > 0 THEN
    RAISE EXCEPTION '% строк с неизвестным статусом — бот не знает, как их формулировать', bad;
  END IF;

  SELECT count(*) INTO bad FROM public.geo_availability
   WHERE coalesce(geo_en,'')='' OR coalesce(geo_ru,'')='' OR coalesce(iso_code,'')='' OR coalesce(region,'')='';
  IF bad > 0 THEN RAISE EXCEPTION '% строк с пустыми обязательными полями', bad; END IF;

  -- Синонимы, указывающие в пустоту, — тихая поломка: «UAE» просто не найдётся.
  SELECT count(*) INTO bad FROM public.geo_aliases a
   WHERE NOT EXISTS (SELECT 1 FROM public.geo_availability g
                      WHERE lower(g.iso_code) = lower(a.iso_code));
  IF bad > 0 THEN RAISE EXCEPTION '% синонимов ссылаются на отсутствующий ISO-код', bad; END IF;

  RAISE NOTICE 'справочник ГЕО: % строк, синонимы разрешаются', n;
END $$;
