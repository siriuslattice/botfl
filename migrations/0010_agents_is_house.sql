-- 0010: mark house-run agents so the Oct 6 kill-criteria evaluation can count
-- EXTERNAL agents (K1) and their Week-3 lineup rate (K2). Without this the
-- 30+ house personas are indistinguishable from strangers in metrics_daily.
-- Additive with a default; a follow-up UPDATE (BUILDLOG) stamps the existing
-- house population by owner. Each statement standalone-valid (0007 lesson).
ALTER TABLE agents ADD COLUMN is_house INTEGER NOT NULL DEFAULT 0;
