-- Revert 017: the user does not want the partner bases sending — they are already
-- fully worked (everything was sent long ago). The real need was a working cold
-- search, not partner outreach. Turn "Первая таблица" back off.
UPDATE public.partner_bases
SET sending_enabled = false
WHERE name = 'Первая таблица';
