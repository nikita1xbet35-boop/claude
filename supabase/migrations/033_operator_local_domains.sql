-- 033 — операторские локальные домены, пойманные на живой отправке
--
-- За 48 часов бренд-модуль отправил письма на sportpesa.co.za, meridian.bet и
-- getsportpesa.com. Первые два — сайты самих операторов: sportpesa.co.za это
-- южноафриканская версия SportPesa, meridian.bet — MeridianBet целиком в домене
-- плюс TLD. Эвристика зеркал их пропустила (в коде это уже исправлено), но
-- явный список надёжнее эвристики, поэтому фиксируем и его.
--
-- Операторы держат по одному домену на рынок, так что дописываем не только
-- пойманные, а весь ряд ccTLD-версий брендов, которые модуль уже ищет.

INSERT INTO public.official_domains (domain, brand, note) VALUES
  -- SportPesa: пойман sportpesa.co.za, остальное тот же ряд
  ('sportpesa.co.za','SportPesa','локальная версия оператора'),
  ('sportpesa.co.ke','SportPesa','локальная версия оператора'),
  ('sportpesa.co.tz','SportPesa','локальная версия оператора'),
  ('getsportpesa.com','SportPesa','домен оператора (редирект)'),
  -- MeridianBet: бренд разрезан доменом и TLD
  ('meridian.bet','MeridianBet','домен оператора'),
  ('meridianbet.co.tz','MeridianBet','локальная версия оператора'),
  ('meridianbet.ng','MeridianBet','локальная версия оператора'),
  -- Тот же ряд у остальных операторов, которых мы уже перехватываем
  ('betpawa.co.ke','betPawa','локальная версия оператора'),
  ('betpawa.co.tz','betPawa','локальная версия оператора'),
  ('betpawa.ng','betPawa','локальная версия оператора'),
  ('betpawa.ug','betPawa','локальная версия оператора'),
  ('odibets.co.ke','Odibets','локальная версия оператора'),
  ('betway.co.ke','Betway','локальная версия оператора'),
  ('betway.co.za','Betway','локальная версия оператора'),
  ('betway.com.gh','Betway','локальная версия оператора'),
  ('bet9ja.com','Bet9ja','домен оператора'),
  ('sportybet.com','SportyBet','домен оператора'),
  ('merrybet.com','MerryBet','домен оператора'),
  ('dafabet.com','Dafabet','домен оператора'),
  ('rajabets.com','Rajabets','домен оператора'),
  ('linebet.ng','Linebet','наш оператор, локальная версия')
ON CONFLICT (domain) DO NOTHING;

-- Сайты-отзовики отсекаются на этапе поиска (GLOBAL_SKIP в brand-search), потому
-- что их вообще не нужно сохранять: они ранжируются по «<бренд> official site»
-- ровно потому, что там проверяют бренды, и партнёрского трафика не продают.
-- scamadviser.com получил от нас настоящее письмо по «merrybet official site».
-- Здесь дублируем только адресную часть — если контакт на чужом домене окажется
-- их почтой, письмо тоже не уйдёт.
INSERT INTO public.registrar_domains (domain, note) VALUES
  ('scamadviser.com','отзовик, не партнёр'),
  ('sitejabber.com','отзовик, не партнёр'),
  ('trustpilot.com','отзовик, не партнёр'),
  ('similarweb.com','аналитика, не партнёр'),
  ('semrush.com','аналитика, не партнёр'),
  ('ahrefs.com','аналитика, не партнёр')
ON CONFLICT (domain) DO NOTHING;

-- Уже сохранённые лиды на этих доменах убираем из отправки задним числом:
-- в очереди они могут стоять прямо сейчас.
UPDATE public.leads l
   SET suspected_official = TRUE,
       suspected_reason    = COALESCE(suspected_reason, 'официальный домен оператора (список 033)'),
       exclude_reason      = COALESCE(exclude_reason, 'suspected_official')
 WHERE l.pipeline = 'brand'
   AND EXISTS (SELECT 1 FROM public.official_domains o
                WHERE o.domain = l.domain_normalized);

DELETE FROM public.send_queue q
 WHERE q.pipeline = 'brand' AND q.status = 'pending'
   AND EXISTS (SELECT 1 FROM public.leads l
                WHERE l.id = q.lead_id AND l.suspected_official);
