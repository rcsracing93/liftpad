#!/bin/sh
# LiftPad D1 load decision. Called by tools/deploy.sh inside node:22-alpine (needs jq).
# Run:     sh tools/d1_load.sh SEED_FILE
# Target:  D1 database $LP_D1_NAME (default "liftpad").
# Changes: an EMPTY database (no table "vehicles"): runs the migration chain (tools/migrate.sh
#          --apply), then SEED_FILE. A database WITH data: nothing, unless migrations are pending:
#          then it stops, or with LP_APPLY_MIGRATIONS=1 runs tools/migrate.sh --apply, which takes
#          a verified backup first (Rick approves that run).
#          schema.sql and RESEED are gone (Handoff 2: never drop the live tables again).
# If the check itself fails (wrangler exits non-zero, or the answer is not the expected
# JSON), it stops with exit 3 and changes nothing. A failed check is never "table missing".
# Exit: 0 done or nothing to do; 2 bad arguments or missing file; 3 stopped, nothing changed;
#       4 a migration failed after its backup (migrate.sh names the backup).
# WRANGLER overrides the wrangler command (the test uses a fake one).
# shellcheck disable=SC3040 # runs under busybox ash (node:22-alpine), which has pipefail; STANDARD 11.4
set -euo pipefail
W=${WRANGLER:-npx wrangler}
DBN=${LP_D1_NAME:-liftpad}
HERE=$(cd "$(dirname "$0")" && pwd)
[ "$#" -eq 1 ] || { echo "usage: sh tools/d1_load.sh SEED_FILE (one argument). Nothing was changed." >&2; exit 2; }
SEED=$1
[ -f "$SEED" ] || { echo "d1_load: STOP - seed file not found: '$SEED'. Nothing was changed." >&2; exit 2; }
[ -z "${RESEED:-}" ] || { echo "d1_load: STOP - RESEED was removed on 2026-10-16. Restore from a backup instead (README). Nothing was changed." >&2; exit 2; }

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
  0)
    echo "D1 load: table vehicles is absent - migration chain, then $(basename "$SEED")"
    sh "$HERE/migrate.sh" --apply
    # shellcheck disable=SC2086
    $W d1 execute "$DBN" --remote --file "$SEED" -y 2>&1 | tail -1
    echo "D1 loaded" ;;
  1)
    PLAN=$(sh "$HERE/migrate.sh")
    printf '%s\n' "$PLAN"
    if printf '%s\n' "$PLAN" | grep -q '^migrate: pending: none$'; then echo "D1 has data and its schema is current - not changed"; exit 0; fi
    if [ "${LP_APPLY_MIGRATIONS:-0}" != "1" ]; then
      echo "d1_load: STOP - migrations are pending. Apply them with LP_APPLY_MIGRATIONS=1 (Rick approves). Nothing was changed." >&2; exit 3
    fi
    sh "$HERE/migrate.sh" --apply ;;
  *) echo "d1_load: STOP - unexpected table count '$N'. Nothing was changed." >&2; exit 3 ;;
esac
