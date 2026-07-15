-- Migration 009: seed the 888starz partner base (Africa) + add source/ext_id cols
-- Idempotent: ON CONFLICT DO NOTHING never clobbers operator edits.

ALTER TABLE public.partner_leads ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE public.partner_leads ADD COLUMN IF NOT EXISTS ext_id text;

INSERT INTO public.partner_bases (name, daily_limit, sending_enabled)
VALUES ('888starz', 20, false) ON CONFLICT (name) DO NOTHING;

INSERT INTO public.partner_leads
  (base_id, base_name, ext_id, contact, email, source, geo, promocode, vertical, language, approach, deal_type, deal_terms, status)
VALUES
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3411580', NULL, 'kipngetichvictor060@gmail.com', 'https://t.me/kipngetichtips', 'KE', 'KIPNGETICH', 'sport', 'English', 'вежливый', 'RS', '40%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3431264', '@megaadmiin1', 'amrshafie2018@gmail.com', 'https://t.me/+2xcwC6stOto5Yzdk', 'EG', 'MORGAN3', 'betting', 'Арабский', 'открытый', 'CPA', '20/5/5', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3432253', '@Jal0m', 'wasonfefum@gmail.com', 'https://www.instagram.com/nickolson_official?igsh=d2hpbG5rdTMxZmV1', 'CG', '~Ringgit / Manat', 'Sport/casino', 'English', 'открытый', 'RS', '40%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3430816', '@Ghostmoney10', 'mariorabid6@gmail.com', 'https://t.me/+7pnaDZMk2CU1NWRk', 'EG', 'ASD4', 'betting', 'Арабский', 'открытый', 'Hybrid', '25%rs + cpa 10/2/2', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3433072', '212 637-064292 @Khalid0000000000000000000', 'khalidahrik333@gmail.com', 'https://facebook.com/groups/168683918359593/', 'MA', NULL, 'betting', 'Арабский', 'властный', 'RS', '30% RS + Mobcash', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3420304', '@bigman2370', 'travauxdirigeparbigman@gmail.com', 'https://t.me/EmilyinparisNetfli', 'CM', NULL, 'sport', 'English', 'вежливый', 'RS', '25%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3432947', '@Vuki09', 'tobemlodan@gmail.com', 'https://t.me/KingNadalPro', 'CM', NULL, 'sport', 'English', 'открытый', 'RS', '30%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '1894069', '@Gauloueder', 'gaultir@gmail.com', 'https://t.me/+Z5iAMjZSBRQ4M2Jk', 'BF', 'OTG7', 'sport', 'English', 'вежливый', 'RS', '30%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3433659', '@melbet_asma', 'islamdjeffal96@gmail.com', 'https://t.me/ASMA99ASMA99', 'MA', NULL, 'betting', 'Арабский', 'властный', 'CPA', 'CPA 20/7/14 hold_14
Мы не принимаем фейковых игроков или мультиаккаунты.
Выплаты производятся только за игроков, которые делают повторные депозиты.
Выплаты не производятся за неактивных игроков.', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3432961', '@nickyo6', 'vusodsetaw@gmail.com', 'https://www.instagram.com/nic.ky3262?igsh=MXI5cGFpMGpqdmx4NQ==', 'CG', 'Lexor', 'betting', 'English', 'вежливый', 'RS', '40%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3434788', NULL, 'trexlegendary0@gmail.com', 'https://chat.whatsapp.com/LsBAfXGsayX0sgsTNPiEPS', 'ZM', NULL, 'sport', 'English', 'открытый', 'RS', '40%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3434829', '@melbet_33', 'etberalince@gmail.com', 'https://t.me/couponsfiablefr', 'CM', NULL, 'sport', 'English', 'открытый', 'RS', '30%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3361096', '@Promobet2', 'mnlneville@gmail.com', 'https://t.me/dachivideos12', 'CI', 'BLACKBET96', 'betting', 'Английский', 'открытый', 'RS', '30%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3435463', '@Saviourr1', 'chibwesaviour7@gmail.com', 'https://t.me/+fNpPHW__jQEyNTU0', 'ZM', 'SAVIOUR', 'sport', 'English', 'открытый', 'Fix', 'Fixed pay $180 ($90 pay upfront, $90 after KPIs are met) KPI - 40ftd', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@Ricworldwide', 'bossmorgan673@gmail.com', 'https://www.facebook.com/share/16aPMbkhu8/?mibextid=wwXIfr', 'ZM', NULL, 'both', 'English', 'дружеский', 'Fix', '300$ (200$pre 100$post)', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3435374', '@hgjtxb', 'mohamedawees722@gmail.com', 'https://t.me/hfhgfjhv', 'EG', 'TU11', 'betting', 'Арабский', 'открытый', 'Hybrid', 'CPA 10$/2/2 + рс 25%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3435624', '@DERBY80', 'ahmedielverick@gmail.com', 'https://t.me/+FrlkuPH2zCBjNDk0', 'EG', 'DAH19', 'betting', 'Арабский', 'вежливый', 'CPA', 'CPA 10/3/6 hold_14

Мы не принимаем поддельных игроков и мультиаккаунты.
Выплаты происходят только за игроков, которые сделали повторный депозит.
Все игроки должны быть зарегистрированы  с помощью наших приложений Android/IOS.
Мы не платим за неактивных игроков.', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3439893', '@Bsadamdhat', 'medhatashak389@gmail.com', 'https://www.facebook.com/share/197TzFFZGS/', 'EG', 'MA12', 'betting', 'Арабский', 'деловой', 'CPA', 'CPA 15/3/3 hold_14

Мы не принимаем поддельных игроков и мультиаккаунты.
Выплаты происходят только за игроков, которые сделали повторный депозит.
Все игроки должны быть зарегистрированы  с помощью наших приложений Android/IOS.
Мы не платим за неактивных игроков.', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3440388', '-', 'mursadijamadali06@gmail.com', 'https://x.com/mursadi31549757?t=v6aS8QIaJEbQYopy-xn7KA&s=09', 'TZ', 'MURSADI', 'sport', 'English', 'вежливый', 'RS', 'rs40%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3438138', '@sonyybo', 'gudmorning79@gmail.com', 'https://www.facebook.com/yegon.166500?mibextid=ZbWKwL', 'SN', NULL, 'sport', 'English', 'вежливый', 'Fix', '200$ - 50% prepayment and 50%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3440013', '@Winwin_mana', 'vdff3005@gmail.com', 'https://www.facebook.com/groups/2927937290834104/?ref=share&mibextid=NSMWBT', 'MA', NULL, 'sport', 'English', 'открытый', 'RS', '30%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3440036', '@Gorge239', 'gdgg6282@gmail.com', 'https://t.me/winwinofficiale', 'SN', NULL, 'sport', 'English', 'деловой', 'RS', '25$', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3438731', '@Kylian005', 'edira005@gmail.com', 'https://www.facebook.com/profile.php?id=100091780694033', 'BI', 'IR007', 'betting', 'Французский', 'открытый', 'CPA', 'CPA 8$/ bl 2$ / wg х2', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3434015', '@ey794_David', 'mydhbcr.86@gmail.com', 'FB', 'EG', NULL, 'betting', 'Арабский', 'властный', 'RS', '25% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3441301', '@madon47', 'samirlaouani2017@gmail.com', 'https://www.instagram.com/soold.ma https://t.me/madon69', 'MA', NULL, 'betting', 'Арабский', 'вежливый', 'RS', '40% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3435985', '@HTTl9', 'ibrahiemmohamed561@gmail.com', 'https://t.me/fhdgdhjj', 'EG', NULL, 'betting', 'Арабский', 'властный', 'RS', '25% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3442949', '@dogtipsadmin1', 'brianhamisi225@gmail.com', 'https://t.me/dogtips1', 'KE', 'SAILOR', 'sport', 'English', 'вежливый', 'RS', '40%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3442815', '@Toxicpunter1', 'toxicpunter247@gmail.com', 'https://t.me/wfokeyodd', 'NG', 'TOXICPUNTER', 'sport', 'English', 'вежливый', 'RS', '40%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3443296', '@HillaryN', 'hillarynjenga225@gmail.com', 'https://www.facebook.com/profile.php?id=61558738972286', 'KE', 'HILARY254', 'sport', 'English', 'вежливый', 'RS', '40%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3438259', 'tel:+22594003399', 'seeramo225@gmail.com', 'https://www.facebook.com/share/19J1kq6Q8f/', 'CI', 'NSR225', 'betting', 'Французский', 'деловой', 'CPA', 'CPA 10/3/3 hold_14', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3443385', '@andydivane', 'sentaptap7@gmail.com', 'https://t.me/hadangercanal', 'CM', 'ODDSPALACE', 'SPORT', 'English', 'вежливый', 'RS', '40%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3437515', '@asanogo01', 'sanservice6@gmail.com', 'https://t.me/sann_prono', 'CI', 'AZEN24', NULL, 'Французский', 'открытый', 'RS', '35% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3444266', '@Aaarof', 'aaarf423@gmail.com', 'https://youtube.com/@alona777-m7c?si=bog4thZFsqwJT0Mh 
https://youtube.com/@acadmy-p8s?si=tkMKSDWlmmRuZhmp', 'EG', NULL, 'crash', 'Арабский', 'вежливый', 'CPA', '25% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3434976', '@SPartner_Manager_1', 'kerooooo2023@gmail.com', 'https://t.me/MelbetTeamCashAgents 
https://www.facebook.com/share/1ArAq6oewR/', 'EG', NULL, 'betting', 'Арабский', 'дружеский', 'RS', '25% RS + Mobcash (без кнопки)', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3434798', '@promo_pronostic', 'tchoffojordan84@gmail.com', 'https://t.me/matador201010', 'CM', NULL, 'betting', 'English', 'открытый', 'RS', '25%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3445989', '@lediplomateMETA17', 'newtonienne17@gmail.com', 'https://chat.whatsapp.com/KILJl7b3GCeAsPulWMeT9k', 'TG', 'REX17', 'betting', 'Французский', 'открытый', 'RS', 'RS 35%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@antonio_wildin', 'antonnyowuor@gmail.com', 'https://t.me/DrGamblingX', 'KE', NULL, 'betting', 'English', 'вежливый', NULL, 'waiting', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, NULL, 'skipinafrika@gmail.com', NULL, 'KE', NULL, NULL, NULL, NULL, NULL, NULL, 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@Jay_den67', 'owinohgerald7@gmail.com', 'https://t.me/+7noS-AlbwRsxMjFk', 'KE', NULL, 'betting', 'English', 'открытый', 'Fix', 'negotiation till tomorrow', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3440319', '@ivanofficiel', 'mancool33445566@gmail.com', 'https://t.me/tuivoivanprono', 'NG', NULL, 'sport', 'English', 'вежливый', 'RS', '40%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3437041', 'tel:+22589446400', 'koffifranckkoffi929@gmail.com', 'https://chat.whatsapp.com/DuIgJGkvptqBnEM0qIRco7', 'CI', 'KOFFA225', 'sport', 'Французский', 'открытый', 'RS', '30%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3444575', '25761535839', 'martinnduwimana200@gmail.com', 'https://chat.whatsapp.com/IW3oJCHJLzP9WVMScBdsOW', 'BI', 'YORA10', 'betting', 'Французский', 'деловой', 'RS', '25%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@KenneTipstar', 'kennedybarasasifuna@gmail.com', 'https://twitter.com/pesa_odds?t=3Wbx2sNricpWIFzB_Ir7fw&s=09', 'KE', NULL, 'sport', 'English', 'деловой', 'Fix', '300$ baseline 5$ wager 2, 70ftd and the profits should be like 150000kes+', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@OkaroniCastro', 'fedelis.okaroni@gmail.com', 'https://t.me/+yexvSNeUMfozMjdk', 'KE', NULL, 'sport', 'English', 'нервный', 'Fix', 'negotiation till tomorrow', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3446778', '@betaaa', 'victorkiprotich171@gmail.com', 'https://www.facebook.com/konte.chizi.wa.marakwet', 'KE', NULL, 'sport', 'English', 'открытый', 'RS', '40%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3446768', '@ethan01', 'ngolepus1845@gmail.com', 'https://t.me/+6XVyQ220m0g5M2M0', 'KE', NULL, 'sport', 'English', 'открытый', 'RS', '40%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3447012', '@forealsaad', 'elmouttakisaad0@gmail.com', 'https://youtube.com/@dinobet?si=qv3CGaqg_zrZg_b0', 'MA', NULL, 'crash', 'Арабский', 'властный', 'RS', '30% RS + 5% subreff', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3444652', 'tel:+25776581405', 'nsengimanaalexandre0@gmail.com', 'https://t.me/+_WiowUPQ9m01OTM0', 'BI', 'Great31', 'betting', 'Французский', 'открытый', 'RS', '30%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3441604', 'tel:+22960314422', 'cirusvictorien@gmail.com', 'https://chat.whatsapp.com/IWB3nNNdAtvBHAaSyY8i0e', 'BJ', '8PERO', 'betting', 'Французский', 'открытый', 'RS', '30%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3448351', '@Owish1', 'osamorreagan@gmail.com', 'https://t.me/+7noS-AlbwRsxMjFk', 'KE', NULL, 'betting', 'English', 'деловой', 'Hybrid', '50$+RS30% (50/50)', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3447461', '@Fofoiradu', 'noellaikorivyiza@gmail.com', 'https://www.facebook.com/profile.php?id=100076043102847', 'BI', 'TSINDA1X', 'betting', 'Французский', 'открытый', 'RS', '30%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3449427', '212710684375 @molagimes', 'molagimes480@gmail.com', 'LM', 'MA', NULL, '-', 'Английский', 'властный', 'RS', '5% subreff', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3447946', '257 72 47 62 40', 'fbitangimana@gmail.com', 'https://www.facebook.com/share/1AgNUgMeNP/', 'BI', 'WORKER1', 'betting', 'Французский', 'вежливый', 'RS', '25%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3448958', 'tel:+25771187765', 'fabricendayikeje@gmail.com', 'https://www.facebook.com/fabrefabrice.ndayikejendayi?mibextid=ZbWKwL', 'BI', 'RICHMAN1', 'betting', 'Французский', 'открытый', 'RS', '30%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3453254', '@X1_BET_X1', 'youssefehab31y@gmail.com', 'https://t.me/X7_BET_1X  https://t.me/+XW0akRlYcuk1MjA0', 'EG', 'VIP7D', 'betting', 'Арабский', 'вежливый', 'RS', '25%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3433973', '@elka741', 'desirekabore741@gmail.com', 'https://www.facebook.com/share/1BnnAc47Sn/', 'BF', 'M100S, BRO226', 'betting', 'Французский', 'вежливый', 'RS', '35%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3450714', '@OMOLI', 'derickomoke2@gmail.com', 'https://t.me/tt_k_hy_4477palm', 'KE', 'THUNDER', 'sport', 'English', 'открытый', 'Hybrid', '70%+RS30%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3451592', '@Saah400', 'th880204@gmail.com', 'https://www.facebook.com/coupons.de.parie', 'CM', NULL, 'both', 'English', 'вежливый', 'RS', '25%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3451635', '@Manabiy', 'topasmomo@gmail.com', 'https://www.promotionnalcodes.com/', 'CM', 'Bbc30', 'sport', 'English', 'открытый', 'RS', '35%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3452116', 'tel:+22541959568', 'momoledegameur@gmail.com', 'https://www.facebook.com/share/v/1HrrpEypMH/?mibextid=wwXIfr', 'CI', 'LES01', 'sport', 'Французский', 'деловой', 'Fix', 'RS 0% + 400$ (200$ предоплата и 200$ оплата при достижении планки в 100 ftd и 2000$ новых депозитов)', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3457744', '@Nisobet', 'mohaminebet@gmail.com', 'https://t.me/Niso_bet', 'MA', 'LMT100', 'betting', 'Арабский', 'властный', 'RS', '30% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3444266', '201289976981 @D_wle', 'gmrwf966@gmail.com', 'https://t.me/+8i_wAR26mcI5NzY0', 'EG', 'DWL66', 'betting', 'Арабский', 'дружеский', 'CPA', 'CPA 15/3/3 hold_14

Мы не принимаем поддельных игроков и мультиаккаунты.
Выплаты происходят только за игроков, которые сделали повторный депозит.
Все игроки должны быть зарегистрированы  с помощью наших приложений Android/IOS.
Мы не платим за неактивных игроков.', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3457307', '@camilleas', 'duxmaxence@gmail.com', 'лм', 'CI', NULL, 'betting', 'Французский', 'деловой', 'Fix', '1 за 1 фтд', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3458341', 'tel:+22579519408', 'kennbreck770@gmail.com', 'https://www.facebook.com/kobobouabedjai
https://www.tiktok.com/@mrkennofficiel1?_t=ZM-8xRUEsxpoE2&_r=1
https://www.youtube.com/channel/UCKwGfqgmwsLyuN27JUdM6ng', 'CI', 'KENN1', 'betting', 'Французский', 'деловой', 'Fix', 'RS 0% + 400$ (200$ предоплата и 200$ оплата при достижении планки в 100 ftd и 2000$ новых депозитов, при перевыполнении планки оплата 250$)', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@Otibrown', 'batungwanayoothiniel@gmail.com', 'лм', 'CI', NULL, 'betting', 'Французский', 'деловой', 'Fix', '1 за 1 фтд', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3452394', 'tel:+2250585405012', 'donkpeganinnocendrine@gmail.com', 'https://facebook.com/groups/47682l087008069/', 'CI', '888SANOGO', 'betting', 'Французский', 'деловой', 'RS', '30%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3456363', '@Championbets254', '123championbets@gmail.com', 'https://t.me/+TrMsQzfXpwA5N2Y8 https://x.com/123Championbet?t=3rQnNjYlOj79IyqsEDnY0A&s=09', 'KE', 'CHAMPKE', 'sport', 'English', 'открытый', 'Fix', '100$', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3453238', '@Moutirene', 'renemouti@gmail.com', 'https://www.facebook.com/rene.mouti', 'CI', 'RM1010', 'betting', 'Французский', 'открытый', 'RS', '35%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3459684', 'https://x.com/Tekashke?t=euRcU3EIBV9UsyC1o4Nu6Q&s=09', 'briankipkirui7780@gmail.com', 'https://chat.whatsapp.com/E8l3IoVXB3ZIWKuqhH5wyW https://www.facebook.com/tekashi.ke.69235', 'KE', 'CHAT', 'sport', 'English', 'вежливый', 'RS', '40%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3452539', 'tel:+2250546206346', 'konanyannick749@gmail.com', 'https://www.facebook.com/timite.yann', 'CI', 'AC50', 'betting', 'Французский', 'открытый', 'RS', '30%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@letomcj5', 'winterdell87@gmail.com', 'https://t.me/+EzxnukOB7cUxNGI0', 'CM', NULL, 'betting', 'Французский', 'открытый', 'RS', '25%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@asiaabet', 'kaporelchef08@gmail.com', 'https://www.facebook.com/share/1GHkQaWTsW/?mibextid=wwXIfr', 'CM', NULL, 'betting', 'Французский', 'открытый', 'RS', '25%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3460846', '3453238', 'wassimbet711@gmail.com', 'https://t.me/WassimGambling 
https://www.instagram.com/vvassim.33?igsh=NmxrN3UwdzU3cWRx&utm_source=qr', 'MA', NULL, 'betting', 'Арабский', 'деловой', 'Hybrid', '100$ предоплата + 45% RS + Mobcash 
Если приведете 10к нью депов, то повысим RS до 50%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3462995', '@MAFYA_4', 'mohamedamr200077@gmail.com', 'https://t.me/+_TB_5eIGKcI5ODNk 
https://t.me/M_A_F_Y_A_1 
https://t.me/xpolice_ban2', 'EG', NULL, 'crash', 'Арабский', 'властный', 'CPA', 'CPA 10/2/2 hold_14

Мы не принимаем поддельных игроков и мультиаккаунты.
Выплаты происходят только за игроков, которые сделали повторный депозит.
Все игроки должны быть зарегистрированы  с помощью наших приложений Android/IOS.
Мы не платим за неактивных игроков.', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3459047', '@Gestionairedescomptes', 'cedricochoco11@gmail.com', 'https://t.me/+1BfYLF7y7oRlMDc0', 'BJ', 'CHOCO229', 'betting', 'Французский', 'вежливый', 'RS', '30%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@wiz_muga', 'd4229048@gmail.com', 'https://chat.whatsapp.com/Ee8zav31WS20B6KYlaQc02
https://t.me/pronostic_winwin', 'BI', NULL, 'betting', 'Французский', 'открытый', 'RS', '25%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3459820', 'tel:+237695850581', 'mariuskameni69@gmail.com', 'https://t.me/KaKLiLVGUxthYjY0
https://chat.whatsapp.com/D7g1RTYU42rJzhkLCREhr8', 'CM', '3YAMAL', 'betting', 'Французский', 'открытый', 'RS', '30%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3462252', 'tel:+2290140330526', 'sbourandi23@gmail.com', 'https://chat.whatsapp.com/BbsaQ4HdIjwAKTjrFSXC6u', 'BJ', 'SAME50', 'betting', 'Французский', 'деловой', 'RS', '25%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3463770', '243855579844', 'maxmatis40@gmail.com', 'https://whatsapp.com/channel/0029VaDVRxCInlqGzaUnnq3e', 'CD', 'DUX99', 'betting', 'Французский', 'деловой', 'RS', '40%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3466557', '@Novaprono1', 'yimdyouedraogo1@gmail.com', 'https://t.me/Nova1xbet', 'CI', 'L2233', 'betting', 'Французский', 'деловой', 'RS', '30%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3463374', '237675957402', 'leaderpronostics@gmail.com', 'https://chat.whatsapp.com/LCTgp2G97aqEev6S0dsZJ8', 'CM', 'DZ400', 'betting', 'Французский', 'деловой', 'RS', '35%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3460471', 'tel:+237694181273', 'ulriebita11@gmail.com', 'https://chat.whatsapp.com/DoQ3LOiTtL3ID6xpsrjeYE', 'CM', 'ACTUFOOT237', 'betting', 'Французский', 'открытый', 'RS', '25%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3460577', 'tel:+22664611266', 'abdulkabore36@gmail.com', 'https://t.me/hfkklnvklk', 'BF', 'K98', 'betting', 'Французский', 'открытый', 'RS', '25%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3468756', '@ornelebarca', 'kallongornele@gmail.com', 'https://www.facebook.com/share/19L2FTeMFk/?mibextid=wwXIfr
https://t.me/+_iACwS0PrXhjYzk0
https://www.tiktok.com/@ornelebarca?_t=ZM-8xYeG1bTRhQ&_r=1', 'CM', 'ORNELE222', 'betting', 'Французский', 'деловой', 'RS', '40%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3469147', '@dopeboyt', 'wandafout44@gmail.com', 'https://t.me/+DdTaDkA2sAQ0YzZk', 'BJ', NULL, 'sport', 'English', 'открытый', 'RS', '25%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3469223', '@Grdamakpe', 'justinamankpe8@gmail.com', 'https://youtu.be/6SZ5E4hyQJA
https://chat.whatsapp.com/DsJnpMFbYydJ65860TMuI1
https://chat.whatsapp.com/HvfiJMbXc7A1KeaaeiC2Bg
https://chat.whatsapp.com/IzbVQsATJeAAIFtJy5K7tW
https://chat.whatsapp.com/I2YEZTTDL6lHN0tBA6YspH
https://chat.whatsapp.com/FN1GzkFME3g0os5zuwIg3H
https://chat.whatsapp.com/GZxA3ueUnYAIriiyowx813
https://chat.whatsapp.com/DopAt7ghGLgCc7ezISvAJQ
https://chat.whatsapp.com/I2XM2k3uaTxL21cSujC8LB
https://chat.whatsapp.com/Bniok65g8laBf9KeUs4Nky
https://chat.whatsapp.com/GPNTwiZjaJm9paJ9pbsJsW
https://chat.whatsapp.com/FrKxCQJeMOdHQzPFtbfmdE
https://chat.whatsapp.com/DIKjcNxXdNjEclEMCic71a
https://chat.whatsapp.com/EXuQLt0x41u31YnH3IrcaF
https://chat.whatsapp.com/DvX5zD4bx2jAj09lZ6Xo6Q
https://chat.whatsapp.com/FROyt60AEyg8a99IaOjM56
https://chat.whatsapp.com/BloDS9mpBH0FX3bwkdIbjU
https://chat.whatsapp.com/CSEuXS9oBc28UprmuMkMmD
https://chat.whatsapp.com/BjMuyWgPzgv4m0P5pzRrc5
https://chat.whatsapp.com/LjhO6wAPOpd8w5EgfrlzT9', 'BJ', 'RAS12', 'betting', 'Французский', 'деловой', 'RS', '45%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3458352', 'tel:+25761682814', 'kevinirakoze73@gmail.com', 'https://www.facebook.com/profile.php?id=100071811227633', 'BI', 'MITUKU1', 'betting', 'Французский', 'открытый', 'RS', '30%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3473742', 'tel:+237681887640', 'uoam4268@gmail.com', 'https://t.me/Solo_Leveling_S1_VF', 'CM', 'Ht225
Y221
Ahh1', 'betting', 'Французский', 'открытый', 'RS', '25%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3470230', '@baf72', 'yves23727@gmail.com', 'https://chat.whatsapp.com/KWRlpkIZAiqF8p28sXJ5Ur?mode=r_t
https://chat.whatsapp.com/BY1QZNiSe334ZcCCYdferG?mode=r_t
https://chat.whatsapp.com/K3lPYNVhm8EIOiaG0PJuQu?mode=r_t
https://chat.whatsapp.com/BBw8Or6G8plG8YpTkijtFr?mode=r_t', 'BJ', 'BAF72', 'betting', 'Французский', 'деловой', 'RS', '35%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, 'tel:+237679778428', 'ayanloko17@gmail.com', 'https://chat.whatsapp.com/Ey2bXgXpQhj9saKgyXO4LS', 'CM', NULL, 'betting', 'Французский', 'открытый', 'RS', '25%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3463582', '@YASINO10', 'zoumiganayda@gmail.com', 'https://t.me/koora110', 'MA', NULL, 'betting', 'Арабский', 'властный', 'RS', '25% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3476972', '@Emanuel622', 'mondoraschel@gmail.com', 'https://t.me/+srQQPGXlWxhjNzFk', 'multi', 'MADS1', 'betting', 'Французский', 'открытый', 'RS', '30%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3475404', 'tel:+2250170303275', 'davkonan78@gmail.com', 'https://t.me/+Ap2QJht-sgE2OTlk
https://www.facebook.com/groups/603394156192124/?ref=share&mibextid=NSMWBT', 'CI', 'NPBONUS10, DK88', 'betting', 'Французский', 'деловой', 'RS', '25%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3469235', '689669209', 'kuetetindoariol@gmail.com', 'https://chat.whatsapp.com/GywCGOd2w9t4jZMMLv8lkw
https://chat.whatsapp.com/I72wqb3GrcnIJKNeUT7ldh', 'CM', 'MAMA5, AB50, A15', 'betting', 'Французский', 'деловой', 'RS', '35%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '2505300', '@MrWilliams07', 'nelsontchinda14@gmail.com', 'https://whatsapp.com/channel/0029Vb5ZQVQFHWq23K0KJv2p', 'CM', NULL, 'betting', 'English', 'открытый', 'RS', '30%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3478035', '@JnrMalone', 'franckcruz35@gmail.com', 'https://t.me/freeallvpnsurf', 'CM', '888Sporty, Cup25, Cup55', 'betting', 'Французский', 'открытый', 'RS', '25%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3458900', '@Luffyangel', 'mikadollard@gmail.com', 'https://www.tiktok.com/@ksn_promostica?_t=ZM-8xbwjQ2KaOc&_r=1
https://www.facebook.com/bessing.hair?mibextid=LQQJ4d', 'CM', 'Taajir123
Win1234
UZB123', 'betting', 'Французский', 'открытый', 'RS', '25%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3470860', '@johnfifa1', 'partenaire1xbet2003@gmail.com', 'https://chat.whatsapp.com/HBgGVVqRd2KHkH5fU3Zri4?mode=r_t
https://chat.whatsapp.com/DR6U9PzSkVT2DEHUvA94uf?mode=r_t
https://chat.whatsapp.com/B8a4tiKVcrHGS4MOtvWIFz?mode=r_t
https://chat.whatsapp.com/LifoEhRcTCjBsm1FOlpypR?mode=r_t
https://chat.whatsapp.com/B9aB7blB1l34loWCY0wJJg?mode=r_t
https://chat.whatsapp.com/CmiQ9l3UK5PA2KC3v1mV1N?mode=r_t
https://chat.whatsapp.com/EPaxeRNRK7EK0YNtwBE8ob?mode=r_t', 'CM', 'BEL2', 'betting', 'Французский', 'деловой', 'RS', '35%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3469163', '@Didimaito', 'sinat6531@gmail.com', 'https://t.me/sololevelingsaison3vf', 'CM', NULL, 'betting', 'English', 'деловой', 'RS', '25%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3480253', '@OOREP0', 'lcdhjcsasivccx87777@gmail.com', 'https://t.me/+Ylqor76ICRxlNDk0', 'EG', NULL, 'betting', 'Арабский', 'открытый', 'CPA', 'CPA 10/3/5 hold_14

Мы не принимаем поддельных игроков и мультиаккаунты.
Выплаты происходят только за игроков, которые сделали повторный депозит.
Все игроки должны быть зарегистрированы  с помощью наших приложений Android/IOS.
Мы не платим за неактивных игроков.', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3480727', '@Denipro8', 'acylbotan@gmail.com', 'https://t.me/+2t9VCHCZH6tmOWU8', 'CM', '8CROSH', 'betting', 'English', 'открытый', 'RS', '25%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3483175', '@olise26', 'hammadsylla45@gmail.com', 'https://t.me/+zP4sIrvTUjs0NmZk', 'multi', 'Olise50', 'betting', 'Французский', 'открытый', 'RS', '30%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3483218', '@Vanick12', 'keindavanick11@gmail.com', 'https://chat.whatsapp.com/CjHft1CgZxGJDA4eWC8o3r
https://chat.whatsapp.com/CjGI6MFKf5DCy6yBGvxUTx
https://chat.whatsapp.com/EW4m9ZT434qJGTZS3ojsbk
https://chat.whatsapp.com/JZlDE9uLYpZE2ZcWTZdVD7
https://chat.whatsapp.com/BX8Tnn5req8L8RgKRLjfUa
 https://chat.whatsapp.com/DZLXFNsrmAC5gEWjf66Rbh
https://chat.whatsapp.com/LYDvGcXAVX5BNl0GoiTI2n
https://chat.whatsapp.com/EVNcRB7u5MSBFkiO01ICvw
https://chat.whatsapp.com/LRlOxgVrwypECpdMAzq7Qg', 'CM', 'GP14', 'betting', 'Французский', 'открытый', 'RS', '30%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3494479', 'tel:+25761634566', 'inzoyishima@gmail.com', 'https://chat.whatsapp.com/FoehJ0JMgakGqbNfoPfNzF', 'BI', 'WORLD25', 'betting', 'Французский', 'открытый', 'RS', '25%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3483266', '@fuckwellboy', 'nusvevenus26@gmail.com', 'https://chat.whatsapp.com/K3QpST5jVstGSCkcr4gUZt?mode=ac_t', 'CM', NULL, 'betting', 'English', 'открытый', 'RS', '25%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3483626', '@Leopro5', 'rosvellpondi@gmail.com', 'https://www.tiktok.com/@coupon2525
https://chat.whatsapp.com/LI4cSDmrsfD55YYsbbdzSw?mode=r_t', 'CM', 'Z333', 'betting', 'English', 'вежливый', 'RS', '25%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3481030', '@triding8', 'yassinerajawu207@gmail.com', 'https://t.me/saherawi1', 'MA', NULL, 'betting', 'Арабский', 'деловой', 'RS', '25% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3484516', '@𝐦𝐚𝐭𝐬𝐡𝐢𝐬𝐜𝐨', 'matshisco1@gmail.com', 'https://chat.whatsapp.com/Dl7dkE5eYAX9c2rF44aXcZ', 'CD', 'LMB10', 'betting', 'Французский', 'открытый', 'RS', '25%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3483933', 'tel:+2250748899369', 'guizess2018@gmail.com', 'https://www.facebook.com/groups/319472365124462/?ref=share&mibextid=NSMWBT', 'CI', 'Guizess47', 'betting', 'Французский', 'открытый', 'RS', '30%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3483858', '@l_dod', 'androdrakula@gmail.com', 'https://www.youtube.com/@Anoo_Elyoutyober 
https://t.me/Ano_elyoutyober', 'EG', NULL, 'crash', 'Арабский', 'вежливый', 'RS', '25% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, 'tel:+237679778428', 'loloayan8@gmail.com', 'https://chat.whatsapp.com/Ey2bXgXpQhj9saKgyXO4LS', 'CM', NULL, 'betting', 'Французский', 'открытый', 'RS', '25%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3485226', 'tel:+2250758121216', 'guillaumehounkponou7001@gmail.com', 'https://www.facebook.com/groups/3424724407651685/?ref=share&mibextid=NSMWBT', 'CI', 'VICTOIRE0758', 'betting', 'Французский', 'открытый', 'RS', '30%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3483763', 'tel:+2250747326457', 'dieudino@gmail.com', 'https://t.me/BIG1FOOT', 'CI', 'DINOFOOT1', 'betting', 'Французский', 'открытый', 'RS', '25%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3484172', 'tel:+2250501837610', 'aboubacarnassirou345@gmail.com', 'https://t.me/+G3Ny8Iw-CugxMTlk', 'CI', 'NASSIROU1', 'betting', 'Французский', 'открытый', 'RS', '25%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '2002781', '@MATAAN80', 'mataan20310@gmail.com', 'https://www.facebook.com/profile.php?id=61557382857929', 'SO', NULL, 'betting', 'English', 'вежливый', 'RS', '25% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3474831', '977326793', 'boscokandolo4@gmail.com', 'https://www.facebook.com/Bosco.Kandolo.officiel', 'CD', '𝐁𝐖𝐁36', 'betting', 'Французский', 'вежливый', 'RS', '25%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3483407', '@affilliatemanagerse', 'someomeran@gmail.com', 'https://www.tiktok.com/@lilteug225?_t=ZM-8xpNqKV0885&_r=1', 'CM', NULL, 'betting', 'English', 'открытый', 'RS', '25%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3492201', '@keums243', 'juniormaluta@icloud.com', 'https://chat.whatsapp.com/CW0pXiN2e9xDMavEk4Q7Y7', 'CD', '𝐊𝐄𝐔𝐌𝐒243', 'betting', 'Французский', 'вежливый', 'RS', '30%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3483203', '693491412', 'fadafadele@gmail.com', 'https://t.me/couponfiablefoot
https://chat.whatsapp.com/K3QpST5jVstGSCkcr4gUZt?mode=ac_t', 'CM', 'B2TECH', 'betting', 'Французский', 'открытый', 'RS', '25%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3493900', '@MID9287', 'raoul3443@gmail.com', 'https://www.tiktok.com/@lotomath?_t=ZN-8xqsr2OwfBO&_r=1
https://www.facebook.com/profile.php?id=61578309800120
https://youtube.com/@pamlotoparis?si=-CflFYm5L_5tphZU
https://whatsapp.com/channel/0029VbAqNK0KgsNr8OgrK92h', 'BJ', 'PAM', 'betting', 'Французский', 'открытый', 'RS', '30%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@Miftah_433', 'miftaman1@gmail.com', 'https://t.me/bisrat_sport_ETH_433', 'ET', NULL, 'betting', 'English', 'вежливый', 'RS', '30%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3493074', '@mcpablo1', 'monamovie65@gmail.com', 'https://www.tiktok.com/@.luffy_hair
https://chat.whatsapp.com/HYNNuLL3179AKwZbgFEwjc?mode=ac_t
https://www.facebook.com/luffy.stone.100533?mibextid=LQQJ4d', 'CM', 'Gunnor, Uzb12', 'betting', 'Французский', 'открытый', 'RS', '25%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3497955', '@scorebtt', 'fopinohalla@gmail.com', 'https://t.me/pcspros', 'CM', 'MM12m', 'betting', 'Французский', 'открытый', 'RS', '25%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3458572', '@Tipsjojo', 'jeromeamevor4@gmail.com', 'https://t.me/fifajeux
https://t.me/AMV228promo
https://facebook.com/groups/1176238217460083/', 'TG', 'AMV228', 'betting', 'Французский', 'открытый', 'RS', '25%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3496915', 'tel:+22673256262', 'brunotindano68@gmail.com', 'https://chat.whatsapp.com/HSNrE8pCGwB0BQCDFOJGpa', 'BF', '𝐁𝐑𝐔𝐍𝐎5588', 'betting', 'Французский', 'открытый', 'RS', '25%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3497929', 'tel +254 741 942156‬', 'clintonokindo19@gmail.com', 'https://chat.whatsapp.com/JK86jglNyt2EAjvfcivfm8', 'KE', NULL, 'betting', 'English', 'вежливый', 'RS', '30%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3469318', '@Vickylee420', 'vkyalo254@gmail.com', 'https://chat.whatsapp.com/JiypAyPpEBnG0juWorTn97', 'KE', NULL, 'betting', 'English', 'открытый', 'RS', '30%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3498382', '@dra63fat45', 'bonkoungouawa89@gmail.com', 'https://chat.whatsapp.com/GMi2kxyg7qr2t3BnKyB88B?mode=r_c', 'BF', 'FS521', 'betting', 'Французский', 'открытый', 'RS', '25%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3500711', 'tel:+22677608691', 'arounacoulibaly521.com@gmail.com', 'https://www.facebook.com/profile.php?id=100069661268237', 'BF', 'ZXXY', 'betting', 'Французский', 'вежливый', 'RS', '25%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3498495', '@benzjunio', 'phanobtk@gmail.com', 'https://t.me/+md1bqTzDBcgyYTRk', 'BJ', 'Debo88', 'betting', 'Французский', 'открытый', 'RS', '30%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3497615', '@doin09', 'pademsebon@gmail.com', 'https://www.instagram.com/nickolson_official?igsh=d2hpbG5rdTMxZmV1&utm_source=qr', 'CM', 'Dinar', 'betting', 'Французский', 'открытый', 'RS', '25%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3497893', '679646453', 'sauiiitueabaaauuitteu@gmaii.com', 'https://t.me/MIXFootballprodchat', 'CM', 'luna12', 'betting', 'Французский', 'открытый', 'RS', '25%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3506479', 'tel:+2250584503875', 'pclamelokouadio48@gmail.com', 'https://facebook.com/groups/287884965598502/', 'CI', 'LAMELO225', 'betting', 'Французский', 'открытый', 'RS', '30%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@Miguelehg', 'samedi12234445667899@gmail.com', 'https://t.me/+xUcRPRazmrA2MmU0', 'CM', NULL, 'betting', 'Французский', 'открытый', 'RS', '30%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@MOHA566', 'elmarocmohamed@gmail.com', 'https://t.me/niyfcl', 'MA', NULL, 'betting', 'Арабский', 'вежливый', 'RS', '30% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@fathi_depo33', 'ayoubmikan11@gmail.com', 'https://www.instagram.com/fathi_deposit_1', 'MA', NULL, 'betting', 'Арабский', 'вежливый', 'RS', '50% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@Bas_public12', 'ysaddiki92@gmail.com', 'https://t.me/betting_Maroc', 'MA', NULL, 'betting', 'Арабский', 'вежливый', 'RS', '50% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3503855', '@EIkingcash1', 'martin4144m@gmail.com', 'https://t.me/Wmejejsisis46463', 'EG', NULL, 'betting', 'Арабский', 'вежливый', 'RS', '30% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3506021', '@arelehoussou7', 'deogratiasbenin2@gmail.com', 'https://chat.whatsapp.com/K46dzH42XGu0Rn5Eqs4o7e', 'BJ', '𝐀𝐌𝐀𝐏𝐈𝐀𝐍𝐎', 'betting', 'Французский', 'вежливый', 'RS', '25% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3506854', '243896022706', 'abbdgangofficiel1312003@gmsil.com', 'https://chat.whatsapp.com/HJhkMOZUONEKsikr62mo1q?mode=r_c
https://chat.whatsapp.com/GCWeD9tNUyh6gg3G8fKhwj?mode=r_c
https://chat.whatsapp.com/D1NhZyYojpk5ZCx5dgurPx?mode=r_c', 'CD', NULL, 'betting', 'Французский', 'деловой', 'RS', 'RS 30%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3508158', 'tel:+2250585804329', 'ouattaraali208@gmail.com', 'https://www.facebook.com/groups/1640238593418095/?ref=share&mibextid=NSMWBT', 'CI', '14millions', 'betting', 'Французский', 'открытый', 'RS', '25%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3509185', '@Sethpremiere', 'derinsamba@gmail.com', 'https://t.me/+4TJ0Lb26raVkODI0', 'CM', '01VIP', 'betting', 'Французский', 'открытый', 'RS', '25% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3502011', '@Mkvpron', 'starthero2210@gmail.com', 'https://t.me/+DOgZJSVR1vAyOTY8
https://www.facebook.com/share/1ETMsFxfxu/?mibextid=LQQJ4d', 'CM', NULL, 'betting', 'Французский', 'открытый', 'RS', 'RS 30%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3502947', '@dayszonlink', 'samuel.larosex@gmail.com', 'https://t.me/boruto_vf_hd', 'CM', 'YOLO, golazo', 'betting', 'Французский', 'открытый', 'RS', 'RS 35%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3514727', '242 06 573 0545', 'christianwamba44@gmail.com', 'https://www.tiktok.com/@chris.wamba?_r=1&_d=ekj6h8cd3813m4&sec_uid=MS4wLjABAAAA4u0CthcsOlvgEPmvsRU8oYidW7dgl3qpvJh3-MNDY921EGutEomp-o4kE10CPZKa&share_author_id=7434611272106918945&sharer_language=fr&source=h5_m&u_code=eh5j182i58bbjh&ug_btm=b8727,b0&social_share_type=4&utm_source=copy&sec_user_id=MS4wLjABAAAA4u0CthcsOlvgEPmvsRU8oYidW7dgl3qpvJh3-MNDY921EGutEomp-o4kE10CPZKa&tt_from=copy&utm_medium=ios&utm_campaign=client_share&enable_checksum=1&user_id=7434611272106918945&share_link_id=116E161F-BC6C-48D5-8F2E-37316D93822E&share_app_id=1233
https://www.facebook.com/share/1CHEaRayf7/?mibextid=wwXIfr
https://www.facebook.com/share/g/14FP99KkD9B/?mibextid=wwXIfr
https://www.facebook.com/share/1Jp4M2Y4eW/?mibextid=wwXIfr
https://www.facebook.com/share/16tVfc8oTN/?mibextid=wwXIfr', NULL, '𝐑𝐀𝐅𝐀𝐇13', 'betting', 'Французский', 'открытый', 'RS', 'RS 35%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@LM10M7M6', 'bagoscheikna@gmail.com', 'https://t.me/+yEMKSsJlf-VjNDNk', 'MR', NULL, 'betting', 'Арабский', 'дружеский', 'RS', '25% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '2549757', '@Bikeck10', 'bikecktresor237@gmail.com', 'https://t.me/Lionelpcsofficiel2
https://t.me/ferrandprono
https://t.me/ZooDalyCombo
https://t.me/+9ZP4HYmfZa1lZDlk', 'CM', NULL, 'betting', 'English', 'открытый', 'RS', '35%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '212604129114', 'wassimmouch0@gmail.com', 'https://www.facebook.com/profile.php?id=100063761426449', 'MA', NULL, 'betting', 'Арабский', 'вежливый', 'RS', '50% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '688385276', 'chouthierry113@gmail.com', 'https://vm.tiktok.com/ZMSG2feaq/', 'CM', NULL, 'betting', 'Французский', 'деловой', 'RS', '35% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3510025', '@bsbking1', 'bsbking75@gmail.com', 'https://t.me/+jdlOLIddK2cyM2M0', 'CM', '85𝐏𝐒', 'betting', 'Французский', 'деловой', 'RS', '35% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3513628', 'tel:+243977172123', 'zizim1233@gmail.com', 'https://t.me/+RYL6PecIIhdmNWI0', 'CD', 'ZIM17', 'betting', 'Французский', 'открытый', 'RS', '25% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3514241', 'tel:+2250709835678', 'augustinmarcelk@gmail.com', 'https://www.facebook.com/share/1PZvg71wXi/', 'CI', 'KAM777', 'betting', 'Французский', 'открытый', 'RS', '25% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3514680', '@ossam7o', 'komaservicesinternatioanl@gmail.com', 'https://www.facebook.com/share/12MCTB4AxiV/', 'BF', NULL, 'betting', 'English', 'вежливый', 'RS', '30% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3514655', 'https://t.me/SmithZm90', 'zambiaemmanuel6@gmail.com', 'https://facebook.com/groups/124170143845873/', 'ZM', NULL, 'betting', 'English', 'открытый', 'CPA', '10 / 2 / 2', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@Mooon15', 'nasreenmasoud0@gmail.com', 'FB', 'EG', NULL, 'crash', 'Арабский', 'вежливый', 'RS', '25% RS + Mobcash', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3514420', '@romanyjj', 'romanyatef757@gmail.com', 'FB', 'EG', NULL, 'betting', 'Арабский', 'вежливый', 'RS', '25% RS + Mobcash', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3514098', '@ibraim112', 'kilx123@gmail.com', 'https://www.facebook.com/bleriaud.sapeur?mibextid=wwXIfr&mibextid=wwXIfr', 'CI', 'AAAAA1', 'betting', 'Французский', 'открытый', 'RS', '25% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@Callgojo', 'gojopronostic@gmail.com', 'https://t.me/Gojo_Pronostic', 'MA', NULL, 'betting', 'Арабский', 'деловой', 'Hybrid', '50% RS + 200$ предоплата', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3516208', '@hosni_shop1', 'abdo01630uh@gmail.com', 'https://www.instagram.com/hosni_shop90', 'MA', NULL, 'betting', 'Арабский', 'вежливый', 'RS', '50% RS + Mobcash', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3516263', '@Raidy_k', 'rabihizakaria@gmail.com', 'https://t.me/Promo_sports', 'MA', NULL, 'betting', 'Арабский', 'вежливый', 'RS', '30% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3517328', '212 691-047527 @MK200610', 'cizimyoo@gmail.com', 'https://chat.whatsapp.com/KeyqzDPyX3J63FtNHc6VlN?mode=r_c', 'MA', NULL, 'betting', 'Арабский', 'вежливый', 'RS', '30% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3517371', '212 696-747695 @Elmajorsama', 'hichamaniber7@gmail.com', 'https://www.facebook.com/freeefixed', 'MA', NULL, 'betting', 'Английский', 'вежливый', 'Hybrid', '30% + Mobcash + пополним на 100$ единоразово его кассу для активации', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3515665', 'tel:+2250173529647', 'kouamekoffiraymond905@gmail.com', 'https://facebook.com/groups/558081464663357/', 'CI', '14fan', 'betting', 'Французский', 'открытый', 'RS', 'RS 25%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3506334', '@Masterlincoln237', 'alvarexalvarex35@gmail.com', 'https://www.facebook.com/share/1CLoD3npmF/', 'CM', 'Account888starz', 'betting', 'Французский', 'открытый', 'RS', 'RS 25%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3518789', '@takeaway001', 'chadymwishuranshya@gmail.com', 'https://www.facebook.com/share/16aKaZtteF/
https://youtube.com/@chadythegenius?si=S4hLHkZAWnp6-WJ-', 'BI', 'CHADYBURUNDI
YAMAL257
MBAPPE257', 'betting', 'Французский', 'открытый', 'RS', 'RS 25% + mobcash', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@Isneilaffiliate', 'gazonico36@gmail.com', 'LM', 'CM', NULL, 'betting', 'Французский', 'открытый', 'Fix', 'LM', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '992317093', 'mosengokevin75@gmail.com', 'https://chat.whatsapp.com/ESw1A8ScdEBFybRFU8Ps3J?mode=r_t', 'CD', NULL, 'betting', 'Французский', 'открытый', 'RS', 'RS 25%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, 'tel:+237689538314', 'dannyfomat4@gmail.com', 'https://www.facebook.com/share/g/16gGDhsFm5/?mibextid=wwXIfr', 'CM', NULL, 'betting', 'Французский', 'открытый', 'RS', 'RS 25%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@wiz_muga', 'desirehabogorimana17@gmail.com', 'https://chat.whatsapp.com/Ee8zav31WS20B6KYlaQc02
https://t.me/pronostic_winwin', 'BI', NULL, 'betting', 'Французский', 'открытый', 'RS', 'RS 25%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@SiiiRtakhlaaas', 'salimmanar442@gmail.com', 'https://t.me/+d8ZytXYTeykwMDNk', 'DZ', NULL, 'betting', 'Арабский', 'вежливый', 'RS', '25% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@Amer12021985', 'tonaamer9@gmail.com', 'https://t.me/fhdtcssse 
https://t.me/+7gH5uDQxep42OTlk', 'EG', NULL, 'betting', 'English', 'властный', 'CPA', 'CPA 15/3/3 hold_14

Мы не принимаем поддельных игроков и мультиаккаунты.
Выплаты происходят только за игроков, которые сделали повторный депозит.
Все игроки должны быть зарегистрированы  с помощью наших приложений Android/IOS.
Мы не платим за неактивных игроков.

Заметка: сделка в ПП', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3522730', '237672599327', 'neptunenopo@gmail.com', 'https://www.facebook.com/profile.php?id=61557971387360', 'CM', NULL, 'betting', 'English', 'деловой', 'RS', '25%RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3522814', '@Ridwane_846', 'johnsonbabada@gmail.com', 'https://t.me/+LMt-5RWZkes2NWI0', 'KE', NULL, 'betting', 'English', 'вежливый', 'RS', '30% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, 'tel:+254742002952', 'addisontipssource@gmail.com', NULL, 'KE', NULL, 'betting', 'English', 'открытый', 'RS', '35%RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3498412', '@Andydivane', 'andysynclair6@gmail.com', 'https://t.me/hadangercanal', 'CM', NULL, 'betting', 'Французский', 'открытый', 'RS', 'RS 25%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@belwinprono', 'belmonnchezeu@gmail.com', 'https://chat.whatsapp.com/EnpJAzYaxUmIZRsgQr9iTo
https://chat.whatsapp.com/E9MRqujlHFv3Xh1dodNEOl
https://chat.whatsapp.com/G45HZ1XPUQlJ6W9Cbi2o7d
https://t.me/+WksIQIF3Yi80Y2Q8', 'CM', NULL, 'betting', 'Французский', 'открытый', 'RS', 'RS 40%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '657567695', 'bkasescoduduke@gmail.com', 'https://whatsapp.com/channel/0029VbAgMFGH5JLxM06Tg41d
http://x.com/SeyiNiki?t=Hp3uLOvixJgi-VK8VwZJrA&s=09', 'TZ', NULL, 'betting', 'English', 'вежливый', 'RS', 'Rs 40%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '652136885', 'willystephane07@gmail.com', 'https://chat.whatsapp.com/G5fY7FqH2r78qYs162XVTi', 'NG', NULL, 'betting', 'English', 'открытый', 'RS', '35%RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@Ayoubmeri', 'ayoubmeri@gmail.com', 'https://studio.youtube.com/channel/UCHeskKhX4yVlGagDEFwFPrw https://www.youtube.com/channel/UCHeskKhX4yVlGagDEFwFPrw/ https://www.youtube.com/@ProfRouletteCasino', 'NG', NULL, 'betting', 'English', 'вежливый', 'RS', '30% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3487067', 'tel:+22870544275', 'hilelkougbe35@gmail.com', 'https://chat.whatsapp.com/EVocYhx0aPg8rLmk8hgVnd?mode=r_c', 'TG', NULL, 'betting', 'Французский', 'деловой', 'RS', 'RS 25%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@kamto110', 'takougangfranck0@gmail.com', 'https://chat.whatsapp.com/DOGJ1Gh2vfF6HThBySGLxchttps://chat.whatsapp.com/COlluDLExlEI6AE9nbpuCg
https://chat.whatsapp.com/Cs29BgfxL8N6uvy2YteaOC', 'CM', NULL, 'betting', 'Французский', 'открытый', 'RS', 'RS 25%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@Pronotch', 'kenbrinebelva@gmail.com', 'https://t.me/groupepartagepronostics', 'CM', NULL, 'betting', 'Французский', 'открытый', 'RS', 'RS 25%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@Ruddypl', 'me1212kk@gmail.com', 'https://facebook.com/groups/439091094353376/', 'CM', NULL, 'betting', 'Французский', 'открытый', 'RS', 'RS 25%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@Lezmredred', 'jundewabofiwi1232@gmail.com', 'http://tiktok.com/@jeanroger087', 'CM', NULL, 'betting', 'Французский', 'открытый', 'RS', 'RS 25%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@anelka120', 'telegramanelka@gmail.com', 'https://t.me/+PTZvOTY-7eEzYWJk', 'CM', NULL, 'betting', 'Французский', 'открытый', 'RS', 'RS 25%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, 'tel:+22999435624', 'consolantbossou@gmail.com', 'https://t.me/+gkZ8u7jRMOtkNGRk', 'BJ', NULL, 'betting', 'Французский', 'открытый', 'RS', 'RS 25%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '237654996166', 'newback238@gmail.com', 'https://t.me/joinchat/D_Zajv3DepRjNGE0', 'CM', NULL, 'betting', 'Французский', 'открытый', 'RS', 'RS 25%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@MR_RIGOBER', 'foudakevin455@gmail.com', 'https://chat.whatsapp.com/Jaf8MCPjUPu2zEPMkdUWau', 'CM', NULL, 'betting', 'Французский', 'открытый', 'RS', '30% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@kenwizzy9', 'sossaboris59@gmail.com', 'https://www.instagram.com/kenwizzy9?igsh=YzljYTk1ODg3Zg==', 'BJ', NULL, 'betting', 'Французский', 'открытый', 'RS', 'RS 25%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, 'tel:+237655876341', 'polemilun@gmail.com', 'https://t.me/+uTH9gCN7XxgxZjNk', 'CM', NULL, 'betting', 'Французский', 'открытый', 'RS', 'RS 25%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@Kemalhakime', 'yvanfeuken@gmail.com', 'https://t.me/Pronostics1xbet9', 'CM', NULL, 'betting', 'Французский', 'открытый', 'RS', 'RS 25%', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@Ayofjfjcub', 'kerok4233@gmail.com', 'FB ADS', 'EG', NULL, 'betting', 'English', 'вежливый', 'CPA', 'CPA 10/2/x2 hold_14

Мы не принимаем поддельных игроков и мультиаккаунты.
Выплаты происходят только за игроков, которые сделали повторный депозит.
Все игроки должны быть зарегистрированы  с помощью наших приложений Android/IOS.
Мы не платим за неактивных игроков.', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@dinelbk', 'judetiako515@gmail.com', 'https://t.me/FCBprono', 'CM', NULL, 'betting', 'English', 'вежливый', 'RS', '25% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@Hamada958', 'hamadahassan9860@gmail.com', 'https://t.me/messibetting', 'EG', NULL, 'betting', 'English', 'вежливый', 'RS', '25% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@aboubeck', 'slobqor@gmail.com', 'https://www.facebook.com/alpha.body.2025', 'CM', NULL, 'betting', 'English', 'вежливый', 'RS', '30% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@Etchie01', 'yenomonvo@gmail.com', 'https://www.facebook.com/profile.php?id=61576772465324', 'CM', NULL, 'betting', 'English', 'вежливый', 'RS', '30% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '237672682995', 'venomandreas93@gmail.com', 'https://www.facebook.com/profile.php?id=61553617707435', 'CM', NULL, 'betting', 'English', 'вежливый', 'RS', '25% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@aydywsf921c', 'mntsrzkrya92@gmail.com', 'FB ADS', 'EG', NULL, 'betting', 'English', 'вежливый', 'RS', '25% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '237673713221', 'ronisdmetenousteve154@gmail.com', 'https://t.me/bluelockvf2', 'CM', NULL, 'betting', 'English', 'вежливый', 'RS', '25% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3545612', '@angeseraphin', 'mbocasar@gmail.com', 'https://www.facebook.com/emekaprono', 'CM', NULL, 'betting', 'Французский', 'вежливый', 'RS', '30% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3545587', '@K11_K_11', 'tiwatchongo@gmail.com', 'https://www.facebook.com/profile.php?id=100089320921985', 'CM', NULL, 'betting', 'Французский', 'вежливый', 'RS', '30% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3530608', '@tatchinio', 'subscribekinghu@gmail.com', 'https://www.facebook.com/profile.php?id=61552610844969', 'CM', NULL, 'betting', 'Французский', 'вежливый', 'RS', '30% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3530575', '237672680393', 'mercictfi@gmail.com', 'https://www.facebook.com/profile.php?id=100094778911621', 'CM', NULL, 'betting', 'Французский', 'вежливый', 'RS', '30% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3530560', '237650395825', 'tiwaericssogyu@gmail.com', 'https://www.facebook.com/profile.php?id=61573721369857', 'CM', NULL, 'betting', 'Французский', 'вежливый', 'RS', '30% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3526748', '237682661736', 'owan12k@gmail.com', 'https://t.me/hardmangas', 'CM', NULL, 'betting', 'Французский', 'вежливый', 'RS', '25% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '671698728', 'nadinehardy12@gmail.com', 'https://www.facebook.com/lee.fritz.2025', 'CM', NULL, 'betting', 'Французский', 'деловой', 'RS', '30% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3542674', '@Zafar_3858', 'zafartigersy@gmail.com', 'https://t.me/+5SWN4krI_DUzY2Fi', 'UZ', NULL, 'betting', 'Узбекский', 'вежливый', 'RS', '25% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, 'https://t.me/stralaffiate', 'maboudouanla@gmail.com', 'https://www.facebook.com/share/p/1CaK3cidN9/?mibextid=oFDknk', 'CM', NULL, 'betting', 'Французский', 'открытый', 'RS', '25% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@arnauldfrr', 'lechapement@gmail.com', 'https://www.facebook.com/profile.php?id=61576387871811', 'CM', NULL, 'betting', 'Французский', 'открытый', 'RS', '25% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@mabo', 'foireurdeludo@gmail.com', 'https://www.facebook.com/profile.php?id=61576387871811', 'CM', NULL, 'betting', 'Французский', 'открытый', 'RS', '25% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@Fifenalex', 'moristakala@gmail.com', 'https://www.facebook.com/share/1GAGHAq72R/?mibextid=oFDknk', 'CM', NULL, 'betting', 'Французский', 'открытый', 'RS', '25% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@MARON_affiliat_1xbet', 'tatamivara@gmail.com', 'https://www.facebook.com/share/p/1BHgFWHZvT/?mibextid=oFDknk', 'BF', NULL, 'betting', 'Французский', 'открытый', 'RS', '25% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@modiMELBET', 'zaviemaria@gmail.com', 'https://www.facebook.com/share/1BC6U6swmA/?mibextid=oFDknk', 'BF', NULL, 'betting', 'Французский', 'открытый', 'RS', '25% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@celdel22', 'meclane235@gmail.com', 'https://t.me/borelpronscoupon', 'CM', NULL, 'betting', 'Французский', 'открытый', 'RS', '25% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@neypronostic', 'guiriafabrice@gmail.com', 'https://chat.whatsapp.com/LBV5kKCsAG72d46uQDKCli?mode=ac_t', 'CI', NULL, 'betting', 'Французский', 'открытый', 'RS', '25% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@Verbalon', 'khalidhamadawww157@gmail.com', 'https://www.facebook.com/khalid.hamada.399826', 'MA', NULL, 'betting', 'Арабский', 'властный', 'RS', '25% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@David23sj', 'marufhasan3@gmail.com', 'LM', 'EG,MA,DZ,BD', NULL, '-', 'Английский', 'властный', 'subreff', '5% subreff', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '153592685', 'nutata379@gmail.com', NULL, 'CI', NULL, 'betting', 'Французский', 'деловой', 'RS', '30% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', '3125194', '@SOCRATE2026', 'arseneaymar202@gmail.com', 'https://t.me/+YCzIewvuW9dmZTE0', 'CI', NULL, 'betting', 'Французский', 'дружеский', 'RS', '40% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@lorinzomanger888stars', 'jklm57661@gmail.com', 'https://t.me/LorinzoX', 'CM', NULL, 'betting', 'Французский', 'открытый', 'RS', '25% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@httpstmeaff_keubou', 'chocokeubou@gmail.com', 'https://www.facebook.com/profile.php?id=61565981210241&mibextid=ZbWKwL', 'CM', NULL, 'betting', 'Французский', 'открытый', 'RS', '25% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '225694683572', 'jaarakyven588@gmail.com', 'https://t.me/winner123333', 'CI', NULL, 'betting', 'Французский', 'открытый', 'RS', '25% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@tamoparfait', 'stevefofou12@gmail.com', 'https://t.me/+c7Opcw6KBlpmYmM8', 'CM', NULL, 'betting', 'Французский', 'открытый', 'RS', '30% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '237670033084', 'pronohernandez@gmail.com', 'https://chat.whatsapp.com/L6Rqjd3UZpE6CRm8I6BMGC?mode=ac_t', 'CM', NULL, 'betting', 'Французский', 'открытый', 'RS', '25% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@MEXICAIN_1', 'lfhhzguul77@gmail.com', 'https://t.me/+xzE5F1Fz_UZkNmE8', 'CM', NULL, 'betting', 'Французский', 'открытый', 'RS', '30% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '679681123', 'sriking20070@gmail.com', 'https://facebook.com/groups/350558146413854', 'CM', NULL, 'betting', 'Французский', 'открытый', 'RS', '30% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@pcswin_pro', 'samabobo74@gmail.com', 'https://t.me/+yu19atotf300ZTdk', 'CM', NULL, 'betting', 'Французский', 'открытый', 'RS', '25% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@noidara', 'dericklontio42@gmail.com', 'https://t.me/+ADmLmjD12N9lZmRk', 'CM', NULL, 'betting', 'Французский', 'открытый', 'RS', '30% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@bateigfiye', 'zoropolo201@gmail.com', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '2256772894211', 'paola772894@gmail.com', 'https://t.me/ULTRA_PRONOSWIN', 'CI', NULL, 'betting', 'Французский', 'деловой', 'RS', '30% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@MIKELPRO22', 'tantomikel774@gmail.com', 'https://t.me/+oCPQ7rT1qBM3OTE0', 'CM', NULL, 'betting', 'Французский', 'открытый', 'RS', '25% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@SCAMVPN7', 'zubadou72@gmail.com', 'https://chat.whatsapp.com/DjbkxnaqE2mI915bobSss1?mode=r_c', 'CM', NULL, 'betting', 'Французский', 'открытый', 'RS', '25% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@jacquesA13', 'juniorivan697@gmail.com', 'https://www.facebook.com/profile.php?id=61553039100297&mibextid=ZbWKwL', 'CM', NULL, 'betting', 'Французский', 'открытый', 'RS', '25% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@Malesidonie', 'credricksoltane@gmail.com', 'https://chat.whatsapp.com/FXNiAz4Nr4A6eITpyoegGd?mode=ac_t', 'CM', NULL, 'betting', 'Французский', 'открытый', 'RS', '25% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@lilbaby01', 'nakakoku7@gmail.com', 'https://t.me/montchioprono', 'CM', NULL, 'betting', 'Французский', 'открытый', 'RS', '30% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, 'tel:+237697275763', 'joressehugue@gmail.com', 'https://t.me/josatepro', 'CM', NULL, 'betting', 'Французский', 'открытый', 'RS', '25% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, 'https://t.me/Morisalondra223', 'marobotout@gmail.com', 'https://www.facebook.com/crechLatiff?mibextid=ZbWKwL', 'CM', NULL, 'betting', 'Французский', 'открытый', 'RS', '25% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@hihanalove', 'dbbetaffiliatekalach@gmail.com', 'https://www.facebook.com/share/1B7DB7yU1j/?mibextid=wwXIfr', 'CM', NULL, 'betting', 'Французский', 'открытый', 'RS', '25% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '651770719', 'asensior550@gmail.com', 'https://www.facebook.com/profile.php?id=61553705992068', 'CM', NULL, 'betting', 'Французский', 'открытый', 'RS', '25% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@cocodeko', 'beaubrayan58@gmail.com', 'https://www.facebook.com/profile.php?id=61552610844969', 'CM', NULL, 'betting', 'Французский', 'открытый', 'RS', '25% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@idrisspron', 'fabiolakieni@gmail.com', 'https://t.me/+K2aiQCMbcMZlNGNk', 'CM', NULL, 'betting', 'Французский', 'открытый', 'RS', '30% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@pcswin_pro', 'samabobo7@gmail.com', 'https://t.me/+yu19atotf300ZTdk', 'CM', NULL, 'betting', 'Французский', 'открытый', 'RS', '25% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@fopabell', 'simofopo@gmail.com', 'https://www.instagram.com/fiablespronostics?igsh=dWxwdmk3eHVvcTI2', 'CM', NULL, 'betting', 'Французский', 'открытый', 'RS', '25% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@IAMGeorgesw', 'mwanahawamwaita84@gmail.com', 'https://x.com/Yourscousin/status/1795852433559576861?t=BOBtH9ZEzQLAVCN3fbuHPw&s=09', 'TZ', NULL, 'betting', 'Английский', 'открытый', 'RS', '25% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@yourinffo', 'tabasanew@gmail.com', 'https://t.me/+9Bpd5NhcEs43OTlk', 'CM', NULL, 'betting', 'Французский', 'открытый', 'RS', '25% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, 'https://t.me/mlb569', 'camavingae882@gmail.com', 'https://www.facebook.com/profile.php?id=61553705992068', 'CM', NULL, 'betting', 'Французский', 'открытый', 'RS', '25% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, NULL, 'taatina99@gmail.com', 'https://t.me/linebet_CMR_237', 'CM', NULL, 'betting', 'Французский', 'открытый', 'RS', '25% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@davib65_affiliate', 'farelanga517@gmail.com', 'https://www.facebook.com/david.david.356984', 'CI', NULL, 'betting', 'Французский', 'открытый', 'RS', '25% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@borelkatanguer', 'kangmoborelle25@gmail.com', 'https://facebook.com/groups/1984686702023344/', 'CM', NULL, 'betting', 'Французский', 'открытый', 'RS', '25% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '237673863730', 'venomwilfried67@gmail.com', 'https://www.facebook.com/share/16SsqtuheR/?mibextid=wwXIfr', 'CM', NULL, 'betting', 'Французский', 'открытый', 'RS', '25% RS', 'new'),
  ((SELECT id FROM public.partner_bases WHERE name='888starz'), '888starz', NULL, '@Fifenalex', 'hirmadidib@gmail.com', 'https://t.me/+DLxOJago_rw1OWZk', 'CM', NULL, 'betting', 'Французский', 'открытый', 'RS', '25% RS', 'new')
ON CONFLICT (base_id, email) DO NOTHING;
