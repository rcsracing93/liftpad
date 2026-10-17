# LiftPad screens

One section per screen: what it is for, who uses it, and the main actions. The screenshots use sample data. The ALI lifting-point guide is not included in this repo: the Lift screenshot shows a drawn sample page instead.

LiftPad runs in any modern browser. It is built for three kinds of screen:

- **Lift screen**: a tablet in landscape on the lift post (1280x800 CSS pixels, 64 px touch targets).
- **Phone**: in your hand next to the car (48 px touch targets). Door-jamb and VIN photos are taken here.
- **Mac** (or any laptop): for typing values and drawing chart outlines with a mouse or trackpad.

## Home - my cars

![Home screen on a tablet: my cars as tiles, frequent cars, visitors](screenshots/tablet-home.png)

What it is for: pick the car that is on the lift.
Who uses it: lift screen, phone, Mac.
Main actions:

- Tap a car tile. Each tile says what needs attention: a warning, values to confirm, or "All values confirmed".
- **Needs confirming** (with its count) opens the list of proposed values.
- **+ Car** adds a car by make, year and model, or by VIN.
- Visitors are hidden 30 days after the last visit. Mark a visitor Frequent to keep it.

## Lift tab

![Lift tab on a tablet: chart, lift points and the page with the chart outlined](screenshots/tablet-lift.png)

What it is for: where to put the lift pads.
Who uses it: lift screen, mainly.
Main actions:

- Read the chart for this car and the lift points. A warning (for example "keep pads off the battery pack") shows at the top.
- The page of your own copy of the lift guide shows on the right, with the chart outlined, and **Use chart ...** in large text.
- Tap the page to open it full screen: pinch to zoom, drag, double-tap, Fit page. On a Mac, **Outline this chart** draws the box once for every car on that chart.

## Torque tab

![Torque tab on a tablet: wheel torque in large numbers, thread and socket](screenshots/tablet-torque.png)

What it is for: wheel nut torque, thread and socket.
Who uses it: lift screen.
Main actions:

- Read the torque in large numbers, with its confidence word (High, Medium, Low), its status (Confirmed or Proposed) and its source.
- When the car has no value yet, the make's typical value shows, marked Low and "not confirmed". A usual range for the thread is a sanity check only.
- **Look it up yourself** lists sites to check. LiftPad never reads them for you; a tap fills the Source box.

## Oil tab

![Oil tab on a tablet: oil type, quantity in quarts and litres, filter](screenshots/tablet-oil.png)

What it is for: oil type, quantity and filter.
Who uses it: lift screen, Mac.
Main actions:

- Read the oil type, the quantity in both units (with filter) and the filter part number.
- Add a value with a grade list, qt or L, and a brand list. A battery-electric car shows "No engine oil (EV)".

## Needs confirming

![Needs confirming on a phone: proposed values with Confirm and Reject](screenshots/phone-confirm.png)

What it is for: check proposed values before you trust them.
Who uses it: phone or Mac, with the manual or the door label in front of you.
Main actions:

- Each row shows the car, the field, the value, its confidence and its source.
- **Confirm** or **Reject**. Each one is kept in the value's history, with the name of the screen it was made on.
- A torque outside the usual range for its thread is flagged before you confirm it.

## Other screens (no screenshot)

- **Tires tab**: size, pressure and spare pressure, and **Door-jamb photo** (phone): take a photo of the label, then type what it says. The photo stays in your private storage.
- **Add a car**: whose car (Mine, Frequent, Visitor), then make, year and model, or a VIN typed or scanned.

## Sample page

![The drawn sample page used in the screenshots](screenshots/sample-page.png)

The Lift screenshot uses this drawn page, not a page of the lift guide. It is not a lifting guide.

## Re-making the screenshots

The screenshots come from a local Worker with sample data, in drawn device frames (no brand). `docs/screenshots/MANIFEST.txt` lists each file with its sha256 (`sha256sum -c MANIFEST.txt` in that folder).
