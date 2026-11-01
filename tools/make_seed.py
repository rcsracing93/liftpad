"""Build the LiftPad seed files.

Run:     python3 tools/make_seed.py PRIVATE_DIR
Reads:   PRIVATE_DIR/ali-index.csv (2019), PRIVATE_DIR/ali-index-2026.csv (2026), PRIVATE_DIR/classics.csv, PRIVATE_DIR/my-cars.csv,
         PRIVATE_DIR/apps.csv (each is optional; a missing file is skipped and reported)
Writes:  db/seed-public.sql        makes list + 1 sample app + 2 example cars + made-up parts for the first one (HANDOFF 21).
                                   Safe for git. Example cars must not look like a lift-guide chart code (two letters, dash, digit).
         PRIVATE_DIR/seed-private.sql   makes + lift-guide index + classics + your cars.
                                       Never put this file in git.
Both seeds are for a NEW, empty database only, after tools/migrate.sh (tools/d1_load.sh does
both). A database with data is never reseeded: restore it from a backup (README).
"""
import csv
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(HERE, '..', 'db')
q = lambda v: 'NULL' if v is None or v == '' else (str(v) if isinstance(v, int) else "'" + str(v).replace("'", "''") + "'")
MAKEMAP = {"Chevrolet Trucks": "Chevrolet", "Ford Trucks": "Ford", "GMC Trucks": "GMC", "Nissan/Datsun": "Nissan",
           "Mercedes Benz": "Mercedes-Benz", "Dodge/Ram Trucks": "Dodge"}
ALI_INDEX_FILES = [('ali-index.csv', '2019'), ('ali-index-2026.csv', '2026')]   # file, edition of its rows
EXTRA_MAKES = ['Tesla', 'Rivian', 'Lucid', 'Polestar', 'Alfa Romeo', 'Maserati', 'Ferrari', 'Lamborghini', 'McLaren',
               'Bentley', 'Rolls-Royce', 'Aston Martin', 'Lotus', 'Fisker', 'Factory Five']
# Tabs and fields added after migration 0002, as data (Handoff 3 decision 7: the Oil tab is new
# rows, no migration). Both seeds hold them; tools/import.py adds the missing ones to a database
# that has data. The app knows the input kind of the oil fields by name (public/app.js OIL_UI).
APP_TABS = [('oil', 'Oil', 4)]                                    # name, label, sort
APP_FIELDS = [('oil', 'Oil type', '', 1, 0), ('oil', 'Quantity', 'qt', 2, 0), ('oil', 'Filter', '', 3, 0),   # tab, name, unit, sort, is_safety
              ('tires', 'Spare pressure', 'psi', 3, 0)]                                                 # decision 10 (door-jamb label)


def app_lines():
    out = [f"INSERT OR IGNORE INTO tabs(name,label,sort) VALUES({q(n)},{q(lb)},{s});" for n, lb, s in APP_TABS]
    out += [f"INSERT OR IGNORE INTO fields(tab_id,name,unit,sort,is_safety) SELECT id,{q(n)},'{u}',{s},{k} FROM tabs WHERE name={q(t)};" for t, n, u, s, k in APP_FIELDS]
    return out


# Apps screen tiles (HANDOFF 6, migration 0006). The public seed has one sample row; the private
# seed has PRIVATE_DIR/apps.csv (name,url,icon,sort), whose URLs can be LAN addresses.
SAMPLE_APPS = [{'name': 'Sample app', 'url': 'https://example.com', 'icon': 'apps', 'sort': '10'}]


def apps_lines(rows):
    return [f"INSERT INTO apps(name,url,icon,sort) VALUES({q(r['name'])},{q(r['url'])},{q(r['icon'] or 'apps')},{int(r['sort'])});" for r in rows]


EXAMPLE_CARS = [
    (2016, 'Honda', 'Civic', 'Example car - replace with yours', [
        ('lift', 'Points', 'Example only. Write where the lift pads go.', 'Low', 'Example', 'Not a real value', 0),
        ('torque', 'Torque', 'Example only. Copy the value from the owner manual.', 'Low', 'Example', 'Not a real value', 0),
        ('tires', 'Pressure', 'Example only. Copy the value from the door placard.', 'Low', 'Example', 'Not a real value', 0)]),
    (1965, 'Ford', 'Mustang', 'Example car - replace with yours', [
        ('lift', 'Points', 'Example only. Write where the lift pads go.', 'Low', 'Example', 'Not a real value', 0),
        ('torque', 'Torque', 'Example only. Copy the value from the shop manual.', 'Low', 'Example', 'Not a real value', 0)])]


# HANDOFF 21 (F6): the public seed gets ONE made-up car with made-up parts (the first example car, the Civic). Every part number starts with 99 (after at most
# two letters), which no catalog uses: the export gate (tools/export_public.py) refuses a parts row in the seed whose number does not, and refuses any
# part number of a real car anywhere in the export. The sources are example.com. The private seed has no parts: real parts come from the research
# worker into the live database only.
# item, choice, brand, part_no, also_fits, size_in, spec_text, status, confidence, source, check_car (confirmed rows: check_car 0)
EX_SRC_A, EX_SRC_B = 'https://www.example.com/us/test-a', 'https://www.example.com/us/test-b'
EXAMPLE_PARTS = [
    ('oil_filter', 'first', 'WIX', '99001', '99001XP', None, '', 'proposed', 'Medium', EX_SRC_A + '; ' + EX_SRC_B, 1),
    ('oil_filter', 'other', 'Purolator', 'L99001', '', None, '', 'proposed', 'Low', EX_SRC_A, 1),
    ('oil_filter', 'oem', 'Honda', '99100-EXA-A99', '', None, '', 'proposed', 'Low', 'Owner manual Example p.1-2', 1),
    ('engine_air_filter', 'first', 'WIX', '99002', '', None, '', 'proposed', 'Low', EX_SRC_A, 1),
    ('engine_air_filter', 'other', 'Purolator', 'A99002', '', None, '', 'proposed', 'Low', EX_SRC_A, 1),
    ('cabin_air_filter', 'first', 'WIX', '99003', '', None, '', 'confirmed', 'Medium', EX_SRC_A + '; ' + EX_SRC_B, 0),
    ('wiper_driver', 'first', 'Bosch', '99024A', '', 24, '', 'proposed', 'Low', EX_SRC_A, 1),
    ('wiper_driver', 'other', 'Rain-X', '9950799', '', 24, '', 'proposed', 'Low', EX_SRC_A, 1),
    ('wiper_passenger', 'first', 'Bosch', '', '', 18, '', 'proposed', 'Low', EX_SRC_A, 1),
    ('coolant', 'spec', '', '', '', None, 'Type 2 blue (made-up spec)', 'confirmed', 'High', 'Owner manual Example p.1-2', 0)]
EXAMPLE_PARTS_ENGINE = '2.0L'


def parts_lines(vehicle_id, rows, engine):
    """INSERT lines for the parts of one example car, each with its history row (last_insert_rowid). Made-up data only."""
    t = lambda v: "'" + str(v or '').replace("'", "''") + "'"
    now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')"
    out = []
    for item, choice, brand, no, also, size, spec, status, conf, src, chk in rows:
        done = status == 'confirmed'
        out.append("INSERT INTO parts(vehicle_id,item,choice,brand,part_no,also_fits,conflict_no,size_in,spec_text,engine,status,confidence,source,check_car,created_at,updated_at,confirmed_at,confirmed_by) "
                   f"VALUES({vehicle_id},{t(item)},{t(choice)},{t(brand)},{t(no)},{t(also)},'',{'NULL' if size is None else size},{t(spec)},{t(engine)},{t(status)},{t(conf)},{t(src)},{chk},{now},{now},{now if done else 'NULL'},{t('seed') if done else 'NULL'});")
        out.append(f"INSERT INTO parts_history(part_id,action,old_json,new_json,at,device) VALUES(last_insert_rowid(),'insert',NULL,'{{\"example\":true}}',{now},'seed');")
    return out


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
    """Cars and their values for a NEW database after the migrations (schema 0002 or later).
    Each value is a model-year value for that car's year, status `proposed` (only Rick
    confirms, in the app), with its history row. A field the migrations do not create is added."""
    t = lambda v: "'" + str(v or '').replace("'", "''") + "'"   # text, '' rather than NULL
    now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')"
    out, seen = [], set()
    for i, (y, mk, md, tr, specs) in enumerate(cars, 1):
        out.append(f"INSERT INTO vehicles(id,year,make,model,trim,mine,grp) VALUES({i},{y},{q(mk)},{q(md)},{q(tr)},1,'mine');")
        for tab, f, v, c, s, n, w in specs:
            if (tab, f) not in seen:
                seen.add((tab, f))
                out.append(f"INSERT OR IGNORE INTO fields(tab_id,name,sort) SELECT id,{t(f)},50 FROM tabs WHERE name={t(tab)};")
            fid = f"(SELECT f.id FROM fields f JOIN tabs t ON t.id=f.tab_id WHERE t.name={t(tab)} AND f.name={t(f)})"
            out.append(f"INSERT INTO vals(field_id,scope,make,model,year_from,year_to,value,confidence,source,note,warn,status,entered_at,entered_by,updated_at) "
                       f"VALUES({fid},'model',{t(mk)},{t(md)},{y},{y},{t(v)},{t(c)},{t(s)},{t(n)},{w},'proposed',{now},'seed',{now});")
            out.append(f"INSERT INTO history(value_id,action,new_value,new_status,new_confidence,at,device) "
                       f"VALUES(last_insert_rowid(),'insert',{t(v)},'proposed',{t(c)},{now},'seed');")
    return out


def load(priv):
    """The rows the input CSVs stand for, as dicts. Shared by this script and tools/import.py,
    so the seed and the import read the CSVs the same way.
    Returns (makes, guide, classics): makes {name: {aliases, nhtsa_name}}; guide and classics lists."""
    makes = {}

    def addmake(n, alias='', nh=''):
        if n not in makes:
            makes[n] = {'aliases': alias, 'nhtsa_name': nh or n}

    guide = []
    # One index file per ALI edition; a row's edition column (if any) wins over the file's default.
    for fname, default_ed in ALI_INDEX_FILES:
        for r in read_csv(os.path.join(priv, fname)):
            mk = MAKEMAP.get(r['make'], r['make'])
            rows = [mk]
            if r['make'] == 'Dodge/Ram Trucks' and r['model'].startswith('Ram') and int(r['year_to']) >= 2011:
                rows.append('Ram')
            for m in rows:
                addmake(m)
                guide.append({'make': m, 'model': r['model'], 'year_from': int(r['year_from']), 'year_to': int(r['year_to']), 'chart': r['chart'],
                              'guide_page': int(r['guide_page']), 'pdf_page': int(r['pdf_page']) if r['pdf_page'] else None,
                              'status': r['status'], 'note': r['note'], 'edition': r.get('edition') or default_ed})
    classics = []
    for r in read_csv(os.path.join(priv, 'classics.csv')):
        if r['note']:
            continue
        mk = r['make']
        addmake(mk, 'American Motors' if mk == 'AMC' else ('Citroen' if mk == 'Citroën' else ''))
        classics.append({'make': mk, 'model': r['model'], 'year_from': int(r['start']) if r['start'] else None,
                         'year_to': int(r['end']) if r['end'] else None,
                         'model_years': 1 if (r['years_src'] == 'hand' or r['raw_years'].startswith('model_years')) else 0,
                         'years_src': r['years_src']})
    for m in EXTRA_MAKES:
        addmake(m)
    return makes, guide, classics


def main():
    if len(sys.argv) != 2 or not os.path.isdir(sys.argv[1]):
        sys.exit('usage: python3 tools/make_seed.py PRIVATE_DIR')
    priv = sys.argv[1]
    makes, g, c = load(priv)
    guide = [f"INSERT INTO ali_index(make,model,year_from,year_to,chart,guide_page,pdf_page,status,note,edition) VALUES({q(r['make'])},{q(r['model'])},{r['year_from']},{r['year_to']},{q(r['chart'])},{r['guide_page']},{q(r['pdf_page']) if r['pdf_page'] is not None else 'NULL'},{q(r['status'])},{q(r['note'])},{q(r['edition'])});" for r in g]
    classics = [f"INSERT INTO classics(make,model,year_from,year_to,model_years,years_src) VALUES({q(r['make'])},{q(r['model'])},{q(r['year_from']) if r['year_from'] is not None else 'NULL'},{q(r['year_to']) if r['year_to'] is not None else 'NULL'},{r['model_years']},{q(r['years_src'])});" for r in c]
    make_lines = [f"INSERT INTO makes(name,aliases,nhtsa_name) VALUES({q(n)},{q(m['aliases'])},{q(m['nhtsa_name'])});" for n, m in sorted(makes.items())]

    public = make_lines + app_lines() + apps_lines(SAMPLE_APPS) + car_lines(EXAMPLE_CARS) + parts_lines(1, EXAMPLE_PARTS, EXAMPLE_PARTS_ENGINE)
    private = (guide + classics + make_lines + app_lines() + apps_lines(read_csv(os.path.join(priv, 'apps.csv')))
               + car_lines(my_cars(read_csv(os.path.join(priv, 'my-cars.csv')))))
    with open(os.path.join(DB, 'seed-public.sql'), 'w', encoding='utf-8') as f:
        f.write('\n'.join(public) + '\n')
    with open(os.path.join(priv, 'seed-private.sql'), 'w', encoding='utf-8') as f:
        f.write('\n'.join(private) + '\n')
    print('seed-public lines', len(public), '| seed-private lines', len(private), '| makes', len(makes))


if __name__ == '__main__':
    main()
