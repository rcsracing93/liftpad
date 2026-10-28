-- 0012 (HANDOFF 17, Handoff B, Rick 2026-10-26): engine/variant lists from fueleconomy.gov and the door-jamb photo read.
-- Additive for the data: two new columns, two new tables. No statement names vehicles.vin (Rick 2026-10-26: a saved VIN is never changed).
-- One table is rebuilt: jobs. Its CHECK on kind allowed 'photo_read' and no job of the new kind 'read_doorcard'; SQLite cannot change a CHECK in place.
-- The rebuild copies every row with its id, so no job is lost. Older code ignores everything here, so a rollback of the code is safe
-- (the old code never writes a read_doorcard job).
-- vehicles.variant: the fueleconomy.gov model name of the car (for example "Grand Cherokee 4WD"). vehicles.model stays the plain name.
-- vehicles.fe_id: the fueleconomy.gov vehicle id of the picked option (engine, transmission). vehicles.engine (0009) holds its text.
-- fe_menu: the answers of fueleconomy.gov, cached by the Worker. Past years never change; a row older than a year is fetched again.
--   model = '' is the list of models of one make and year; otherwise the options of one model.
-- photo_reads: a VIN that Claude read from a door-jamb photo. It is a proposal: it never replaces a saved VIN. vin_ok is the ISO 3779
--   check-digit result (1 pass, 0 fail). Rick confirms or rejects it beside the photo.
ALTER TABLE vehicles ADD COLUMN variant TEXT;
ALTER TABLE vehicles ADD COLUMN fe_id INTEGER;
CREATE TABLE fe_menu (year INT NOT NULL, make TEXT NOT NULL, model TEXT NOT NULL DEFAULT '', options_json TEXT NOT NULL, fetched_at TEXT NOT NULL,
  PRIMARY KEY (year, make, model));
CREATE TABLE photo_reads (id INTEGER PRIMARY KEY, vehicle_id INT NOT NULL, photo TEXT NOT NULL, job_id INT, vin TEXT, vin_ok INT,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed','confirmed','rejected')), created_at TEXT NOT NULL, decided_at TEXT, decided_by TEXT);
CREATE INDEX photo_reads_s ON photo_reads(status, vehicle_id);

DROP INDEX jobs_q;
ALTER TABLE jobs RENAME TO jobs_old;
CREATE TABLE jobs (id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('research','workup','photo_read','read_doorcard')),
  target TEXT NOT NULL, request TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','claimed','done','failed')),
  claimed_by TEXT, lease_until TEXT, attempts INT NOT NULL DEFAULT 0, result_summary TEXT, error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
INSERT INTO jobs(id, kind, target, request, status, claimed_by, lease_until, attempts, result_summary, error, created_at, updated_at)
  SELECT id, kind, target, request, status, claimed_by, lease_until, attempts, result_summary, error, created_at, updated_at FROM jobs_old;
DROP TABLE jobs_old;
CREATE INDEX jobs_q ON jobs(status, created_at, id);

INSERT INTO schema_migrations(id) VALUES('0012');
