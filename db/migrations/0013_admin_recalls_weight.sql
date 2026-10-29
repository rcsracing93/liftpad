-- 0013 (HANDOFF 18, Handoff C, Rick 2026-10-26/28): the Admin page log, the daily NHTSA recalls cache and the curb weight.
-- Additive: one new table for the log, one for the per-car facts, five new columns on vehicles. No statement names vehicles.vin
-- (Rick 2026-10-26: a saved VIN is never changed). Older code ignores everything here, so a rollback of the code is safe.
-- ops_log: rows pushed by the N100 (POST /api/admin/log, processor token) after the text was scrubbed there and again in the Worker.
--   level: green, amber or red. kind: queue, worker_run, health, backup, token_check, export or d1_usage. The N100 prunes rows older
--   than 30 days at the end of its nightly push (no Cloudflare cron).
-- car_facts: the NHTSA recalls answer of one car, cached once a day. recalls_json holds the campaigns (number, date, component, summary,
--   consequence, remedy); recalls_by says how the model name was found (vin = decoded from the saved VIN, saved = the car's own year, make
--   and model). recalls_ok_at = last good answer; recalls_try_at = last try (a failed try is repeated after 1 hour, a good answer after 20 hours).
--   weight_try_at: the same for the Canadian-specs weight.
-- vehicles.curb_*: the curb weight in lb and the front share in percent from the Canadian specs. curb_status is proposed until Rick confirms.
--   curb_source says "Canadian specs, base model" or "Canadian specs, <row name>". A confirmed value is never overwritten by a lookup.
CREATE TABLE ops_log (id INTEGER PRIMARY KEY, ts TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('queue','worker_run','health','backup','token_check','export','d1_usage')),
  level TEXT NOT NULL CHECK(level IN ('green','amber','red')), text TEXT NOT NULL, data_json TEXT);
CREATE INDEX ops_log_ts ON ops_log(ts, kind);
CREATE INDEX ops_log_kind ON ops_log(kind, ts);   -- "the latest row of one kind" (the Admin page and the gear dot) reads one row
CREATE TABLE car_facts (vehicle_id INTEGER PRIMARY KEY, recalls_json TEXT, recalls_count INT, recalls_by TEXT, recalls_model TEXT,
  recalls_ok_at TEXT, recalls_try_at TEXT, recalls_error TEXT, weight_try_at TEXT, weight_error TEXT);
ALTER TABLE vehicles ADD COLUMN curb_lb INT;
ALTER TABLE vehicles ADD COLUMN curb_front_pct INT;
ALTER TABLE vehicles ADD COLUMN curb_source TEXT;
ALTER TABLE vehicles ADD COLUMN curb_status TEXT;
ALTER TABLE vehicles ADD COLUMN curb_at TEXT;

INSERT INTO schema_migrations(id) VALUES('0013');
