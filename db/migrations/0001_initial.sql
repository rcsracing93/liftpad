-- 0001: the schema as it was live on 2026-10-16 (from the old db/schema.sql, without its DROP lines).
-- On the live database this file is NOT run: tools/migrate.sh checks that the live schema equals
-- expected_0001.sql and records 0001 as applied ("baseline").
CREATE TABLE makes (name TEXT PRIMARY KEY, aliases TEXT DEFAULT '', nhtsa_name TEXT DEFAULT '');
CREATE TABLE ali_index (id INTEGER PRIMARY KEY, make TEXT NOT NULL, model TEXT NOT NULL, year_from INT, year_to INT, chart TEXT, guide_page INT, pdf_page INT, status TEXT, note TEXT, edition TEXT DEFAULT '2019');
CREATE INDEX ali_mk ON ali_index(make, year_from, year_to);
CREATE TABLE classics (id INTEGER PRIMARY KEY, make TEXT NOT NULL, model TEXT NOT NULL, year_from INT, year_to INT, model_years INT DEFAULT 0, years_src TEXT);
CREATE INDEX cl_mk ON classics(make);
CREATE TABLE vehicles (id INTEGER PRIMARY KEY, year INT NOT NULL, make TEXT NOT NULL, model TEXT NOT NULL, trim TEXT DEFAULT '', vin TEXT DEFAULT '', mine INT DEFAULT 1, notes TEXT DEFAULT '', created TEXT DEFAULT (datetime('now')));
CREATE TABLE specs (id INTEGER PRIMARY KEY, vehicle_id INT NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE, tab TEXT NOT NULL CHECK(tab IN ('lift','torque','tires')), field TEXT NOT NULL, value TEXT NOT NULL, confidence TEXT CHECK(confidence IN ('High','Medium','Low')), source TEXT DEFAULT '', note TEXT DEFAULT '', warn INT DEFAULT 0, updated TEXT DEFAULT (datetime('now')));
CREATE INDEX sp_v ON specs(vehicle_id, tab);
INSERT INTO schema_migrations(id) VALUES('0001');
