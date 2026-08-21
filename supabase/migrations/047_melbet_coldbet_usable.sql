-- 047 — Melbet и Coldbet становятся рабочими брендами полного интерфейса
--
-- ── Зачем ───────────────────────────────────────────────────────────────────
-- 046 научила базу прятать бренды с visibility='hidden' от роли standard, но
-- прятать было нечего: melbet и coldbet стояли в статусе 'draft', а дашборд
-- берёт в шапку только active/paused (loadBrands в index.html). В итоге full и
-- standard видели одинаковый набор из трёх брендов, и разница между ролями
-- сводилась к иконке ⚙ и двум строкам внутри настроек.
--
-- Здесь они переводятся в paused: появляются в шапке — но только у full, за
-- счёт политики brands_select из 046, отдельного условия для этого не нужно.
--
-- ── Почему paused, а не active ──────────────────────────────────────────────
-- Это не осторожность ради осторожности. 035 положила в system_config
-- rotation_order = ["1xbet","1xcasino","melbet","coldbet","luckypari"] — оба
-- бренда УЖЕ в кольце ротации контактов. Единственное, что удерживает их от
-- участия, — строчка в fn_rotate_contacts (035, ~364):
--
--     SELECT * INTO v_next_brand FROM public.brands
--       WHERE slug = v_order[v_try_idx] AND status = 'active';
--
-- То есть 'active' здесь не «галочка видимости», а команда начать раздавать им
-- контакты. У обоих sender_email пуст, ключевых слов нет — назначенный им
-- контакт просто застрял бы во владении бренда, который никому не пишет, и
-- выпал бы из ротации на cooldown_days. Молча, без единой ошибки в журнале.
--
-- 038 добавляет второй повод: взвешенный выбор бренда для поиска идёт по
-- sum(cron_weight) WHERE status='active'. cron_weight у обоих 0, так что доли
-- они не получат и в active, но полагаться на одно это — значит держать
-- защиту в одном месте вместо двух.
--
-- Перевод в active — сознательное решение с ключами и отправителем на руках,
-- и делается оно кнопкой в интерфейсе, а не миграцией.
--
-- ── Отправитель ─────────────────────────────────────────────────────────────
-- Проставляется тот же, что у 1xBet и 1xCasino: по постановке «логика у всех
-- брендов одна», а полбренда без отправителя — это экран настроек с пустыми
-- полями, о которые спотыкаешься позже. Если у Melbet/Coldbet будет свой ящик
-- или свой менеджер, это правится на экране бренда, без миграции.
--
-- geo_list намеренно остаётся пустым: гео определяют, что и где искать, это
-- решение владельца программы, а не значение по умолчанию.

UPDATE public.brands SET
  status       = 'paused',
  sender_email = 'nick.adflow@gmail.com',
  sender_tg    = '@aff_manager_xbet',
  updated_at   = now()
WHERE slug IN ('melbet', 'coldbet')
  AND status = 'draft';   -- если их уже включили руками, не откатываем назад

-- ── Проверка ────────────────────────────────────────────────────────────────
-- Три вещи, каждая из которых при поломке молчит, а не падает:
--   1. бренды видны интерфейсу (иначе вся миграция бессмысленна);
--   2. они НЕ active (иначе ротация начнёт им раздавать контакты);
--   3. они всё ещё hidden (иначе их увидит standard, и 046 отменена).
DO $$
DECLARE
  n_visible INT;
  n_active  INT;
  n_hidden  INT;
BEGIN
  SELECT count(*) INTO n_visible FROM public.brands
   WHERE slug IN ('melbet','coldbet') AND status IN ('active','paused');
  SELECT count(*) INTO n_active FROM public.brands
   WHERE slug IN ('melbet','coldbet') AND status = 'active';
  SELECT count(*) INTO n_hidden FROM public.brands
   WHERE slug IN ('melbet','coldbet') AND visibility = 'hidden';

  IF n_visible <> 2 THEN
    RAISE EXCEPTION 'melbet/coldbet не попали в active|paused (%) — в шапке они не появятся', n_visible;
  END IF;
  IF n_active > 0 THEN
    RAISE EXCEPTION '% из них в статусе active — ротация начнёт раздавать им контакты без отправителя', n_active;
  END IF;
  IF n_hidden <> 2 THEN
    RAISE EXCEPTION 'visibility перестал быть hidden (% из 2) — standard увидит эти бренды', n_hidden;
  END IF;

  RAISE NOTICE 'melbet/coldbet: видимы интерфейсу, не в ротации, скрыты от standard';
END $$;
