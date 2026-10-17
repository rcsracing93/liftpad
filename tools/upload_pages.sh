#!/bin/sh
# LiftPad: put the rendered ALI page images of one folder into R2 (key ali/<edition>/p<NNN>.jpg).
# Run (in node:22 with wrangler 3.114.0, from the app folder; BusyBox sh or dash):
#   sh tools/upload_pages.sh DIR     DIR = the render_pages.py output (p<NNN>.jpg + ali-pages.csv)
# Env: LP_R2_BUCKET (default liftpad-private); WRANGLER (default "npx wrangler");
#      LP_R2_LOCAL=1 puts into the local R2 of `wrangler dev` (.wrangler/state);
#      without it the upload goes to Cloudflare and is refused unless LP_R2_REMOTE_APPROVED=1
#      (Rick approves it). wrangler 3.114 has no --remote flag: no --local means Cloudflare.
# Checks first that every 'ok' row of ali-pages.csv has its file with the listed size; then one
#      put per page with content type image/jpeg. Stops at the first failed put.
# Changes: R2 objects under ali/<edition>/ only. Never deletes.
# Exit: 0 done; 2 bad arguments or setup; 3 a file is missing or its size differs (nothing put);
#       4 a put failed (pages before it are in R2; running again puts them again, same content).
set -eu
DIR=${1:-}
[ "$#" = 1 ] && [ -f "$DIR/ali-pages.csv" ] || { echo "usage: upload_pages.sh DIR (DIR/ali-pages.csv must exist)" >&2; exit 2; }
B=${LP_R2_BUCKET:-liftpad-private}
W=${WRANGLER:-npx wrangler}
if [ "${LP_R2_LOCAL:-}" = 1 ]; then WHERE=--local; else
  [ "${LP_R2_REMOTE_APPROVED:-}" = 1 ] || { echo "upload_pages: an upload to Cloudflare R2 needs LP_R2_REMOTE_APPROVED=1 (Rick's approval)" >&2; exit 2; }
  WHERE=""
fi
CR=$(printf '\r')
n=0; total=0
while IFS=, read -r ed pdf _gp st _w _h bytes; do
  bytes=${bytes%"$CR"}   # a CSV with CRLF line ends (Python csv, Excel)
  [ "$st" = ok ] || continue
  f="$DIR/p$(printf '%03d' "$pdf").jpg"
  [ -f "$f" ] || { echo "upload_pages: missing $f - nothing put" >&2; exit 3; }
  [ "$(wc -c < "$f" | tr -d ' ')" = "$bytes" ] || { echo "upload_pages: $f size differs from ali-pages.csv - nothing put" >&2; exit 3; }
  n=$((n + 1)); total=$((total + bytes))
done < "$DIR/ali-pages.csv"
[ "$n" -gt 0 ] || { echo "upload_pages: no ok rows in ali-pages.csv" >&2; exit 3; }
echo "upload_pages: $n pages, $total bytes, to $B ${WHERE:-(Cloudflare)}"
i=0
while IFS=, read -r ed pdf _gp st _w _h _bytes; do
  [ "$st" = ok ] || continue
  k="ali/$ed/p$(printf '%03d' "$pdf").jpg"
  # shellcheck disable=SC2086 # W may be "npx wrangler"; WHERE is empty or --local
  $W r2 object put "$B/$k" --file "$DIR/p$(printf '%03d' "$pdf").jpg" --content-type image/jpeg $WHERE > /dev/null 2>&1 \
    || { echo "upload_pages: FAILED at $k after $i pages" >&2; exit 4; }
  i=$((i + 1))
done < "$DIR/ali-pages.csv"
echo "upload_pages: done, $i pages put"
