# LiftPad

LiftPad is a small web app for a home garage with a 2-post lift. A tablet on the lift shows one screen per car: lift points, wheel torque, tire pressure, oil, parts and a service log. The same app works on a phone or a laptop.

**Status: beta.** I built it for my own garage and I use it there. The code is public so friends and anyone else can read it, borrow from it or set up their own copy. Expect rough edges.

It runs on Cloudflare: one Worker serves the app and a small API, one D1 database holds the data, and a private R2 bucket holds the guide pages. Cloudflare Access puts a login in front of it. Workers, D1 and R2 are free at this scale. Only the optional research helper costs money (the Anthropic API); see `docs/SETUP.md`, "Costs".

## Screenshots

| | |
|---|---|
| ![A car screen on a tablet](docs/screenshots/tablet-car.png) | ![Lift screen on a tablet](docs/screenshots/tablet-lift.png) |
| A car: one tile per topic, with the state of each. | Lift: the chart, the lift points and the guide page with the chart outlined. |
| ![Parts screen on a tablet](docs/screenshots/tablet-parts.png) | ![A car on a phone](docs/screenshots/phone-car.png) |
| Parts: wipers, filters and fluids for the car. | The same car on a phone. |

The screenshots use the sample data that ships in this repo and a made-up guide. Each screen is described in [docs/SCREENS.md](docs/SCREENS.md).

## What it does

- A list of your cars. Add one by year, make and model, or decode a VIN.
- Lift: the chart and page of your own lift guide, with the chart outlined (see "The lift guide is not included" below).
- Torque: wheel torque in large numbers, with thread and socket.
- Tires: pressure (door jamb placard or manual) and tire size.
- Oil: oil type, quantity in qt and L, filter.
- Parts: wipers, filters and fluids. You enter filters yourself (Add part). An optional research helper looks up wipers and fluids. It does not look up filters and it does not use RockAuto.
- Service log: what was done, when, at what mileage.
- Every value has a confidence (High, Medium, Low), a source and a note. A new value is proposed until you confirm it.
- Make and model lists come from NHTSA vPIC (1981 and later) and from a classics list for older cars.
- Works offline with the last saved data.

## The lift guide is not included

I utilize data from the Automotive Lift Institute (ALI) *Vehicle Lifting Points Guide* for my personal, non-commercial use. You can buy your own printed copy from them here: https://www.autolift.org/product/vehicle-lifting-points-guide/

None of the guide is in this repo: no pages, no chart codes, no index. `docs/LOAD-YOUR-GUIDE.md` shows how LiftPad reads your own copy, including a newer edition next to an older one. Without a guide the Lift screen says "No lift data loaded" and everything else works.

## Set up your own

`docs/SETUP.md` walks through it: Cloudflare token, secrets outside the repo, the private R2 bucket, the deploy, the self-test. Every command says where it runs. You need a Cloudflare account with a domain, Docker, Python 3 and git. It is written for someone comfortable with a terminal. It is not a beginner tutorial.

The always-on box (a small Linux machine for the research helper and nightly backups) is optional. The app works without it. In that case the Admin page shows a grey "no report yet" line, which is normal.

## Hardware - a good starting point

LiftPad is a web app: any modern browser works. None of this hardware is required. This is what it was built and tested on.

| Part | Model | Notes |
|---|---|---|
| Tablet | Lenovo Idea Tab 11, part **ZAFR0923US** (4 GB / 128 GB, Wi-Fi) | 11 in 2560x1600 IPS, 500 nits, 90 Hz; Android 15 |
| Kiosk app | Fully Kiosk Browser PLUS | landscape lock, screen always on, auto-start |
| Mount | VasSmtCPH magnetic tablet holder, model **MTSM-M-001** | rubber-coated base, 12 neodymium magnets, 360 deg ball head |

For a lift screen any 10-11 in tablet works if it is at least 1280x800 CSS pixels in landscape, 400+ nits for a garage, Android 10 or later and 5 GHz Wi-Fi. Mount it on a steel surface at eye level, clear of the carriage, arms and safety locks.

## Data sources

- **NHTSA vPIC** (public US government API) for makes, models and VIN decode. The Worker calls it at run time.
- **Classics list** (older makes such as Studebaker, AMC, Nash, Hudson): `tools/build_classics.py` builds it from Wikidata model names and Wikipedia infobox production years. Wikidata is rate-limited, so the build is slow. Check the result by hand.
- **Lift-point charts:** yours, from your own purchased guide (see above).

## What's next

1) Not fitted rows - a way to say "this car does not have that" instead of leaving a blank.
2) A better source for parts data. Today filters are typed in by hand. Suggestions?
3) Newer lift guide editions. I don't expect to buy a new one every year, but newer vehicles keep coming. A newer edition is added next to the older ones, so older cars keep their charts. Today that takes a few documented steps (`docs/LOAD-YOUR-GUIDE.md`); the goal is a shorter routine.

## Contributing

This is a beta and I am the only one working on it. Issues are on: bug reports and questions are welcome. Pull requests are not merged during the beta, because the next release overwrites this repository from my private one. If you have a fix, put it in an issue and I will take it from there.

## Licence

MIT. See `LICENSE`.
