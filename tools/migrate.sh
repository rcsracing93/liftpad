#!/bin/sh
# LiftPad schema migrations. Runs inside node:22-alpine (or node:22 for --local), needs jq.
# Run:     sh tools/migrate.sh            dry run: prints the plan, changes nothing
#          sh tools/migrate.sh --apply    backup (if the database has data), then apply the plan
# Target:  D1 database $LP_D1_NAME (default "liftpad"), remote unless LP_D1_LOCAL=1.
#          Backups go to $LP_BACKUP_DIR (default /private/backups).
# Changes: with --apply only: runs db/migrations/bootstrap.sql if there is no ledger, then each
#          pending db/migrations/NNNN_*.sql in order. A database with tables but no ledger is the
#          pre-migration live database: it must equal expected_0001.sql, and 0001 is then
#          recorded as applied, not run ("baseline").
# Exit:    0 done or nothing to do; 2 bad arguments; 3 stopped, nothing changed;
#          4 a migration failed after the backup - restore from the backup file it names.
# WRANGLER overrides the wrangler command (the test uses a fake one).
# shellcheck disable=SC3040 # runs under busybox ash (node:22-alpine), which has pipefail; STANDARD 11.4
set -euo pipefail
W=${WRANGLER:-npx wrangler}
DBN=${LP_D1_NAME:-liftpad}
BK=${LP_BACKUP_DIR:-/private/backups}
WHERE=--remote
[ "${LP_D1_LOCAL:-0}" = "1" ] && WHERE=--local
HERE=$(cd "$(dirname "$0")" && pwd)
MIG="$HERE/../db/migrations"
APPLY=0
case "$#:${1:-}" in
  0:) ;;
  1:--apply) APPLY=1 ;;
  *) echo "usage: sh tools/migrate.sh [--apply]. Nothing was changed." >&2; exit 2 ;;
esac
stop() { echo "migrate: STOP - $1. Nothing was changed." >&2; exit 3; }

# q SQL -> prints the results array as JSON; stops on any wrangler or JSON problem.
q() {
  out=$($W d1 execute "$DBN" "$WHERE" --json --command "$1" 2>/dev/null) || stop "a query failed (wrangler exit non-zero)"
  printf '%s' "$out" | jq -ce '.[0] | if .success == true and (.results | type) == "array" then .results else error("bad") end' 2>/dev/null \
    || stop "a query gave no usable JSON"
}

TABLES=$(q "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('schema_migrations','vehicles')")
has() { printf '%s' "$TABLES" | jq -e --arg n "$1" 'any(.[]; .name == $n)' >/dev/null; }
APPLIED=""
if has schema_migrations; then
  MODE=ledger
  APPLIED=$(q "SELECT id FROM schema_migrations ORDER BY id" | jq -r '.[].id')
elif has vehicles; then
  MODE=baseline
  # The schema of the database must be exactly what 0001 creates.
  q "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name <> 'schema_migrations' ORDER BY name" \
    | jq -r '.[] | "\(.type)|\(.name)|\((.sql // "") | gsub("\\s+"; " "))"' > /tmp/lp-schema-now.txt
  grep -v '^--' "$MIG/expected_0001.sql" > /tmp/lp-schema-want.txt
  if ! cmp -s /tmp/lp-schema-now.txt /tmp/lp-schema-want.txt; then
    diff /tmp/lp-schema-want.txt /tmp/lp-schema-now.txt >&2 || true
    stop "the database has tables but no ledger, and its schema is not 0001 (diff above: < expected, > found)"
  fi
  APPLIED=0001
else
  MODE=fresh
fi

PENDING=""
SEEN=""
for f in "$MIG"/[0-9][0-9][0-9][0-9]_*.sql; do
  [ -e "$f" ] || continue
  id=$(basename "$f" | cut -c1-4)
  case " $SEEN " in *" $id "*) stop "two migration files have id $id" ;; esac
  SEEN="$SEEN $id"
  printf '%s\n' "$APPLIED" | grep -qx "$id" || PENDING="$PENDING $id"
done
echo "migrate: database $DBN ($WHERE), mode $MODE, applied: $(printf '%s' "$APPLIED" | tr '\n' ' ')"
echo "migrate: pending:${PENDING:- none}"
if [ "$APPLY" = 0 ]; then echo "migrate: dry run - nothing changed (add --apply)"; exit 0; fi
if [ -z "$PENDING" ] && [ "$MODE" = ledger ]; then echo "migrate: nothing to do"; exit 0; fi

B=""
if has vehicles; then
  mkdir -p "$BK"
  B="$BK/$DBN-premigrate-$(date -u +%Y%m%dT%H%M%SZ).sql"
  # shellcheck disable=SC2086 # $W is a command plus arguments, split on purpose
  $W d1 export "$DBN" "$WHERE" --output="$B" >/dev/null 2>&1 || stop "the backup before migrating failed"
  grep -q 'INSERT INTO' "$B" 2>/dev/null || stop "the backup before migrating is empty: $B"
  echo "migrate: backup $B ($(wc -c < "$B") bytes)"
fi
run_file() {
  # shellcheck disable=SC2086
  if ! $W d1 execute "$DBN" "$WHERE" --file "$1" -y >/dev/null 2>/tmp/lp-mig.err; then
    tail -5 /tmp/lp-mig.err >&2
    echo "migrate: FAILED in $(basename "$1"). Restore: ${B:-fresh database, nothing to restore}" >&2; exit 4
  fi
}
if [ "$MODE" != ledger ]; then run_file "$MIG/bootstrap.sql"; fi
if [ "$MODE" = baseline ]; then
  q "INSERT INTO schema_migrations(id) VALUES('0001')" >/dev/null || true
  [ "$(q "SELECT count(*) n FROM schema_migrations WHERE id='0001'" | jq -r '.[0].n')" = 1 ] \
    || { echo "migrate: FAILED to record baseline 0001. Restore: $B" >&2; exit 4; }
  echo "migrate: baseline 0001 recorded"
fi
for id in $PENDING; do
  f=$(ls "$MIG"/"$id"_*.sql)
  run_file "$f"
  [ "$(q "SELECT count(*) n FROM schema_migrations WHERE id='$id'" | jq -r '.[0].n')" = 1 ] \
    || { echo "migrate: FAILED - $id ran but is not in the ledger. Restore: ${B:-fresh database}" >&2; exit 4; }
  echo "migrate: applied $id"
done
echo "migrate: done"
