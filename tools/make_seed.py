"""Build the LiftPad seed files.

Run:     python3 tools/make_seed.py PRIVATE_DIR
Reads:   PRIVATE_DIR/ali-index.csv, PRIVATE_DIR/classics.csv, PRIVATE_DIR/my-cars.csv
         (each is optional; a missing file is skipped and reported)
Writes:  db/seed-public.sql        makes list + 2 example cars. Safe for git. Example cars must
                                   not look like a lift-guide chart code (two letters, dash, digit).
         PRIVATE_DIR/seed-private.sql   makes + lift-guide index + classics + your cars.
                                       Never put this file in git.
"""
import csv
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(HERE, '..', 'db')
q = lambda v: 'NULL' if v is None or v == '' else (str(v) if isinstance(v, int) else "'" + str(v).replace("'", "''") + "'")
MAKEMAP = {"Chevrolet Trucks": "Chevrolet", "Ford Trucks": "Ford", "GMC Trucks": "GMC", "Nissan/Datsun": "Nissan",
           "Mercedes Benz": "Mercedes-Benz", "Dodge/Ram Trucks": "Dodge"}
EXTRA_MAKES = ['Tesla', 'Rivian', 'Lucid', 'Polestar', 'Alfa Romeo', 'Maserati', 'Ferrari', 'Lamborghini', 'McLaren',
               'Bentley', 'Rolls-Royce', 'Aston Martin', 'Lotus', 'Fisker', 'Factory Five']
EXAMPLE_CARS = [
    (2016, 'Honda', 'Civic', 'Example car - replace with yours', [
        ('lift', 'Points', 'Example only. Write where the lift pads go.', 'Low', 'Example', 'Not a real value', 0),
        ('torque', 'Torque', 'Example only. Copy the value from the owner manual.', 'Low', 'Example', 'Not a real value', 0),
        ('tires', 'Pressure', 'Example only. Copy the value from the door placard.', 'Low', 'Example', 'Not a real value', 0)]),
    (1965, 'Ford', 'Mustang', 'Example car - replace with yours', [
        ('lift', 'Points', 'Example only. Write where the lift pads go.', 'Low', 'Example', 'Not a real value', 0),
        ('torque', 'Torque', 'Example only. Copy the value from the shop manual.', 'Low', 'Example', 'Not a real value', 0)])]


def read_csv(path):
    if not os.path.exists(path):
        print('skipped, not found:', path)
        return []
    with open(path, encoding='utf-8', newline='') as f:
        return list(csv.DictReader(f))


def my_cars(rows):
    """my-cars.csv has one row per value: year,make,model,trim,tab,field,value,confidence,source,note,warn."""
    cars = {}
    for r in rows:
        key = (int(r['year']), r['make'], r['model'], r['trim'])
        cars.setdefault(key, []).append((r['tab'], r['field'], r['value'], r['confidence'], r['source'], r['note'], int(r['warn'] or 0)))
    return [(*k, v) for k, v in cars.items()]


def car_lines(cars):
    out = []
    for i, (y, mk, md, tr, specs) in enumerate(cars, 1):
        out.append(f"INSERT INTO vehicles(id,year,make,model,trim,mine) VALUES({i},{y},{q(mk)},{q(md)},{q(tr)},1);")
        for t, f, v, c, s, n, w in specs:
            out.append(f"INSERT INTO specs(vehicle_id,tab,field,value,confidence,source,note,warn) VALUES({i},{q(t)},{q(f)},{q(v)},{q(c)},{q(s)},{q(n)},{w});")
    return out


def main():
    if len(sys.argv) != 2 or not os.path.isdir(sys.argv[1]):
        sys.exit('usage: python3 tools/make_seed.py PRIVATE_DIR')
    priv = sys.argv[1]
    makes = {}

    def addmake(n, alias='', nh=''):
        if n not in makes:
            makes[n] = (alias, nh or n)

    guide = []
    for r in read_csv(os.path.join(priv, 'ali-index.csv')):
        mk = MAKEMAP.get(r['make'], r['make'])
        rows = [mk]
        if r['make'] == 'Dodge/Ram Trucks' and r['model'].startswith('Ram') and int(r['year_to']) >= 2011:
            rows.append('Ram')
        for m in rows:
            addmake(m)
            guide.append(f"INSERT INTO ali_index(make,model,year_from,year_to,chart,guide_page,pdf_page,status,note) VALUES({q(m)},{q(r['model'])},{int(r['year_from'])},{int(r['year_to'])},{q(r['chart'])},{int(r['guide_page'])},{q(int(r['pdf_page'])) if r['pdf_page'] else 'NULL'},{q(r['status'])},{q(r['note'])});")
    classics = []
    for r in read_csv(os.path.join(priv, 'classics.csv')):
        if r['note']:
            continue
        mk = r['make']
        addmake(mk, 'American Motors' if mk == 'AMC' else ('Citroen' if mk == 'Citroën' else ''))
        my = 1 if (r['years_src'] == 'hand' or r['raw_years'].startswith('model_years')) else 0
        classics.append(f"INSERT INTO classics(make,model,year_from,year_to,model_years,years_src) VALUES({q(mk)},{q(r['model'])},{q(int(r['start'])) if r['start'] else 'NULL'},{q(int(r['end'])) if r['end'] else 'NULL'},{my},{q(r['years_src'])});")
    for m in EXTRA_MAKES:
        addmake(m)
    make_lines = [f"INSERT INTO makes(name,aliases,nhtsa_name) VALUES({q(n)},{q(a)},{q(nh)});" for n, (a, nh) in sorted(makes.items())]

    public = make_lines + car_lines(EXAMPLE_CARS)
    private = guide + classics + make_lines + car_lines(my_cars(read_csv(os.path.join(priv, 'my-cars.csv'))))
    with open(os.path.join(DB, 'seed-public.sql'), 'w', encoding='utf-8') as f:
        f.write('\n'.join(public) + '\n')
    with open(os.path.join(priv, 'seed-private.sql'), 'w', encoding='utf-8') as f:
        f.write('\n'.join(private) + '\n')
    print('seed-public lines', len(public), '| seed-private lines', len(private), '| makes', len(makes))


if __name__ == '__main__':
    main()
