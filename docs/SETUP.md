# Set up your own LiftPad

This page takes you from nothing to a working LiftPad on your own Cloudflare account. It is written for someone comfortable with a terminal. Each command says where it runs.

What you end up with: a Cloudflare Worker that serves the app and its API, a D1 database, a private R2 bucket for lift-guide page images, and Cloudflare Access in front of all of it so only the people you list can sign in.

LiftPad ships no lift-guide data. See docs/LOAD-YOUR-GUIDE.md to load your own copy once the app runs.

## What you need

- A Cloudflare account and a domain whose DNS is on Cloudflare.
- Cloudflare Zero Trust turned on for the account (the free plan is enough for a few users).
- On your computer: Docker, Python 3 and git.
- Optional, later: a small always-on Linux box with Docker, Python 3 and `cron` for the research worker and the nightly backup.

## 1. Get the code

Runs on your computer.

```sh
git clone <the repository URL> liftpad
```

Work from a copy of the folder, not from your checkout: the deploy edits `wrangler.toml` in place.

## 2. Make a Cloudflare API token

In the Cloudflare dashboard, make an API token with these permissions: Account - D1 Edit, Workers Scripts Edit, Workers R2 Storage Edit, Access: Apps and Policies Edit, Access: Service Tokens Edit; Zone - Workers Routes Edit, DNS Edit (for your domain).

## 3. Put your secrets and settings in two folders outside the repo

Runs on your computer. Example folders: `~/.config/liftpad/` for secrets, `~/liftpad-private/` for your private data. Neither is ever committed.

`~/.config/liftpad/cf.env` (mode 600):

```
CLOUDFLARE_API_TOKEN=<your token>
CLOUDFLARE_ACCOUNT_ID=<your account id>
```

`~/liftpad-private/deploy.env`:

```
LP_HOSTNAME=lift.example.com
LP_ACCESS_EMAIL=you@example.com
LP_ACCESS_TEAM=yourteam.cloudflareaccess.com
```

`LP_ACCESS_TEAM` is your Zero Trust team domain (Zero Trust dashboard, Settings). The Worker uses it to check the Access login proof. Two optional lines: `LP_D1_NAME` sets the database name (default `liftpad`) and `LP_R2_BUCKET` sets the name of the private bucket (default `liftpad-private`; bucket names are unique inside your account only).

## 4. Create the private R2 bucket

Runs on your computer. The deploy binds the bucket but does not create it.

```sh
docker run --rm --env-file ~/.config/liftpad/cf.env node:22-alpine npx wrangler@3.114.0 r2 bucket create liftpad-private
```

Use the name from `LP_R2_BUCKET` if you set one. Leave "Public access" off (the default): the Worker reads the bucket through its own binding and serves a page only to a signed-in user.

## 5. Deploy

Runs on your computer, in a copy of the app folder.

```sh
docker run --rm -v "$PWD":/app -v ~/.config/liftpad:/cfg -v ~/liftpad-private:/private node:22-alpine sh /app/tools/deploy.sh
```

The deploy creates the Access app and a login policy for your email, two service tokens (one for the self-test, one for the research worker; saved to `svc.env` and `processor.env` in `~/.config/liftpad/`), the D1 database, the R2 bucket binding and the Worker. It fills in `wrangler.toml` from the placeholders in the template. It loads the database only when the database is empty: the makes list and two example cars from `db/seed-public.sql`. `-e RESEED=1` wipes the database and loads it again, which deletes the cars you added.

Migrations: `tools/migrate.sh` applies the files in `db/migrations/` in order and writes a backup first. The deploy loads a new, empty database itself. When you update an existing install, run the plan by hand: `sh tools/migrate.sh` is a dry run, `sh tools/migrate.sh --apply` applies it (set `LP_BACKUP_DIR` to a folder you own, outside git).

## 6. Self-test

Runs on your computer, in the app folder. The deploy saved the self-test service token in `~/.config/liftpad/svc.env`.

```sh
docker run --rm --env-file ~/.config/liftpad/svc.env -v "$PWD":/app -w /app node:22-alpine node test/selftest.js https://lift.example.com
```

The test adds and removes cars named `SELFTEST`. It uses a token that is allowed to change only those cars.

## 7. Open the app

Go to your hostname, sign in with the email you put in `deploy.env`, and add your first car. The Lift tile says "No lift data loaded" until you follow docs/LOAD-YOUR-GUIDE.md.

## Optional: the always-on box

The Worker runs without a box. The box adds two things: a research worker that looks up values you did not enter, and a nightly backup of the database. Both read the same two folders, set by environment variables:

- `LP_CFG_DIR` - secrets and settings (default `~/.config/liftpad`)
- `LP_BASE_DIR` - logs, state and private data (default `~/liftpad`)

Copy the `ops/` folder and `tools/` folder to the box. Copy `cf.env` and `processor.env` into the config folder (mode 600).

### Research worker

The worker takes one queued job per run. It asks the Anthropic API, with web search, for the values a car needs. Every value it posts is `proposed`: nothing counts until you confirm it in the app. Filters are not researched: you enter them with Add part. The worker looks up wipers and fluids only. It never opens rockauto.com, whose robots.txt blocks automated access.

1. Put your Anthropic API key in `~/.config/liftpad/anthropic.env` (mode 600):

   ```
   ANTHROPIC_API_KEY=<your key>
   ```

2. Copy `deploy.env` to `$LP_BASE_DIR/private-data/deploy.env`.
3. Optional limits in `~/.config/liftpad/research.json`. The defaults are 10 jobs and 2 USD a day. Any key you leave out keeps its default; an unknown key stops the run:

   ```json
   {"daily_job_cap": 5, "daily_cost_cap": 1.0}
   ```

4. Check it by hand: `python3 ops/research_worker.py`. Exit 0 is normal; 2 means a setup problem and the message says which file.
5. In `cron` (Linux box), every 10 minutes:

   ```
   */10 * * * * python3 /path/to/ops/research_worker.py
   ```

Automatic research is off in a new install: the Worker is deployed with `LP_AUTO_RESEARCH=0` (set `LP_AUTO_RESEARCH=1` in the deploy command's environment, `-e LP_AUTO_RESEARCH=1`, to turn it on). With it off, the Worker does not queue a research job by itself when you open a car.

### Nightly backup

`ops/backup_d1.sh` exports the database, checks the file, keeps the newest 30 and optionally copies it to a second folder (a share or another disk). Settings go in `~/.config/liftpad/backup.conf` as plain `KEY=VALUE` lines:

```
LP_BK_LOCAL=/home/you/liftpad/backups
LP_BK_NAS=/mnt/share/liftpad
LP_BK_MOUNT=/mnt/share
```

Every key is optional. Leave `LP_BK_NAS` out for no second copy. `LP_KUMA_PUSH` can name a script that reports the result to Uptime Kuma. Run it by hand once (`bash ops/backup_d1.sh`), then in `cron`:

```
30 3 * * * bash /path/to/ops/backup_d1.sh
```

To restore a backup into an empty D1 database: `wrangler d1 execute <name> --remote --file <backup.sql>`.

## Costs

Cloudflare Workers, D1 and R2 are free at this scale. The research worker uses the Anthropic API, which costs money; `daily_cost_cap` is a stop based on an estimate, not a bill. Set a spend limit in the Anthropic console as well.

## If something fails

- The deploy stops on the first problem and says what is missing. Nothing is half-applied that the deploy cannot detect on the next run.
- "wrangler.toml is already filled": the deploy ran before. Start from a fresh copy of the folder.
- A sign-in loop or 403 on the API: check `LP_ACCESS_TEAM` and that your email is in the Access policy.
