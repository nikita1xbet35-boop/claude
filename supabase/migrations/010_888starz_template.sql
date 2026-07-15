-- Migration 010: configure the 888starz base template + daily limit.
-- Only sets values when the template is still empty, so it never clobbers edits
-- made later in the dashboard. Two subjects (one per line) → picked at random.

UPDATE public.partner_bases SET
  template_subject = 'Partnership with 1xBet — #1 in Africa' || chr(10) || 'Let''s work together — 1xBet',
  template_body =
    'Hi!' || chr(10) ||
    'My name is Nick, I''m with 1xBet. We''re the #1 betting brand in Africa — fully licensed across the continent, trusted by millions of players, with instant local payments and one of the strongest offers on the market.' || chr(10) ||
    'We''re growing and looking for new partners, and I''d love to discuss working together. Clean RevShare, no admin fee, weekly payouts, and you''d deal with me directly.' || chr(10) ||
    'Telegram: @aff_manager_xbet',
  daily_limit = 100
WHERE name = '888starz'
  AND (template_body IS NULL OR template_body = '');
