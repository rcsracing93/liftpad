-- 0006 (HANDOFF 6, Rick 2026-10-22): the Apps screen. Additive only: one new table; older code
-- ignores it. Rows are data from tools/import.py (private-data/apps.csv: name,url,icon,sort) or
-- the seeds, never from a migration: a URL can be a LAN address, which stays out of git.
-- name is the natural key. icon is a short name the app draws (unknown names get the grid icon).
CREATE TABLE apps (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, url TEXT NOT NULL, icon TEXT NOT NULL DEFAULT 'apps',
  sort INT NOT NULL DEFAULT 100, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));

INSERT INTO schema_migrations(id) VALUES('0006');
