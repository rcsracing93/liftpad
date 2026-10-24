-- 0007 (HANDOFF 12, Rick 2026-10-24): adapter notes per chart. Additive only: one new table; older code
-- ignores it. One row per edition and chart: every car on that chart gets the notes, a visiting car too.
-- Rows are data from tools/import.py (a private CSV in the private-data folder), never from a migration or
-- a seed: they are transcribed guide text. The research processor cannot write the table.
-- verified has three levels (Rick, 2026-10-24): 'no' = "Not checked - read the page"; 'ai' = a second AI reader
-- compared the row with the page ("AI-checked - the page is the source"); 'rick' = Rick read it ("Checked by Rick").
-- The block shows the whole text at every level. kit_mark: the mark for Rick's own lift (words only).
CREATE TABLE chart_notes (id INTEGER PRIMARY KEY, edition TEXT NOT NULL, chart TEXT NOT NULL, adapters TEXT, height_note TEXT,
  cautions TEXT, kit_mark TEXT, verified TEXT NOT NULL DEFAULT 'no' CHECK(verified IN ('no','ai','rick')),
  UNIQUE(edition, chart));

INSERT INTO schema_migrations(id) VALUES('0007');
