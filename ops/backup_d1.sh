#!/bin/bash
# LiftPad nightly backup of the live D1 database -> a local folder + an optional second folder, keep 30 in each, verified.
# Run:     bash backup_d1.sh        (cron, nightly; no arguments; needs docker and bash)
# Reads:   the live D1 (wrangler d1 export: a read), $LP_CFG_DIR/cf.env (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID; mode 600), backup.conf (below)
# Changes: writes $LP_BK_LOCAL/liftpad-<UTC>.sql (mode 600) and the same file in $LP_BK_NAS;
#          deletes nightly files beyond the newest $LP_BK_KEEP in both folders (never the
#          liftpad-premigrate-* files); sends the Uptime Kuma push "liftpad-d1-backup":
#          up on success, down on any failure (a failed backup is an alert, not a silent skip).
#          The second folder (LP_BK_NAS) is for a share or another disk. The script never makes it: a missing mount or folder is a failure
#          (reported as nas-not-mounted / nas-missing), so a copy can never land on the box's own disk under the mount point.
# Checks before a file counts: non-empty, has INSERT rows, has the vehicles and vals tables,
#          and at least 90% of the INSERT rows of the previous nightly file (a partial export
#          must not rotate a good backup out). The NAS copy must have the same sha256.
#          When the export itself fails (HANDOFF 11, after the expired API token of 2026-10-24), wrangler's own
#          error lines (up to 3, secrets masked) go to the log and the last one (the reason) into the Kuma message.
# Exit:    0 backup done; 1 backup failed (Kuma down sent); 2 bad arguments.
# Test hooks: LP_BK_LOCAL, LP_BK_NAS, LP_BK_MOUNT (set empty = no mount check), LP_MOUNTPOINT, LP_BK_KEEP, LP_DOCKER, LP_KUMA_PUSH.
set -euo pipefail
[ "$#" = 0 ] || { echo "usage: backup_d1.sh (no arguments)" >&2; exit 2; }
# HANDOFF 22 (G4): one script for every install. Your values live in $LP_CFG_DIR/backup.conf (default ~/.config/liftpad/backup.conf),
# plain KEY=VALUE lines, read as text and never run. An environment variable of the same name wins over the file. Keys:
#   LP_BK_LOCAL  folder for the backups (default $LP_BASE_DIR/backups; LP_BASE_DIR default ~/liftpad)
#   LP_BK_NAS    second folder for a copy, on another disk or share; empty or missing = no second copy
#   LP_BK_MOUNT  the mount point that must be mounted before the second copy (empty = no check)
#   LP_BK_KEEP   how many nightly files to keep in each folder (default 30)
#   LP_KUMA_PUSH a script "SCRIPT MONITOR up|down MESSAGE" that reports the result (Uptime Kuma push); empty = none
#   LP_D1_NAME   the D1 database name (default liftpad)
CFG=${LP_CFG_DIR:-$HOME/.config/liftpad}
BASE=${LP_BASE_DIR:-$HOME/liftpad}
# Review 3c: an LP_BK_NAS that is set EMPTY in the environment turns the second copy off on purpose; say so in the log (checked before the file is read, which exports its own values).
NAS_ENV_EMPTY=0
if [ -n "${LP_BK_NAS+x}" ] && [ -z "$LP_BK_NAS" ]; then NAS_ENV_EMPTY=1; fi
# Review 3c: LP_KUMA_PUSH from the file is a script that RUNS, so the file must be mode 600 and owned by the user running this script, else the run stops before it reads anything.
CONF_BAD=''
if [ -f "$CFG/backup.conf" ]; then
  if [ "$(stat -c '%a' "$CFG/backup.conf")" != 600 ] || [ "$(stat -c '%u' "$CFG/backup.conf")" != "$(id -u)" ]; then CONF_BAD=1; fi
fi
# The reader accepts: KEY=value, KEY = value, "quoted" or 'quoted' values, an inline  # comment after an unquoted value, # comment lines, blank lines, a last line with no newline.
# A line it cannot use (no "=", or a key it does not know) is reported on stderr and skipped; it is never run.
if [ -f "$CFG/backup.conf" ] && [ -z "$CONF_BAD" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%$'\r'}
    t=${line#"${line%%[![:space:]]*}"}
    case "$t" in '' | '#'*) continue ;; esac
    case "$t" in *=*) ;; *) echo "backup.conf: ignored line (no '='): $t" >&2; continue ;; esac
    k=${t%%=*}; v=${t#*=}
    k=${k%"${k##*[![:space:]]}"}
    v=${v#"${v%%[![:space:]]*}"}; v=${v%"${v##*[![:space:]]}"}
    case "$v" in
      \"*\"*) v=${v#\"}; v=${v%%\"*} ;;   # "quoted": up to the next quote; anything after it (a comment) is dropped
      \'*\'*) v=${v#\'}; v=${v%%\'*} ;;
      *) v=${v%%[[:space:]]\#*}; v=${v%"${v##*[![:space:]]}"} ;;   # unquoted: an inline " # comment" is dropped
    esac
    case "$k" in
      LP_BK_LOCAL | LP_BK_NAS | LP_BK_MOUNT | LP_BK_KEEP | LP_KUMA_PUSH | LP_D1_NAME) [ -n "${!k+x}" ] || export "$k=$v" ;;
      *) echo "backup.conf: unknown key ignored: $k" >&2 ;;
    esac
  done < "$CFG/backup.conf"
fi
LOCAL=${LP_BK_LOCAL:-$BASE/backups}
NAS=${LP_BK_NAS:-}
MOUNT=${LP_BK_MOUNT-}
MPOINT=${LP_MOUNTPOINT:-mountpoint}
KEEP=${LP_BK_KEEP:-30}
DOCKER=${LP_DOCKER:-docker}
KUMA=${LP_KUMA_PUSH:-}
DBN=${LP_D1_NAME:-liftpad}
MON=liftpad-d1-backup
kuma() { if [ -n "$KUMA" ]; then "$KUMA" "$@"; fi; }
TS=$(date -u +%Y%m%dT%H%M%SZ)
NAME="liftpad-$TS.sql"
PART="$LOCAL/$NAME.part"
ERR="$LOCAL/$NAME.err"   # wrangler's own messages of the export; read on failure, always removed (HANDOFF 11)

fail() {
  echo "$(date -Is) liftpad D1 backup FAILED: $1" >&2
  rm -f "$PART" "${NAS:+$NAS/$NAME.part}" "$ERR"
  kuma "$MON" down "$2" || echo "kuma push (down) also failed" >&2
  exit 1
}
[ -z "$CONF_BAD" ] || fail "backup.conf must be mode 600 and owned by the user who runs this script (it can name a script that runs); it was not read" bad-conf-mode
# Review pass 3a/3b: two config values are used in a shell string / a count, so they are checked before anything runs.
case "$DBN" in '' | *[!A-Za-z0-9_-]*) fail "LP_D1_NAME is not a plain database name (letters, digits, - and _ only)" bad-d1-name ;; esac
case "$KEEP" in '' | *[!0-9]*) fail "LP_BK_KEEP is not a number" bad-keep ;; esac
[ "$KEEP" -ge 1 ] || fail "LP_BK_KEEP must be 1 or more (0 would delete every backup, the new one too)" bad-keep
nightly() { find "$1" -maxdepth 1 -type f -name 'liftpad-2*.sql' 2>/dev/null | sort; }
# The error lines of a failed export (up to 3): colour codes removed, any run of 32 or more letters and digits
# (a token, an account id) masked. When no line says error, denied or fail, the first 3 lines.
wrangler_lines() {
  [ -s "$ERR" ] || return 0
  local clean hit
  clean=$(sed -E 's/\x1b\[[0-9;]*[A-Za-z]//g; s/[A-Za-z0-9_-]{32,}/<masked>/g' "$ERR" | grep -v '^[[:space:]]*$' || true)
  hit=$(printf '%s\n' "$clean" | grep -i -m3 -e error -e denied -e fail || true)
  [ -n "$hit" ] || hit=$(printf '%s\n' "$clean" | sed -n '1,3p')
  printf '%s\n' "$hit"
}
# The export failed: wrangler's lines go to the log, the last one into the Kuma message (letters, digits . _ ~ -).
export_failed() {
  local lines code=""
  lines=$(wrangler_lines)
  if [ -n "$lines" ]; then
    printf '%s\n' "$lines" | sed 's/^/  wrangler said: /' >&2
    # wrangler prints a headline first and the reason last ("Authentication error [code: 10000]"): the last line
    code=$(printf '%s' "$lines" | sed -n '$p' | tr -c 'A-Za-z0-9._~-' '-' | tr -s '-' | sed 's/^-//; s/-$//' | cut -c1-90 || true)
    [ -z "$code" ] || code="-$code"
  fi
  fail "wrangler d1 export failed" "export-failed$code"
}

mkdir -p "$LOCAL" || fail "cannot create $LOCAL" no-local-dir
chmod 700 "$LOCAL" || fail "cannot chmod $LOCAL" no-local-dir
PREV=$(nightly "$LOCAL" | tail -1)

# 1. export (read-only on Cloudflare), into a .part file
"$DOCKER" run --rm -v "$BASE/node_modules":/w/node_modules:ro \
  -v "$CFG/cf.env":/cfg/cf.env:ro -v "$LOCAL":/out -w /out node:22-alpine sh -c \
  ". /cfg/cf.env; export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID; /w/node_modules/.bin/wrangler d1 export $DBN --remote --output=/out/$NAME.part >/out/$NAME.err 2>&1; r=\$?; chown $(id -u):$(id -g) /out/$NAME.part /out/$NAME.err 2>/dev/null; exit \$r" \
  || export_failed
rm -f "$ERR"

# 2. content checks
[ -s "$PART" ] || fail "export is empty" export-empty
ROWS=$(grep -c 'INSERT INTO' "$PART" || true)
[ "$ROWS" -gt 0 ] || fail "export has no INSERT rows" no-rows
grep -q 'CREATE TABLE vehicles' "$PART" && grep -q 'CREATE TABLE vals' "$PART" || fail "export lacks the vehicles or vals table" missing-table
if [ -n "$PREV" ]; then
  PROWS=$(grep -c 'INSERT INTO' "$PREV" || true)
  [ $((ROWS * 100)) -ge $((PROWS * 90)) ] || fail "export has $ROWS INSERT rows, the previous one $PROWS (more than 10% fewer)" row-drop
fi
chmod 600 "$PART"
mv "$PART" "$LOCAL/$NAME" || fail "cannot rename the export" rename-failed

# 3. NAS copy, verified by sha256
A=$(sha256sum "$LOCAL/$NAME" | cut -d' ' -f1)
if [ -n "$NAS" ]; then
  if [ -n "$MOUNT" ]; then "$MPOINT" -q "$MOUNT" || fail "NAS share $MOUNT is not mounted" nas-not-mounted; fi
  [ -d "$NAS" ] || fail "NAS folder $NAS does not exist (make it first; this script never makes it)" nas-missing
  cp "$LOCAL/$NAME" "$NAS/$NAME.part" || fail "copy to the NAS failed" nas-copy
  B=$(sha256sum "$NAS/$NAME.part" | cut -d' ' -f1)
  [ "$A" = "$B" ] || fail "NAS copy differs from the local file" nas-sha
  mv "$NAS/$NAME.part" "$NAS/$NAME" || fail "cannot rename the NAS copy" nas-rename
elif [ "$NAS_ENV_EMPTY" = 1 ]; then
  echo "NAS copy: off (set empty in the environment)"
else
  echo "NAS copy: off (not configured)"
fi
[ -n "$KUMA" ] || echo "Kuma push: off (not configured)"

# 4. keep the newest $KEEP nightly files in each folder
for d in "$LOCAL" ${NAS:+"$NAS"}; do
  nightly "$d" | head -n -"$KEEP" | while IFS= read -r f; do rm -f -- "$f"; done
done

kuma "$MON" up "OK-$ROWS-rows" || echo "kuma push (up) failed; the backup itself is done" >&2
echo "$(date -Is) liftpad D1 backup OK: $NAME, $ROWS INSERT rows, sha256 $A"
