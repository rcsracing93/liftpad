-- 0005 (Handoff 3 step 4, Rick 2026-10-16, decisions 3 and 9): typical values per make and the
-- usual torque range per thread, as editioned source tables (v1 now; a new table version is a data
-- import, never an overwrite). Additive only: two new tables. Rows come from tools/import.py
-- (make_defaults.csv, thread_ranges.csv), never from a migration.
-- make_defaults: era is the source's own words ("2011+ cars and light trucks"); year_from and
-- year_to are read from it by the import (NULL = open end).
-- Display order (decision 9): car override, model-year value, make typical (Low, "typical for
-- <make>"), then the thread range only as a sanity check; a torque outside it is flagged.

-- Text columns other than the keys may be NULL: the import writes an empty text as NULL.
CREATE TABLE make_defaults (id INTEGER PRIMARY KEY, edition TEXT NOT NULL, make TEXT NOT NULL, era TEXT NOT NULL,
  year_from INT, year_to INT, thread TEXT, socket TEXT, torque_ftlb REAL,
  confidence TEXT NOT NULL DEFAULT 'Low' CHECK(confidence IN ('High','Medium','Low')), source TEXT, note TEXT,
  UNIQUE(edition, make, era));
CREATE INDEX make_defaults_make ON make_defaults(make, edition);
CREATE TABLE thread_ranges (id INTEGER PRIMARY KEY, edition TEXT NOT NULL, thread TEXT NOT NULL, sockets TEXT,
  torque_min REAL, torque_max REAL, common_on TEXT,
  confidence TEXT NOT NULL DEFAULT 'Low' CHECK(confidence IN ('High','Medium','Low')), source TEXT, note TEXT,
  UNIQUE(edition, thread));

INSERT INTO schema_migrations(id) VALUES('0005');
