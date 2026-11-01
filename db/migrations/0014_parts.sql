-- 0014 (HANDOFF 21, version F, Rick 2026-10-31): the Parts tab. Per car: aftermarket filters, wipers, coolant and brake fluid spec, proposed by the
-- research worker, confirmed by Rick only.
-- Additive for the data: two new empty tables (parts, parts_history). No existing row changes and no statement names vehicles.vin.
-- One table is rebuilt: jobs. Its CHECK on kind has no 'parts'; SQLite cannot change a CHECK in place (same method as 0012). The new CHECK is a
-- SUPERSET of the old one, so the code from before this migration still runs on the rebuilt table (it never writes a 'parts' job, and a 'parts' job
-- that exists is never claimed by it: its claim asks for research and workup only). The rebuild copies every row with its id.
-- A code rollback is safe while parts holds no row. After the seed, a rolled-back Worker that deletes a car with parts rows fails on the foreign key
-- (it does not know the table): the car stays. That is the safe side; the rollback note says so.
--
-- parts: one row per car + item + choice.
--   item   oil_filter, engine_air_filter, cabin_air_filter, wiper_driver, wiper_passenger, wiper_rear, coolant, brake_fluid
--   choice first (WIX for filters, Bosch for wipers), other (Purolator, Rain-X), oem (the maker's number as cross-reference), spec (fluids)
--   brand, part_no  as the source names them; part_no '' when no number was found (a wiper may carry size_in alone; Rick 2026-10-31)
--   also_fits       variants of the SAME fit, for example '99011XP' (one row per item, never a second row for a variant)
--   conflict_no     the other number when two US sources disagree (both are shown, confidence Low, the conflict is written in source)
--   size_in         wipers, inches (the Worker accepts 8 to 32)
--   spec_text       fluids: coolant type/spec, brake fluid DOT class
--   engine          the car's engine at research time
--   confidence      a part number is never High (the CHECK below); a fluid spec from the owner's manual may be High
--   check_car       1 until Rick confirms ("check against the car"); the Worker sets 0 only on confirm
--   job_id          the parts job that proposed the row
-- The unique index allows ONE live (not rejected) row per car + item + choice. A new research result replaces a proposed row of the same slot
-- (with a history row), and never a confirmed one. That rule is in the Worker; the index is the last guard.
CREATE TABLE parts (
  id INTEGER PRIMARY KEY,
  vehicle_id INT NOT NULL REFERENCES vehicles(id),
  item TEXT NOT NULL CHECK(item IN ('oil_filter','engine_air_filter','cabin_air_filter','wiper_driver','wiper_passenger','wiper_rear','coolant','brake_fluid')),
  choice TEXT NOT NULL CHECK(choice IN ('first','other','oem','spec')),
  brand TEXT NOT NULL DEFAULT '',
  part_no TEXT NOT NULL DEFAULT '',
  also_fits TEXT NOT NULL DEFAULT '',
  conflict_no TEXT NOT NULL DEFAULT '',
  size_in REAL CHECK(size_in IS NULL OR (size_in >= 8 AND size_in <= 32)),
  spec_text TEXT NOT NULL DEFAULT '',
  engine TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed','confirmed','rejected')),
  confidence TEXT NOT NULL CHECK(confidence IN ('High','Medium','Low')),
  source TEXT NOT NULL DEFAULT '',
  check_car INT NOT NULL DEFAULT 1 CHECK(check_car IN (0,1)),
  job_id INT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  confirmed_at TEXT,
  confirmed_by TEXT,
  CHECK(part_no = '' OR confidence <> 'High'),
  CHECK(choice <> 'spec' OR item IN ('coolant','brake_fluid')),
  CHECK(item NOT IN ('coolant','brake_fluid') OR choice = 'spec'));
CREATE UNIQUE INDEX parts_slot ON parts(vehicle_id, item, choice) WHERE status <> 'rejected';
CREATE INDEX parts_car ON parts(vehicle_id, status);
CREATE INDEX parts_status ON parts(status);

-- Every insert, update, confirm, reject and delete of a part writes one row here (same pattern as history for values).
-- part_id has no foreign key on purpose: the history of a deleted part (or a deleted car) must stay.
CREATE TABLE parts_history (
  id INTEGER PRIMARY KEY,
  part_id INT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('insert','update','confirm','reject','delete')),
  old_json TEXT,
  new_json TEXT,
  at TEXT NOT NULL,
  device TEXT NOT NULL DEFAULT '');
CREATE INDEX parts_history_p ON parts_history(part_id, id);

DROP INDEX jobs_q;
ALTER TABLE jobs RENAME TO jobs_old;
CREATE TABLE jobs (id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('research','workup','photo_read','read_doorcard','parts')),
  target TEXT NOT NULL, request TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','claimed','done','failed')),
  claimed_by TEXT, lease_until TEXT, attempts INT NOT NULL DEFAULT 0, result_summary TEXT, error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
INSERT INTO jobs(id, kind, target, request, status, claimed_by, lease_until, attempts, result_summary, error, created_at, updated_at)
  SELECT id, kind, target, request, status, claimed_by, lease_until, attempts, result_summary, error, created_at, updated_at FROM jobs_old;
DROP TABLE jobs_old;
CREATE INDEX jobs_q ON jobs(status, created_at, id);

INSERT INTO schema_migrations(id) VALUES('0014');
