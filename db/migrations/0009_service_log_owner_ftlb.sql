-- 0009 (HANDOFF 15, Handoff A, Rick 2026-10-26): service log, owner, fuel, torque in ft-lb, per-car chart caution switch.
-- Additive only: new columns (all nullable or with a default) and new tables. Older code ignores them, so a rollback of the code is safe.
-- vehicles.owner: shown on the card when it is not Rick. Never sent to the processor or to any model.
-- vehicles.fuel: gas, diesel, hybrid, phev or ev. Decides which service items and which Oil tab text apply.
-- vehicles.engine: text for now (Handoff B fills it from a list). vals.engine: a value that applies to one engine only (Handoff B).
-- vehicles.hide_chart_cautions: 1 = the Lift tab hides the chart's caution text for this car (the car's own caution stays).
-- vals.ftlb_lo / ftlb_hi / ftlb_src: the torque numbers to show. ftlb_src is 'printed' (the source prints ft-lb) or 'converted' (from N-m).
ALTER TABLE vehicles ADD COLUMN owner TEXT;
ALTER TABLE vehicles ADD COLUMN fuel TEXT CHECK(fuel IS NULL OR fuel IN ('gas','diesel','hybrid','phev','ev'));
ALTER TABLE vehicles ADD COLUMN engine TEXT;
ALTER TABLE vehicles ADD COLUMN hide_chart_cautions INT NOT NULL DEFAULT 0;
ALTER TABLE vals ADD COLUMN ftlb_lo INT;
ALTER TABLE vals ADD COLUMN ftlb_hi INT;
ALTER TABLE vals ADD COLUMN ftlb_src TEXT CHECK(ftlb_src IS NULL OR ftlb_src IN ('printed','converted'));
ALTER TABLE vals ADD COLUMN engine TEXT;

-- The items of the cart, as data. options_json: null = no option; {"choices":[...]} = pick one (required);
-- {"text":true} = one typed line (the Other item). applies_fuels: comma list of the fuels the item applies to.
CREATE TABLE service_items (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, options_json TEXT, applies_fuels TEXT NOT NULL DEFAULT 'gas,diesel,hybrid,phev,ev',
  sort INT NOT NULL DEFAULT 0, active INT NOT NULL DEFAULT 1);
-- One visit. deleted_at: a soft delete (Rick only); the row stays and a service_log_history row says who and when.
CREATE TABLE service_entries (id INTEGER PRIMARY KEY, vehicle_id INT NOT NULL REFERENCES vehicles(id), date TEXT NOT NULL, mileage INT NOT NULL,
  created_at TEXT NOT NULL, created_by TEXT NOT NULL DEFAULT '', deleted_at TEXT);
CREATE INDEX service_entries_v ON service_entries(vehicle_id, date, mileage, id);
CREATE TABLE service_entry_items (id INTEGER PRIMARY KEY, entry_id INT NOT NULL REFERENCES service_entries(id), item_id INT NOT NULL REFERENCES service_items(id),
  option TEXT NOT NULL DEFAULT '', other_text TEXT NOT NULL DEFAULT '');
CREATE INDEX service_entry_items_e ON service_entry_items(entry_id);
-- Same idea as `history` for values: every create, edit and delete adds one row. before_json / after_json hold the entry with its items.
-- entry_id has no foreign key on purpose, like history.value_id.
CREATE TABLE service_log_history (id INTEGER PRIMARY KEY, entry_id INT NOT NULL, action TEXT NOT NULL CHECK(action IN ('insert','update','delete')),
  before_json TEXT, after_json TEXT, at TEXT NOT NULL, who TEXT NOT NULL DEFAULT '');
CREATE INDEX service_log_history_e ON service_log_history(entry_id, id);

INSERT INTO service_items(name, options_json, applies_fuels, sort) VALUES
  ('Oil change', '{"choices":["With filter","Without filter"]}', 'gas,diesel,hybrid,phev', 1),
  ('Engine air filter', NULL, 'gas,diesel,hybrid,phev', 2),
  ('Cabin air filter', NULL, 'gas,diesel,hybrid,phev,ev', 3),
  ('Brake pads', '{"choices":["Front","Rear","All"]}', 'gas,diesel,hybrid,phev,ev', 4),
  ('Brake rotors', '{"choices":["Front","Rear","All"]}', 'gas,diesel,hybrid,phev,ev', 5),
  ('Tire rotation', NULL, 'gas,diesel,hybrid,phev,ev', 6),
  ('Seasonal tires', '{"choices":["Winter on","Summer on"]}', 'gas,diesel,hybrid,phev,ev', 7),
  ('Wiper blades', '{"choices":["Front","Rear","All"]}', 'gas,diesel,hybrid,phev,ev', 8),
  ('New tires', '{"choices":["Front","Rear","All"]}', 'gas,diesel,hybrid,phev,ev', 9),
  ('Brake fluid flush', NULL, 'gas,diesel,hybrid,phev,ev', 10),
  ('12V battery', NULL, 'gas,diesel,hybrid,phev,ev', 11),
  ('Other', '{"text":true}', 'gas,diesel,hybrid,phev,ev', 99);

INSERT INTO schema_migrations(id) VALUES('0009');
