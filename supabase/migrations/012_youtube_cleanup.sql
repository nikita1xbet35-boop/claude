-- Migration 012: purge low-quality YouTube channels from the base.
-- Removes channels under 1000 subscribers (or hidden/0) and channels named after
-- a bookmaker (official/spam, not independent tipsters). Idempotent — after the
-- first run the search function no longer adds either kind, so re-runs are no-ops.

DELETE FROM public.telegram_channels
WHERE partner_type = 'youtube'
  AND (
        subscribers < 1000
     OR subscribers IS NULL
     OR name ~* '(melbet|megapari|1xbet|1 ?win|betwinner|pari ?match|linebet|22bet|mostbet|paripesa|betway|sportybet|bet9ja|helabet|888 ?starz|pin-?up|betpawa|premier ?bet|fonbet|olimp|marathon ?bet|bangbet|gal ?sport)'
  );
