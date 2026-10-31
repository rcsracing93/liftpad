#!/bin/sh
# LiftPad deploy. Runs inside node:22-alpine. See README for the full docker command.
# Mounts:  /app     a build copy of the committed tree (git archive) - this script edits it
#          /cfg     cf.env (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID) and svc.env. Never printed.
#          /private deploy.env (LP_HOSTNAME, LP_ACCESS_EMAIL, LP_ACCESS_TEAM, optional LP_D1_NAME) and,
#                   optional, seed-private.sql. Pre-migration backups go to /private/backups.
# Changes: Cloudflare - creates the Access app, its policies, the self-test and the processor
#          service tokens only if they do not exist; creates D1 $LP_D1_NAME (default "liftpad")
#          if absent; changes D1 only through tools/d1_load.sh (empty database: migrations +
#          seed; pending migrations: only with -e LP_APPLY_MIGRATIONS=1, after a verified
#          backup); deploys the Worker with the Access values as Worker variables.
# Optional env: LP_BUILD (the git commit of the build copy; shown as "build" by /api/health, null when not set).
#          LP_DEPLOY_DRY=1 (Rick 2026-10-27): a dry run with the real config. Everything is read and checked as in a deploy, the
#          build copy is filled and every guard runs, then "wrangler deploy --dry-run" builds the Worker and uploads nothing.
#          Anything a deploy would CREATE (Access app, policy, token, D1) stops the dry run instead. The D1 step reads the migration
#          plan only; pending migrations other than LP_DRY_ALLOW_PENDING (a space list, e.g. "0010") stop it. Mount /cfg and /private
#          read-only for it. Changes: only the build copy.
# shellcheck disable=SC3040 # runs under busybox ash (node:22-alpine), which has pipefail; STANDARD 11.4
set -euo pipefail
# 2026-10-27 (yes deploy A, step 6 failed): the build copy must hold the committed placeholders. A copy that another tool filled before
# (the migration step filled the host with live.invalid) deployed a wrong route. Checked first, before any Cloudflare call.
for p in '"__LP_HOSTNAME__"' '"__LP_D1_NAME__"' '"__LP_D1_ID__"'; do
  grep -q "$p" /app/wrangler.toml || { echo "STOP: wrangler.toml is already filled ($p is missing). Deploy from a fresh build copy. Nothing was changed."; exit 1; }
done
DRY=${LP_DEPLOY_DRY:-0}
# need WHAT: a real deploy would create WHAT here; a dry run stops instead.
need() { if [ "$DRY" = 1 ]; then echo "STOP (dry run): $1 is missing - a real deploy would create it"; exit 1; fi; }
[ "$DRY" = 1 ] && echo "DRY RUN: nothing is created or uploaded"
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
  need "the Access app for $LP_HOSTNAME"
  APP=$(cf -X POST "$API/accounts/$A/access/apps" -d "$(jq -n --arg h "$LP_HOSTNAME" '{name:"LiftPad",domain:$h,type:"self_hosted",session_duration:"720h",app_launcher_visible:false}')" | tee /tmp/app.json | jq -r '.result.id // empty')
  [ -n "$APP" ] || { echo "Access app create FAILED:"; jq -c '.errors' /tmp/app.json; exit 1; }
  echo "Access app created"
else echo "Access app exists"; fi
if [ ! -s /cfg/svc.env ]; then
  need "the self-test service token (svc.env)"
  cf -X POST "$API/accounts/$A/access/service_tokens" -d '{"name":"liftpad-selftest","duration":"8760h"}' > /tmp/svc.json
  jq -e '.success' /tmp/svc.json >/dev/null || { echo "service token FAILED:"; jq -c '.errors' /tmp/svc.json; exit 1; }
  umask 077; jq -r '"CF_ACCESS_CLIENT_ID=" + .result.client_id + "\nCF_ACCESS_CLIENT_SECRET=" + .result.client_secret + "\nSVC_ID=" + .result.id' /tmp/svc.json > /cfg/svc.env; rm /tmp/svc.json
  echo "service token created and saved to svc.env"
fi
. /cfg/svc.env
NPOL=$(cf "$API/accounts/$A/access/apps/$APP/policies" | jq '.result | length')
if [ "$NPOL" = "0" ]; then
  need "the Access policies"
  cf -X POST "$API/accounts/$A/access/apps/$APP/policies" -d "$(jq -n --arg e "$LP_ACCESS_EMAIL" '{name:"owner",decision:"allow",precedence:1,include:[{email:{email:$e}}]}')" | jq -r '"policy owner: " + (if .success then "ok" else (.errors|tostring) end)'
  cf -X POST "$API/accounts/$A/access/apps/$APP/policies" -d "$(jq -n --arg t "$SVC_ID" '{name:"selftest token",decision:"non_identity",precedence:2,include:[{service_token:{token_id:$t}}]}')" | jq -r '"policy selftest: " + (if .success then "ok" else (.errors|tostring) end)'
else echo "policies exist: $NPOL"; fi
SELF_ID=$CF_ACCESS_CLIENT_ID

# Processor service token (Handoff 2, decision 6; the one Access change Rick approved 2026-10-16):
# a separate token, saved to processor.env, with its own policy "processor token". Created only
# if missing; the policies above are never changed.
if [ ! -s /cfg/processor.env ]; then
  need "the processor service token (processor.env)"
  cf -X POST "$API/accounts/$A/access/service_tokens" -d '{"name":"liftpad-processor","duration":"8760h"}' > /tmp/proc.json
  jq -e '.success' /tmp/proc.json >/dev/null || { echo "processor token FAILED:"; jq -c '.errors' /tmp/proc.json; exit 1; }
  umask 077; jq -r '"CF_ACCESS_CLIENT_ID=" + .result.client_id + "\nCF_ACCESS_CLIENT_SECRET=" + .result.client_secret + "\nSVC_ID=" + .result.id' /tmp/proc.json > /cfg/processor.env; rm /tmp/proc.json
  echo "processor token created and saved to processor.env"
fi
# (svc.env, sourced above, set the same variable names for the self-test token: unset them first, so a processor.env without them gives an empty id, never the self-test id)
PROC_ID=$(unset CF_ACCESS_CLIENT_ID; . /cfg/processor.env; printf '%s' "${CF_ACCESS_CLIENT_ID:-}")
PROC_SVC=$(unset SVC_ID; . /cfg/processor.env; printf '%s' "${SVC_ID:-}")
# HANDOFF 20 (E9, review fix 3): an empty id must never match anything. Stop before the policy step (and before any later change).
[ -n "$PROC_ID" ] && [ -n "$PROC_SVC" ] || { echo "STOP: processor.env has no CF_ACCESS_CLIENT_ID or SVC_ID (the processor token id)"; exit 1; }
# HANDOFF 20 (E9, TODO 5): a processor-policy failure stops the deploy. The policy must exist AND name the processor token of processor.env (a rotated
# token with an old policy would lock the research worker out), and a failed create is an error, not a line of text. Dry run and real run both stop.
POLS=$(cf "$API/accounts/$A/access/apps/$APP/policies")
if printf '%s' "$POLS" | jq -e '.result | any(.name == "processor token")' >/dev/null; then
  printf '%s' "$POLS" | jq -e --arg t "$PROC_SVC" '[.result[] | select(.name == "processor token") | .include[]? | .service_token.token_id? | select(. != null and . != "")] | any(. == $t)' >/dev/null \
    || { echo "STOP: the Access policy 'processor token' does not name the processor token of processor.env"; exit 1; }
  echo "processor policy exists"
else
  need "the processor Access policy"
  PREC=$(( $(printf '%s' "$POLS" | jq '[.result[].precedence] | max // 0') + 1 ))
  PRES=$(cf -X POST "$API/accounts/$A/access/apps/$APP/policies" -d "$(jq -n --arg t "$PROC_SVC" --argjson p "$PREC" '{name:"processor token",decision:"non_identity",precedence:$p,include:[{service_token:{token_id:$t}}]}')")
  printf '%s' "$PRES" | jq -e '.success' >/dev/null || { echo "STOP: policy processor FAILED: $(printf '%s' "$PRES" | jq -c '.errors // "no answer"' 2> /dev/null || echo "no answer")"; exit 1; }
  echo "policy processor: ok"
fi
# What the Worker needs to check an Access JWT: the app's AUD tag and the team's certs URL.
# The team domain comes from deploy.env (LP_ACCESS_TEAM, e.g. myteam.cloudflareaccess.com):
# reading it from the API needs an Access-organizations permission the deploy token does not have.
AUD=$(cf "$API/accounts/$A/access/apps/$APP" | jq -r '.result.aud // empty')
TEAM=${LP_ACCESS_TEAM:-}
[ -n "$AUD" ] && [ -n "$TEAM" ] && [ -n "$PROC_ID" ] && [ -n "$SELF_ID" ] || { echo "STOP: missing Access AUD, LP_ACCESS_TEAM in deploy.env, or token ids"; exit 1; }

step "C D1"
[ -d node_modules/wrangler ] || npm i --silent --no-audit --no-fund wrangler@3.114.0 >/dev/null 2>&1
DBN=${LP_D1_NAME:-liftpad}; export LP_D1_NAME="$DBN"
DB=$(npx wrangler d1 list --json 2>/dev/null | jq -r --arg n "$DBN" 'first(.[] | select(.name==$n) | .uuid) // empty')
if [ -z "$DB" ]; then
  need "the D1 database $DBN"
  npx wrangler d1 create "$DBN" >/tmp/d1.txt 2>&1 || { tail -5 /tmp/d1.txt; exit 1; }
  DB=$(grep -o '[0-9a-f]\{8\}-[0-9a-f-]\{27\}' /tmp/d1.txt | head -1); echo "D1 created"
else echo "D1 exists"; fi
[ -n "$DB" ] || { echo "STOP: no D1 id"; exit 1; }
sed -i -e "s/__LP_D1_ID__/$DB/" -e "s/__LP_D1_NAME__/$DBN/" -e "s/__LP_HOSTNAME__/$LP_HOSTNAME/" wrangler.toml
# Quoted values only: the comment at the top of wrangler.toml also names __LP_.
if grep -q '"__LP_' wrangler.toml; then echo "STOP: wrangler.toml still has a placeholder"; exit 1; fi
# The app icons are built here, not kept in git (the repo admits no .svg and ignores .png). HANDOFF 18 (C9): tools/make_icons.py draws
# public/icon.svg and public/icons/*.png from one description of the mark.
command -v python3 > /dev/null 2>&1 || apk add --no-cache python3 > /dev/null 2>&1 || apt-get install -y -qq python3 > /dev/null 2>&1   # the node:22-alpine deploy image has none
python3 -I tools/make_icons.py public > /dev/null || { echo "STOP: the icons could not be made"; exit 1; }
if [ "$DRY" = 1 ]; then
  # The dry run reads the migration plan only (no table check write path, no migration). Pending migrations must be in the allowed list.
  sh tools/migrate.sh > /tmp/plan.txt 2>&1 || { cat /tmp/plan.txt; echo "STOP (dry run): the migration plan failed"; exit 1; }
  grep -e '^migrate: database' -e '^migrate: pending' /tmp/plan.txt
  PEND=$(sed -n 's/^migrate: pending: *//p' /tmp/plan.txt)
  for m in $PEND; do
    case " ${LP_DRY_ALLOW_PENDING:-} none " in *" $m "*) ;; *) echo "STOP (dry run): migration $m is pending and not allowed"; exit 1 ;; esac
  done
  echo "migrations: pending '${PEND}' is allowed (${LP_DRY_ALLOW_PENDING:-none}); a real deploy needs them applied first"
else
  sh tools/d1_load.sh "$SEED"
fi

step "D deploy"
# The Access values go in as Worker variables, never into git. Lines naming them are not shown.
WDRY=''; [ "$DRY" = 1 ] && WDRY='--dry-run --outdir /tmp/dry-out'
# shellcheck disable=SC2086 # WDRY is empty or two flags, split on purpose
npx wrangler deploy $WDRY --var "LP_ACCESS_CERTS:https://$TEAM/cdn-cgi/access/certs" --var "LP_ACCESS_AUD:$AUD" \
  --var "LP_PROCESSOR_IDS:$PROC_ID" --var "LP_TOOL_IDS:$SELF_ID,$PROC_ID" --var "LP_AUTO_RESEARCH:${LP_AUTO_RESEARCH:-0}" --var "LP_D1_PLAN:${LP_D1_PLAN:-free}" --var "LP_ADMIN_EMAILS:$LP_ACCESS_EMAIL" ${LP_BUILD:+--var "LP_BUILD:$LP_BUILD"} 2>&1 | grep -v -i -e token -e 'LP_' | tail -8
if [ "$DRY" = 1 ]; then
  [ -s /tmp/dry-out/worker.js ] || { echo "STOP (dry run): wrangler built no worker.js"; exit 1; }
  echo "dry run: Worker built ($(wc -c < /tmp/dry-out/worker.js) bytes), nothing uploaded"
  echo; echo "DRY RUN DONE"
else echo; echo "DEPLOY DONE"; fi
