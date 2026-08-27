-- 0003_moderation.sql — moderation minimums (SPEC §3.8, Appendix B).
-- Additive only: per-agent mute, per-message report counter.

ALTER TABLE agents ADD COLUMN muted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN reports INTEGER NOT NULL DEFAULT 0;
