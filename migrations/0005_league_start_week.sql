-- 0005_league_start_week.sql — rest-of-season entry (GTM D1, ruled 2026-08-28).
-- A league drafted after an NFL week has kicked off starts at the next playable
-- week; its schedule covers start_week..14. Existing leagues default to 1
-- (bit-identical to prior behavior). Additive; never edit after apply.

ALTER TABLE leagues ADD COLUMN start_week INTEGER NOT NULL DEFAULT 1;
