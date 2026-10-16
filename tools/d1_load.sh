#!/bin/sh
# LiftPad D1 load decision. Called by tools/deploy.sh inside node:22-alpine (needs jq).
# Run:     sh tools/d1_load.sh SEED_FILE        (RESEED=1 to wipe and reload)
# Target:  D1 database $LP_D1_NAME (default "liftpad"). Backups go to $LP_BACKUP_DIR
#          (default /private/backups).
# Changes: runs db/schema.sql (drops all tables) and SEED_FILE, ONLY when the table
#          "vehicles" is absent, or RESEED=1. Before a RESEED wipe it exports the database
#          to LP_BACKUP_DIR and stops if that backup fails or is empty.
# If the check itself fails (wrangler exits non-zero, or the answer is not the expected
# JSON), it stops with exit 3 and changes nothing. A failed check is never "table missing".
# Exit: 0 done or nothing to do; 2 bad arguments or missing file; 3 stopped, nothing changed.
# WRANGLER overrides the wrangler command (the test uses a fake one).
# shellcheck disable=SC3040 # runs under busybox ash (node:22-alpine), which has pipefail; STANDARD 11.4
set -euo pipefail
W=${WRANGLER:-npx wrangler}
DBN=${LP_D1_NAME:-liftpad}
BK=${LP_BACKUP_DIR:-/private/backups}
HERE=$(cd "$(dirname "$0")" && pwd)
SCHEMA="$HERE/../db/schema.sql"
[ "$#" -eq 1 ] || { echo "usage: sh tools/d1_load.sh SEED_FILE (one argument). Nothing was changed." >&2; exit 2; }
SEED=$1
[ -f "$SEED" ] || { echo "d1_load: STOP - seed file not found: '$SEED'. Nothing was changed." >&2; exit 2; }
[ -f "$SCHEMA" ] || { echo "d1_load: STOP - schema not found: $SCHEMA. Nothing was changed." >&2; exit 2; }

ERR=$(mktemp)
# shellcheck disable=SC2086 # $W is a command plus arguments, split on purpose
if ! OUT=$($W d1 execute "$DBN" --remote --json --command "SELECT name FROM sqlite_master WHERE type='table' AND name='vehicles'" 2>"$ERR"); then
  echo "d1_load: STOP - the table check failed (wrangler exit non-zero). Nothing was changed." >&2
  tail -5 "$ERR" >&2; rm -f "$ERR"; exit 3
fi
rm -f "$ERR"
# The answer must be [{"success":true,"results":[...]}]. Anything else stops the deploy.
if ! N=$(printf '%s' "$OUT" | jq -e '.[0] | if .success == true and (.results | type) == "array" then (.results | length) else error("bad answer") end' 2>/dev/null); then
  echo "d1_load: STOP - the table check gave no usable JSON. Nothing was changed." >&2
  exit 3
fi

case "$N" in
  0) WHY="table vehicles is absent" ;;
  1) if [ "${RESEED:-0}" != "1" ]; then
       echo "D1 has data - not reloaded (set RESEED=1 to wipe and reload)"; exit 0; fi
     WHY="RESEED=1"
     mkdir -p "$BK"
     B="$BK/$DBN-$(date -u +%Y%m%dT%H%M%SZ).sql"
     # shellcheck disable=SC2086
     if ! $W d1 export "$DBN" --remote --output="$B" >/dev/null 2>&1; then
       echo "d1_load: STOP - backup before RESEED failed. Nothing was changed." >&2; exit 3; fi
     if ! grep -q 'INSERT INTO' "$B" 2>/dev/null; then
       echo "d1_load: STOP - backup before RESEED is empty: $B. Nothing was changed." >&2; exit 3; fi
     echo "backup: $B ($(wc -c < "$B") bytes)" ;;
  *) echo "d1_load: STOP - unexpected table count '$N'. Nothing was changed." >&2; exit 3 ;;
esac

echo "D1 load: $WHY - running schema and $(basename "$SEED")"
# shellcheck disable=SC2086
$W d1 execute "$DBN" --remote --file "$SCHEMA" -y 2>&1 | tail -1
# shellcheck disable=SC2086
$W d1 execute "$DBN" --remote --file "$SEED" -y 2>&1 | tail -1
echo "D1 loaded"
