-- Migration 007: record which search query surfaced each YouTube channel.
-- Lets the dashboard show "найден по запросу …" in the channel detail card.
-- Idempotent.

ALTER TABLE public.telegram_channels
  ADD COLUMN IF NOT EXISTS found_query text;
