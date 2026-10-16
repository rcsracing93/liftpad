#!/bin/sh
# LiftPad deploy. Runs inside node:22-alpine. See README for the full docker command.
# Mounts:  /app     a build copy of the committed tree (git archive) - this script edits it
#          /cfg     cf.env (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID) and svc.env. Never printed.
#          /private deploy.env (LP_HOSTNAME, LP_ACCESS_EMAIL, optional LP_D1_NAME) and,
#                   optional, seed-private.sql. RESEED backups go to /private/backups.
# Changes: Cloudflare - creates the Access app, its 2 policies and the self-test service token
#          only if they do not exist; creates D1 $LP_D1_NAME (default "liftpad") if absent;
#          loads D1 only through tools/d1_load.sh (absent table, or RESEED=1 after a
#          verified backup); deploys the Worker.
# shellcheck disable=SC3040 # runs under busybox ash (node:22-alpine), which has pipefail; STANDARD 11.4
set -euo pipefail
cd /app
[ -f /private/deploy.env ] || { echo "STOP: /private/deploy.env not found (needs LP_HOSTNAME and LP_ACCESS_EMAIL)"; exit 1; }
. /private/deploy.env
[ -n "${LP_HOSTNAME:-}" ] && [ -n "${LP_ACCESS_EMAIL:-}" ] || { echo "STOP: deploy.env must set LP_HOSTNAME and LP_ACCESS_EMAIL"; exit 1; }
. /cfg/cf.env; export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID
A=$CLOUDFLARE_ACCOUNT_ID; API=https://api.cloudflare.com/client/v4
apk add --no-cache curl jq >/dev/null 2>&1
cf() { curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" "$@"; }
step() { echo; echo "== $*"; }
SEED=/app/db/seed-public.sql
[ -f /private/seed-private.sql ] && SEED=/private/seed-private.sql

step "A token check"
cf "$API/user/tokens/verify" | jq -r '"token status: " + (.result.status // "FAILED") + " " + ((.errors // []) | map(.message) | join(";"))'
cf "$API/accounts/$A" | jq -r '"account: " + (.result.name // ("FAILED " + ((.errors // []) | map(.message) | join(";"))))'

step "B Access"
APP=$(cf "$API/accounts/$A/access/apps" | jq -r --arg h "$LP_HOSTNAME" 'first(.result[]? | select(.domain==$h) | .id) // empty')
if [ -z "$APP" ]; then
  APP=$(cf -X POST "$API/accounts/$A/access/apps" -d "$(jq -n --arg h "$LP_HOSTNAME" '{name:"LiftPad",domain:$h,type:"self_hosted",session_duration:"720h",app_launcher_visible:false}')" | tee /tmp/app.json | jq -r '.result.id // empty')
  [ -n "$APP" ] || { echo "Access app create FAILED:"; jq -c '.errors' /tmp/app.json; exit 1; }
  echo "Access app created"
else echo "Access app exists"; fi
if [ ! -s /cfg/svc.env ]; then
  cf -X POST "$API/accounts/$A/access/service_tokens" -d '{"name":"liftpad-selftest","duration":"8760h"}' > /tmp/svc.json
  jq -e '.success' /tmp/svc.json >/dev/null || { echo "service token FAILED:"; jq -c '.errors' /tmp/svc.json; exit 1; }
  umask 077; jq -r '"CF_ACCESS_CLIENT_ID=" + .result.client_id + "\nCF_ACCESS_CLIENT_SECRET=" + .result.client_secret + "\nSVC_ID=" + .result.id' /tmp/svc.json > /cfg/svc.env; rm /tmp/svc.json
  echo "service token created and saved to svc.env"
fi
. /cfg/svc.env
NPOL=$(cf "$API/accounts/$A/access/apps/$APP/policies" | jq '.result | length')
if [ "$NPOL" = "0" ]; then
  cf -X POST "$API/accounts/$A/access/apps/$APP/policies" -d "$(jq -n --arg e "$LP_ACCESS_EMAIL" '{name:"owner",decision:"allow",precedence:1,include:[{email:{email:$e}}]}')" | jq -r '"policy owner: " + (if .success then "ok" else (.errors|tostring) end)'
  cf -X POST "$API/accounts/$A/access/apps/$APP/policies" -d "$(jq -n --arg t "$SVC_ID" '{name:"selftest token",decision:"non_identity",precedence:2,include:[{service_token:{token_id:$t}}]}')" | jq -r '"policy selftest: " + (if .success then "ok" else (.errors|tostring) end)'
else echo "policies exist: $NPOL"; fi

step "C D1"
[ -d node_modules/wrangler ] || npm i --silent --no-audit --no-fund wrangler@3.114.0 >/dev/null 2>&1
DBN=${LP_D1_NAME:-liftpad}; export LP_D1_NAME="$DBN"
DB=$(npx wrangler d1 list --json 2>/dev/null | jq -r --arg n "$DBN" 'first(.[] | select(.name==$n) | .uuid) // empty')
if [ -z "$DB" ]; then
  npx wrangler d1 create "$DBN" >/tmp/d1.txt 2>&1 || { tail -5 /tmp/d1.txt; exit 1; }
  DB=$(grep -o '[0-9a-f]\{8\}-[0-9a-f-]\{27\}' /tmp/d1.txt | head -1); echo "D1 created"
else echo "D1 exists"; fi
[ -n "$DB" ] || { echo "STOP: no D1 id"; exit 1; }
sed -i -e "s/__LP_D1_ID__/$DB/" -e "s/__LP_D1_NAME__/$DBN/" -e "s/__LP_HOSTNAME__/$LP_HOSTNAME/" wrangler.toml
# Quoted values only: the comment at the top of wrangler.toml also names __LP_.
if grep -q '"__LP_' wrangler.toml; then echo "STOP: wrangler.toml still has a placeholder"; exit 1; fi
# The app icon is built here, not kept in git (the repo admits no .svg).
printf '%s\n' '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#e0a100"/><path d="M14 50V14h6v36zM44 50V14h6v36zM20 30h24v5H20z" fill="#141716"/></svg>' > public/icon.svg
sh tools/d1_load.sh "$SEED"

step "D deploy"
npx wrangler deploy 2>&1 | grep -v -i token | tail -8
echo; echo "DEPLOY DONE"
