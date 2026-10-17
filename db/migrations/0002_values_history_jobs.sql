-- 0002 (Handoff 2, Rick 2026-10-16): tabs and fields as data, values per model-year range with
-- status and dates, change history, research jobs, car groups.
-- Additive only: no table is dropped or rewritten. The old `specs` table is kept unchanged, so
-- the Worker code from before this migration still runs against it (rollback of code is safe).
-- Times are ISO 8601 UTC text, for example 2026-10-16T18:49:52.957Z, so they sort as text.

CREATE TABLE tabs (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, label TEXT NOT NULL, sort INT NOT NULL DEFAULT 0);
CREATE TABLE fields (id INTEGER PRIMARY KEY, tab_id INT NOT NULL REFERENCES tabs(id), name TEXT NOT NULL, unit TEXT NOT NULL DEFAULT '', sort INT NOT NULL DEFAULT 0, is_safety INT NOT NULL DEFAULT 0, UNIQUE(tab_id, name));

-- One row per value. scope 'model': belongs to make + model + year range, seen by every such car.
-- scope 'car': an override that belongs to one car (for example aftermarket wheels).
CREATE TABLE vals (id INTEGER PRIMARY KEY, field_id INT NOT NULL REFERENCES fields(id),
  scope TEXT NOT NULL CHECK(scope IN ('model','car')),
  make TEXT, model TEXT, year_from INT, year_to INT, vehicle_id INT REFERENCES vehicles(id),
  value TEXT NOT NULL, confidence TEXT NOT NULL CHECK(confidence IN ('High','Medium','Low')),
  source TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', warn INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN ('proposed','confirmed','rejected')),
  entered_at TEXT NOT NULL, entered_by TEXT NOT NULL DEFAULT '', confirmed_at TEXT, confirmed_by TEXT, updated_at TEXT NOT NULL,
  CHECK((scope = 'model' AND make IS NOT NULL AND model IS NOT NULL AND year_from IS NOT NULL AND year_to IS NOT NULL AND year_from <= year_to AND vehicle_id IS NULL)
     OR (scope = 'car' AND vehicle_id IS NOT NULL)));
CREATE INDEX vals_model ON vals(make, model, year_from, year_to);
CREATE INDEX vals_car ON vals(vehicle_id);
CREATE INDEX vals_status ON vals(status);

-- Every insert, update, confirm, reject and delete of a value writes one row here.
-- value_id has no foreign key on purpose: the history of a deleted value must stay.
CREATE TABLE history (id INTEGER PRIMARY KEY, value_id INT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('insert','update','confirm','reject','delete')),
  old_value TEXT, new_value TEXT, old_status TEXT, new_status TEXT, old_confidence TEXT, new_confidence TEXT,
  at TEXT NOT NULL, device TEXT NOT NULL DEFAULT '');
CREATE INDEX history_v ON history(value_id, id);

-- Research queue. request holds only make, model, year, trim and field names - never a VIN,
-- a name, notes or photos.
CREATE TABLE jobs (id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('research','workup','photo_read')),
  target TEXT NOT NULL, request TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','claimed','done','failed')),
  claimed_by TEXT, lease_until TEXT, attempts INT NOT NULL DEFAULT 0, result_summary TEXT, error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX jobs_q ON jobs(status, created_at, id);

ALTER TABLE vehicles ADD COLUMN grp TEXT NOT NULL DEFAULT 'visitor' CHECK(grp IN ('mine','frequent','visitor'));
ALTER TABLE vehicles ADD COLUMN last_seen TEXT;
UPDATE vehicles SET grp = CASE WHEN mine = 1 THEN 'mine' ELSE 'visitor' END;

INSERT INTO tabs(name, label, sort) VALUES ('lift', 'Lift', 1), ('torque', 'Torque', 2), ('tires', 'Tires', 3);
-- One VALUES table, not a UNION ALL chain: D1 refuses a compound SELECT with this many terms.
INSERT INTO fields(tab_id, name, unit, sort, is_safety)
  SELECT t.id, f.column2, f.column3, f.column4, f.column5 FROM tabs t JOIN (VALUES
    ('lift', 'Points', '', 1, 1),
    ('lift', 'Air suspension', '', 2, 0),
    ('lift', 'Battery', '', 3, 0),
    ('torque', 'Torque', 'ft-lb', 1, 1),
    ('torque', 'Thread', '', 2, 0),
    ('torque', 'Socket', '', 3, 0),
    ('tires', 'Size', '', 1, 0),
    ('tires', 'Pressure', 'psi', 2, 0)) f ON f.column1 = t.name;
-- Any field name in use today that is not in the list above.
INSERT OR IGNORE INTO fields(tab_id, name, sort) SELECT DISTINCT t.id, s.field, 50 FROM specs s JOIN tabs t ON t.name = s.tab;

-- Today's values move to model-year values, one year per car (Rick, 2026-10-16, answer 1A).
-- Every one is `proposed`: "confirmed" means Rick checked it in the app, and he has checked none
-- yet (Rick, 2026-10-16, change to answer 6). Confidence, source and note are kept as they are.
INSERT INTO vals(field_id, scope, make, model, year_from, year_to, value, confidence, source, note, warn,
                 status, entered_at, entered_by, confirmed_at, confirmed_by, updated_at)
  -- The seed wrote an empty source or note as NULL; vals keeps them as '' (NOT NULL columns).
  SELECT f.id, 'model', v.make, v.model, v.year, v.year, s.value, s.confidence, COALESCE(s.source, ''), COALESCE(s.note, ''), COALESCE(s.warn, 0),
    'proposed', strftime('%Y-%m-%dT%H:%M:%fZ', s.updated), 'migration 0002', NULL, NULL,
    strftime('%Y-%m-%dT%H:%M:%fZ', s.updated)
  FROM specs s JOIN vehicles v ON v.id = s.vehicle_id JOIN tabs t ON t.name = s.tab JOIN fields f ON f.tab_id = t.id AND f.name = s.field
  ORDER BY s.id;
INSERT INTO history(value_id, action, new_value, new_status, new_confidence, at, device)
  SELECT id, 'insert', value, status, confidence, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'migration 0002' FROM vals ORDER BY id;

INSERT INTO schema_migrations(id) VALUES('0002');
