-- 0008 (HANDOFF 13, Rick 2026-10-24): the "I checked this chart" button. Additive only: one new table; older code ignores it.
-- chart_checks is append-only: the button and Undo only add rows, nothing is changed or deleted (the self-test cleans up its own
-- temp edition 'selftest' only). text_hash = sha256 of the chart's text (adapters, height_note, cautions, kit_mark) when the
-- row was added. "Checked by Rick" = the latest row for the chart is a check AND its text_hash equals the hash of the text now.
-- If the text changes, the label falls back to the level in chart_notes.verified (no or ai) by itself.
-- The import never touches this table; the CSV holds only no and ai.
CREATE TABLE chart_checks (id INTEGER PRIMARY KEY, edition TEXT NOT NULL, chart TEXT NOT NULL, text_hash TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('check','undo')), who TEXT NOT NULL, at TEXT NOT NULL);
CREATE INDEX chart_checks_c ON chart_checks(edition, chart, id);

INSERT INTO schema_migrations(id) VALUES('0008');
