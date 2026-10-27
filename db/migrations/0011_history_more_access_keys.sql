-- 0011 (ultrareview 2, 2026-10-27). Additive only: older code ignores it.
-- #8: the value history keeps the warning level, the source and the note, old and new. Before, a change of only these (for example a
-- block "do not lift yet" set back to none) wrote an update row whose old and new columns were all equal, so a safety change could not
-- be audited. Six nullable columns; old rows keep NULL.
ALTER TABLE history ADD COLUMN old_warn INT;
ALTER TABLE history ADD COLUMN new_warn INT;
ALTER TABLE history ADD COLUMN old_source TEXT;
ALTER TABLE history ADD COLUMN new_source TEXT;
ALTER TABLE history ADD COLUMN old_note TEXT;
ALTER TABLE history ADD COLUMN new_note TEXT;
-- #1 (Rick 2026-10-27): the last good Cloudflare Access key list (public keys only, the JSON of the certs URL). The Worker writes it
-- only when the list changes; when a fetch of the certs URL fails, it verifies tokens against this list. One row (id 1).
CREATE TABLE access_keys (id INTEGER PRIMARY KEY CHECK (id = 1), jwks TEXT NOT NULL, saved_at TEXT NOT NULL);

INSERT INTO schema_migrations(id) VALUES('0011');
