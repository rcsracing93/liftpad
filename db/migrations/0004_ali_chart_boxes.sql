-- 0004 (Handoff 3 step 2, Rick 2026-10-16, decision 6): one box per chart, drawn once on the Mac.
-- Additive only: one new table. x, y, w, h are fractions of the page image (0..1, from the top
-- left), so the box fits the page at any size. One row per edition + chart: every car on that
-- chart uses it. The Lift tab draws it on the page and the viewer opens zoomed to it.
-- set_at, set_by: when and on which screen it was drawn (the device name, like value history).

CREATE TABLE ali_chart_boxes (id INTEGER PRIMARY KEY, edition TEXT NOT NULL, chart TEXT NOT NULL, pdf_page INT NOT NULL,
  x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL, h REAL NOT NULL, set_at TEXT NOT NULL, set_by TEXT NOT NULL DEFAULT '',
  UNIQUE(edition, chart),
  CHECK(x >= 0 AND y >= 0 AND w > 0 AND h > 0 AND x + w <= 1.0001 AND y + h <= 1.0001));

INSERT INTO schema_migrations(id) VALUES('0004');
