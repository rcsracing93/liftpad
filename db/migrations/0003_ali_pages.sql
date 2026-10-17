-- 0003 (Handoff 3 step 1, Rick 2026-10-16, decisions 3 and 4): ALI page images by edition.
-- Additive only: one new table, one new index. ali_index already has `edition` (default '2019').
-- One row per PDF page of an edition's scan (status 'ok'; the image is in the private R2 bucket at
-- ali/<edition>/p<NNN>.jpg, NNN = pdf_page with 3 digits), and one row per guide page that is not
-- in the scan (status 'missing_from_scan', pdf_page NULL). Rows come from the import tool
-- (ali-pages.csv, written by tools/render_pages.py), never from a migration.
-- w, h: image size in pixels (the viewer and chart boxes use fractions of it); bytes: file size.

CREATE TABLE ali_pages (id INTEGER PRIMARY KEY, edition TEXT NOT NULL, pdf_page INT, guide_page INT,
  status TEXT NOT NULL CHECK(status IN ('ok','missing_from_scan')), w INT, h INT, bytes INT,
  CHECK((status = 'ok' AND pdf_page IS NOT NULL) OR (status = 'missing_from_scan' AND pdf_page IS NULL AND guide_page IS NOT NULL)));
CREATE UNIQUE INDEX ali_pages_pdf ON ali_pages(edition, pdf_page) WHERE pdf_page IS NOT NULL;
CREATE INDEX ali_ed ON ali_index(make, model, edition);

INSERT INTO schema_migrations(id) VALUES('0003');
