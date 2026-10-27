-- 0010 (ultrareview F10, Rick 2026-10-27): the value history keeps the torque numbers. Since HANDOFF 15 the screen shows and range-checks
-- vals.ftlb_lo / ftlb_hi, so a change of only those numbers must leave an old and a new number in history (a safety value is auditable).
-- Additive only: six nullable columns. Older code ignores them, so a rollback of the code is safe. Old rows keep NULL (no number was logged then).
ALTER TABLE history ADD COLUMN old_ftlb_lo INT;
ALTER TABLE history ADD COLUMN new_ftlb_lo INT;
ALTER TABLE history ADD COLUMN old_ftlb_hi INT;
ALTER TABLE history ADD COLUMN new_ftlb_hi INT;
ALTER TABLE history ADD COLUMN old_ftlb_src TEXT;
ALTER TABLE history ADD COLUMN new_ftlb_src TEXT;

INSERT INTO schema_migrations(id) VALUES('0010');
