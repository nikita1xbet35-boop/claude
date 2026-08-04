-- Enable auto-send for the "Первая таблица" partner base.
--
-- The base was configured (template + 100/day limit) and the user believed they
-- had switched it on from the dashboard, but its sending_enabled was still false
-- — the old toggle updated the UI before the DB write and never checked the
-- result, so a failed write left it looking "on" while it stayed off. This turns
-- it on reliably; the dashboard toggle fix (this same deploy) prevents the silent
-- failure going forward.
--
-- Only this one base is enabled. 888starz is fully sent (251/251) and luckypari
-- is mostly duplicates, so leaving those off keeps the shared mailbox (300/day)
-- well within budget.
--
-- last_send_reset is cleared so the per-day counter starts fresh on the next tick.
UPDATE public.partner_bases
SET sending_enabled = true,
    sent_today      = 0,
    last_send_reset = now()
WHERE name = 'Первая таблица'
  AND template_body IS NOT NULL;
