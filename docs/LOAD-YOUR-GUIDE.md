# Load your own lift guide

LiftPad ships without any lift-point guide. A fresh install shows "No lift data loaded" on the Lift tile and the Lift screen. This page shows how to load a guide you bought, for your own use.

The tools below read your PDF and your index, and put the page images in your own private storage. Nothing here sends a page anywhere else. Do not put the guide, its page images or your index into a public repo.

## What you need

- Your own copy of the guide as a PDF with page numbers that match the index. (A PDF with a text layer makes the index easier to build; the tools only need page numbers.)
- A computer with `python3` and poppler (`pdftoppm`, `pdfinfo`). On macOS: `brew install poppler`. On Debian or Ubuntu: `apt install poppler-utils`.
- Node 22 and `wrangler` 3.114.0, from the app folder (the folder that holds `wrangler.toml`). See docs/SETUP.md.
- A private R2 bucket and a D1 database, already created and migrated (docs/SETUP.md).
- A working folder outside git. Below it is called `PRIVATE_DIR`. Example: `~/liftpad-private`.

## Step 1. Build the index CSV

One row per make, model and year range, saying which chart and which page of the guide covers it. Save it as `PRIVATE_DIR/ali-index.csv` (UTF-8, header row, commas).

| column | meaning |
|---|---|
| `make` | the make, as the guide spells it |
| `model` | the model, as the guide spells it |
| `year_from`, `year_to` | first and last model year (whole numbers) |
| `chart` | the chart code the guide prints for this car |
| `guide_page` | the page number printed in the guide |
| `pdf_page` | the page number in your PDF (counting from 1); empty if the page is not in your PDF |
| `status` | `ok`, or `missing_from_scan` (the value the code uses; it means "page not in your PDF") when `pdf_page` is empty |
| `note` | free text, can be empty |
| `edition` | optional; the edition label, for example `2019`. Default `2019` for `ali-index.csv` |

Three made-up example rows (the codes `XX-1`, `XX-2` and `XX-3` do not exist in any real guide):

```csv
make,model,year_from,year_to,chart,guide_page,pdf_page,status,note,edition
Honda,Civic,2012,2022,XX-1,1,1,ok,,2019
Ford,Mustang,1965,1973,XX-2,2,2,ok,,2019
Ford,Maverick,1970,1977,XX-3,9,,missing_from_scan,page not in my PDF,2019
```

A make that LiftPad does not know yet is added to the make list by the import. Cars are matched by make, model and year, so spell them the way you enter your own cars.

## Step 2. Render the pages

Run on your computer, in the app folder:

```sh
python3 tools/render_pages.py YOUR-GUIDE.pdf 2019 PRIVATE_DIR/ali-pages/2019 PRIVATE_DIR/ali-index.csv
```

This writes one JPEG per PDF page (`p001.jpg`, `p002.jpg`, ...) and `ali-pages.csv` into `PRIVATE_DIR/ali-pages/2019`. `2019` is the edition label: use the same label in the index. It only writes into the output folder.

## Step 3. Upload the pages to your private bucket

Run in the app folder. First try it against the local storage of `wrangler dev`. This needs no bucket name and no Cloudflare account; the tool uses the default bucket name, which is the one `wrangler dev` reads:

```sh
LP_R2_LOCAL=1 sh tools/upload_pages.sh PRIVATE_DIR/ali-pages/2019
```

For your real Cloudflare bucket, add your approval and leave out `LP_R2_LOCAL`:

```sh
LP_R2_REMOTE_APPROVED=1 LP_R2_BUCKET=YOUR-BUCKET sh tools/upload_pages.sh PRIVATE_DIR/ali-pages/2019
```

The tool checks every file and size first, then puts each page at `ali/<edition>/pNNN.jpg`. It never deletes. Running it again puts the same pages again. The bucket must stay private: the app serves a page only to a signed-in user.

## Step 4. Import the index

Run in the app folder. `LP_BACKUP_DIR` is where the backup of your database is written before a change; use a folder you own.

Dry run (changes nothing, prints what would be added):

```sh
LP_BACKUP_DIR=PRIVATE_DIR/backups python3 tools/import.py PRIVATE_DIR
```

When the numbers look right, apply it:

```sh
LP_BACKUP_DIR=PRIVATE_DIR/backups python3 tools/import.py PRIVATE_DIR --apply
```

Add `LP_D1_LOCAL=1` to try it on a local database first. The import writes a verified backup before it changes anything, adds rows, and checks itself afterwards. It never deletes unless you pass `--prune` together with `--apply` and `LP_PRUNE_APPROVED=1`.

## Step 5. Check in the app

Open the app and a car the index covers. The Lift tile shows the chart code and the Lift screen shows the page. A car the index does not cover says there is no chart for it in the guide. If the whole app still says "No lift data loaded", the import did not add any `ali_index` row: look at the dry run.

## Add a newer edition

Guides come out in new editions. Add the new one next to the old one; never replace it.

1. Make a second index file named `PRIVATE_DIR/ali-index-<edition>.csv`, for example `ali-index-2026.csv`. The edition label comes from the file name. Same columns as above.
2. Render its pages into their own folder: `python3 tools/render_pages.py NEW-GUIDE.pdf 2026 PRIVATE_DIR/ali-pages/2026 PRIVATE_DIR/ali-index-2026.csv`
3. Upload that folder (Step 3) and import (Step 4). The pages of the old edition stay where they are.

How the app picks a chart: for a car, the newest edition that lists it wins. "Newest" is the edition label sorted as text, so use four-digit years (`2019`, `2026`), not `v2`. A car that only the older edition lists keeps its older chart. To compare editions for your own cars, open the car, then look at the Lift screen: its header shows "ALI" and the edition the page comes from. Check your own cars after each import, and compare the chart code and the page between the editions before you rely on a changed number.

## Keep it private

- `PRIVATE_DIR` stays outside the repo. `git status` should never list a page image, an index CSV or a seed file.
- LiftPad's export check refuses a literal guide row, a page path or a chart code in anything that goes to a public repo, but it can only protect what it knows about. You are the last check.
- Your guide is licensed to you. Read its terms before you share a copy with anyone.
