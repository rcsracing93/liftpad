#!/usr/bin/env python3
"""LiftPad safe import: add or update D1 rows by natural key from the private-data CSVs.

Run (in node:22 with wrangler 3.114.0; from the app folder, so wrangler finds wrangler.toml):
  python3 tools/import.py PRIVATE_DIR                  dry run: prints the diff, changes nothing
  python3 tools/import.py PRIVATE_DIR --apply          verified backup first, then adds and changes
  python3 tools/import.py PRIVATE_DIR --prune          also lists rows in D1 that the input lacks
  python3 tools/import.py PRIVATE_DIR --prune --apply  also deletes those rows: refused unless
                                                       LP_PRUNE_APPROVED=1 (you approve each prune)
Env: LP_D1_NAME (default liftpad), LP_D1_LOCAL=1 for a local D1, LP_BACKUP_DIR (default
     /private/backups: set it to a folder you own, outside git), WRANGLER (default "npx wrangler").
Inputs in PRIVATE_DIR (each optional): ali-index.csv, classics.csv (read as tools/make_seed.py
     reads them; makes are derived from them), values.csv with columns
     make,model,year_from,year_to,tab,field,value,confidence,source,note,warn (0 none, 1 caution, 2 block),status;
     ali-pages/<edition>/ali-pages.csv (from tools/render_pages.py; the images go to R2 with
     tools/upload_pages.sh). ali-index.csv may have an edition column (default 2019).
     make_defaults.csv (edition,make,era,typical_thread,typical_socket,typical_torque_ftlb,
     confidence,source,note; the era text gives year_from/year_to) and thread_ranges.csv
     (edition,thread,common_sockets,torque_min_ftlb,torque_max_ftlb,common_on,confidence,source,note).
     apps.csv (name,url,icon,sort; HANDOFF 6): the Apps screen tiles. A URL must start with http://
     or https://. Before migration 0006 the dry run lists the rows and --apply stops.
     The adapter notes per chart (HANDOFF 12), one row per edition and chart: edition,chart,pdf_page,adapters,
     height_note,cautions,kit_mark,verified,checked_by,note; verified is no or ai (HANDOFF 13: "Checked by Rick"
     is the append-only table chart_checks, set with the button; the import never reads it for a write; the dry run lists
     the charts whose check falls back because the text changed). Before migration 0007 the dry run lists the rows and
     --apply stops.
     Always: the app tabs and fields in tools/make_seed.py (APP_TABS, APP_FIELDS); missing ones are
     added, none is changed or removed.
Natural keys: makes name; tabs name; fields tab+name; ali_index make+model+year_from+year_to+chart+edition; classics
     make+model; ali_pages edition+PDF page (or edition+guide page for a page not in the scan);
     make_defaults edition+make+era; thread_ranges edition+thread; apps name; chart_notes edition+chart;
     values tab+field+make+model+year_from+year_to+value (model-year values only).
Changes: only with --apply. Never deletes without --prune --apply. Values are never pruned (they
     hold Rick's own entries). An imported value is `confirmed` only when its row says so; an
     existing confirmed value is never set back to proposed. Every value insert, update or
     confirm writes a history row (device "import").
Exit: 0 done; 1 the check after --apply still shows a difference; 2 bad arguments; 3 stopped,
     nothing changed (a query or the backup failed).
"""
import csv
import hashlib
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import make_seed  # noqa: E402  (shared CSV reader)

DBN = os.environ.get('LP_D1_NAME', 'liftpad')
WHERE = '--local' if os.environ.get('LP_D1_LOCAL') == '1' else '--remote'
W = shlex.split(os.environ.get('WRANGLER', 'npx wrangler'))
NOW = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'
CONF = ('High', 'Medium', 'Low')
# A new value's id is above every id in vals and in history, so a deleted value's id is never given
# again (same rule as NEW_VAL_ID in src/worker.js).
NEW_VAL_ID = ('(SELECT MAX(m) + 1 FROM (SELECT COALESCE(MAX(id), 0) AS m FROM vals '
              'UNION ALL SELECT COALESCE(MAX(value_id), 0) FROM history))')


class Stop(Exception):
    pass


def nz(v):
    """The seed stores an empty text as NULL; compare and write it the same way."""
    return None if v == '' else v


def lit(v):
    if v is None:
        return 'NULL'
    if isinstance(v, int):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def query(sql):
    try:
        out = subprocess.run(W + ['d1', 'execute', DBN, WHERE, '--json', '--command', sql], capture_output=True, text=True, timeout=300)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise Stop(f'a query could not run: {e}')
    if out.returncode != 0:
        raise Stop('a query failed (wrangler exit non-zero)')
    try:
        d = json.loads(out.stdout)[0]
    except (ValueError, IndexError, KeyError, TypeError):
        raise Stop('a query gave no usable JSON')
    if d.get('success') is not True or not isinstance(d.get('results'), list):
        raise Stop('a query gave no usable JSON')
    # wrangler 3.114 `d1 execute --json` prints an SQL NULL as the TEXT "null" (seen on local D1,
    # 2026-10-17: COALESCE on the same rows proves they are real NULLs). Read it back as NULL.
    # Limit: a real text value "null" would be read as NULL too; no LiftPad column holds that text.
    return [{k: (None if v == 'null' else v) for k, v in r.items()} for r in d['results']]


def page_rows(priv):
    """ali-pages/<edition>/ali-pages.csv files (tools/render_pages.py). slot is the row's key inside
    an edition: p<pdf page> for a page of the scan, g<guide page> for a guide page not in the scan."""
    rows, top = [], os.path.join(priv, 'ali-pages')
    for ed in sorted(os.listdir(top)) if os.path.isdir(top) else []:
        path = os.path.join(top, ed, 'ali-pages.csv')
        if not os.path.exists(path):
            continue
        with open(path, encoding='utf-8', newline='') as f:
            for r in csv.DictReader(f):
                n = {k: (int(r[k]) if r[k] else None) for k in ('pdf_page', 'guide_page', 'w', 'h', 'bytes')}
                if r['edition'] != ed or r['status'] not in ('ok', 'missing_from_scan') or (r['status'] == 'ok') != (n['pdf_page'] is not None):
                    raise Stop(f'{path}: bad row {r}')
                rows.append({'edition': ed, 'status': r['status'], **n})
    return [dict(r, slot=f"p{r['pdf_page']}" if r['pdf_page'] is not None else f"g{r['guide_page']}") for r in rows]


def era_years(era):
    """The year range in a make_defaults era text: '1990+' -> (1990, None), '2004-2016' -> (2004, 2016),
    'before 2011' -> (None, 2010), '2011+ cars and light trucks' -> (2011, None). Anything else -> (None, None)."""
    w = era.strip().split(' ')[0] if era.strip() else ''
    if era.strip().lower().startswith('before '):
        y = era.strip().split(' ')[1]
        return (None, int(y) - 1) if y.isdigit() else (None, None)
    if w.endswith('+') and w[:-1].isdigit():
        return int(w[:-1]), None
    a, _, b = w.partition('-')
    return (int(a), int(b)) if a.isdigit() and b.isdigit() else (None, None)


def num(v):
    v = (v or '').strip()
    return None if v == '' else (int(v) if v.isdigit() else float(v))


def table_rows(priv):
    """make_defaults.csv and thread_ranges.csv (Cowork's typical-value tables, edition v1...)."""
    def rows(name):
        path = os.path.join(priv, name)
        if not os.path.exists(path):
            return []
        with open(path, encoding='utf-8', newline='') as f:
            out = list(csv.DictReader(f))
        for r in out:
            if not r.get('edition') or (r.get('confidence') or 'Low') not in CONF:
                raise Stop(f'{name}: bad row {r}')
        return out
    md = []
    for r in rows('make_defaults.csv'):
        yf, yt = era_years(r['era'])
        md.append({'edition': r['edition'], 'make': r['make'], 'era': r['era'], 'year_from': yf, 'year_to': yt, 'thread': r['typical_thread'],
                   'socket': r['typical_socket'], 'torque_ftlb': num(r['typical_torque_ftlb']), 'confidence': r['confidence'] or 'Low',
                   'source': r['source'], 'note': r['note']})
    tr = [{'edition': r['edition'], 'thread': r['thread'], 'sockets': r['common_sockets'], 'torque_min': num(r['torque_min_ftlb']),
           'torque_max': num(r['torque_max_ftlb']), 'common_on': r['common_on'], 'confidence': r['confidence'] or 'Low',
           'source': r['source'], 'note': r['note']} for r in rows('thread_ranges.csv')]
    return md, tr


def app_rows(priv):
    """apps.csv (HANDOFF 6): one tile per row. Private: a URL can be a LAN address."""
    path = os.path.join(priv, 'apps.csv')
    if not os.path.exists(path):
        return []
    out = []
    with open(path, encoding='utf-8', newline='') as f:
        for r in csv.DictReader(f):
            name, url, icon, srt = ((r.get(k) or '').strip() for k in ('name', 'url', 'icon', 'sort'))
            if not name or not re.fullmatch(r'https?://[^\s"<>]+', url) or not re.fullmatch(r'-?\d+', srt):
                raise Stop(f'apps.csv: bad row {r}')
            out.append({'name': name, 'url': url, 'icon': icon or 'apps', 'sort': int(srt)})
    return out


def text_hash(n):
    """sha256 of a chart's text, the same string as textHash() in src/worker.js (fields joined by U+001F, NULL = empty)."""
    s = '\x1f'.join('' if n.get(k) is None else str(n.get(k)) for k in ('adapters', 'height_note', 'cautions', 'kit_mark'))
    return hashlib.sha256(s.encode('utf-8')).hexdigest()


def chart_note_rows(priv):
    """The adapter notes per chart (HANDOFF 12). Private: transcribed guide text. A row needs an edition,
    a chart and verified yes or no; a chart twice in one edition stops the import."""
    path = os.path.join(priv, 'chart-notes.csv')
    if not os.path.exists(path):
        return []
    out, seen = [], set()
    with open(path, encoding='utf-8', newline='') as f:
        for r in csv.DictReader(f):
            ed, ch, ver = ((r.get(k) or '').strip() for k in ('edition', 'chart', 'verified'))
            # edition all + chart footer: the one fixed line under every adapter block (its text is in adapters)
            if not (re.fullmatch(r'\d{4}', ed) or (ed == 'all' and ch == 'footer')) or not ch or ver not in ('no', 'ai') or (ed, ch) in seen:
                # HANDOFF 13 (Rick): the CSV holds only no and ai; "Checked by Rick" lives in chart_checks (the button)
                raise Stop(f'chart-notes.csv: bad row {r} (verified must be no or ai; Rick\'s check is set with the button)')
            seen.add((ed, ch))
            out.append({'edition': ed, 'chart': ch, 'adapters': r.get('adapters') or '', 'height_note': r.get('height_note') or '',
                        'cautions': r.get('cautions') or '', 'kit_mark': r.get('kit_mark') or '', 'verified': ver})
    return out


def wanted(priv):
    makes, guide, classics = make_seed.load(priv)
    vals = []
    path = os.path.join(priv, 'values.csv')
    if os.path.exists(path):
        with open(path, encoding='utf-8', newline='') as f:
            for r in csv.DictReader(f):
                if r['confidence'] not in CONF:
                    raise Stop(f'values.csv: bad confidence {r["confidence"]!r} for {r["make"]} {r["model"]} {r["field"]}')
                warn = int(r['warn'] or 0)   # 0 none, 1 caution, 2 block (HANDOFF 10)
                if warn not in (0, 1, 2):
                    raise Stop(f'values.csv: bad warn {warn!r} for {r["make"]} {r["model"]} {r["field"]} (0 none, 1 caution, 2 block)')
                vals.append({'make': r['make'], 'model': r['model'], 'year_from': int(r['year_from']), 'year_to': int(r['year_to']),
                             'tab': r['tab'], 'field': r['field'], 'value': r['value'].strip(), 'confidence': r['confidence'],
                             'source': r['source'] or '', 'note': r['note'] or '', 'warn': warn,
                             'status': 'confirmed' if r.get('status', '').strip() == 'confirmed' else 'proposed'})
    return (makes, guide, classics, vals, page_rows(priv)) + table_rows(priv) + (app_rows(priv), chart_note_rows(priv))


def current():
    makes = {r['name']: r for r in query('SELECT name, aliases, nhtsa_name FROM makes')}
    guide = query('SELECT id, make, model, year_from, year_to, chart, guide_page, pdf_page, status, note, edition FROM ali_index')
    classics = query('SELECT id, make, model, year_from, year_to, model_years, years_src FROM classics')
    pages = [dict(r, slot=f"p{r['pdf_page']}" if r['pdf_page'] is not None else f"g{r['guide_page']}")
             for r in query('SELECT id, edition, pdf_page, guide_page, status, w, h, bytes FROM ali_pages')]
    vals = query("SELECT x.id, t.name tab, f.name field, x.make, x.model, x.year_from, x.year_to, x.value, x.confidence, x.source, x.note, x.warn, x.status "
                 "FROM vals x JOIN fields f ON f.id = x.field_id JOIN tabs t ON t.id = f.tab_id WHERE x.scope = 'model' AND x.status <> 'rejected'")
    fields = {(r['tab'], r['name']) for r in query('SELECT t.name tab, f.name FROM fields f JOIN tabs t ON t.id = f.tab_id')}
    tabs = {r['name'] for r in query('SELECT name FROM tabs')}
    md = query('SELECT id, edition, make, era, year_from, year_to, thread, socket, torque_ftlb, confidence, source, note FROM make_defaults')
    tr = query('SELECT id, edition, thread, sockets, torque_min, torque_max, common_on, confidence, source, note FROM thread_ranges')
    # None: the database has no apps table yet (before migration 0006)
    apps = query('SELECT id, name, url, icon, sort FROM apps') if query("SELECT name FROM sqlite_master WHERE type='table' AND name='apps'") else None
    # None: no chart_notes table yet (before migration 0007)
    # HANDOFF 13: checked_hash = the hash of the latest chart_checks row when that row is a check (migration 0008), else NULL
    has_chk = bool(query("SELECT name FROM sqlite_master WHERE type='table' AND name='chart_checks'"))
    chk = ("(SELECT CASE WHEN k.action = 'check' THEN k.text_hash END FROM chart_checks k WHERE k.edition = n.edition AND k.chart = n.chart ORDER BY k.id DESC LIMIT 1)" if has_chk else 'NULL')
    cn = query(f'SELECT n.id, n.edition, n.chart, n.adapters, n.height_note, n.cautions, n.kit_mark, n.verified, {chk} checked_hash FROM chart_notes n') if query("SELECT name FROM sqlite_master WHERE type='table' AND name='chart_notes'") else None
    return makes, guide, classics, vals, fields, pages, tabs, md, tr, apps, cn


def plan(w, c, prune):
    """Return (report lines, SQL statements, counts). Pure: no I/O."""
    wm, wg, wc, wv, wp, wmd, wtr, wa, wcn = w
    cm, cg, cc, cv, cfields, cp, ctabs, cmd, ctr, ca, ccn = c
    sql, rep, counts = [], [], {}

    examples = []

    def ex(text):   # up to 3 example lines per table, shown under its count line
        if len(examples) < 3:
            examples.append('    e.g. ' + text)

    def tally(table, adds, changes, same, gone):
        counts[table] = {'add': adds, 'change': changes, 'same': same, 'not_in_input': gone}
        rep.append(f'{table}: {adds} to add, {changes} to change, {same} unchanged, {gone} in D1 but not in the input')
        rep.extend(examples)
        examples.clear()

    # makes
    a = ch = s = 0
    for n, m in sorted(wm.items()):
        if n not in cm:
            a += 1; ex(f'add make {n}')
            sql.append(f"INSERT INTO makes(name, aliases, nhtsa_name) VALUES({lit(n)}, {lit(nz(m['aliases']))}, {lit(nz(m['nhtsa_name']))});")
        elif (nz(cm[n]['aliases']), nz(cm[n]['nhtsa_name'])) != (nz(m['aliases']), nz(m['nhtsa_name'])):
            ch += 1; ex(f"change make {n}: {cm[n]['aliases']!r}/{cm[n]['nhtsa_name']!r} -> {m['aliases']!r}/{m['nhtsa_name']!r}")
            sql.append(f"UPDATE makes SET aliases = {lit(nz(m['aliases']))}, nhtsa_name = {lit(nz(m['nhtsa_name']))} WHERE name = {lit(n)};")
        else:
            s += 1
    gone = [n for n in cm if n not in wm]
    tally('makes', a, ch, s, len(gone))
    if prune:
        sql += [f'DELETE FROM makes WHERE name = {lit(n)};' for n in gone]

    def keyed(rows, key):
        d = {}
        for r in rows:
            d.setdefault(tuple(r[k] for k in key), []).append(r)
        return d

    # ali_index, classics and ali_pages: same pattern, natural key + compared fields. dbkey: the
    # key's columns in the table (ali_pages keys on slot, which is not a column).
    for table, want, have, key, cols, dbkey in (
            ('ali_index', wg, cg, ('make', 'model', 'year_from', 'year_to', 'chart', 'edition'), ('guide_page', 'pdf_page', 'status', 'note'), None),
            ('classics', wc, cc, ('make', 'model'), ('year_from', 'year_to', 'model_years', 'years_src'), None),
            ('ali_pages', wp, cp, ('edition', 'slot'), ('pdf_page', 'guide_page', 'status', 'w', 'h', 'bytes'), ('edition',)),
            ('make_defaults', wmd, cmd, ('edition', 'make', 'era'), ('year_from', 'year_to', 'thread', 'socket', 'torque_ftlb', 'confidence', 'source', 'note'), None),
            ('thread_ranges', wtr, ctr, ('edition', 'thread'), ('sockets', 'torque_min', 'torque_max', 'common_on', 'confidence', 'source', 'note'), None),
            *((('apps', wa, ca, ('name',), ('url', 'icon', 'sort'), None),) if ca is not None else ()),
            *((('chart_notes', wcn, ccn, ('edition', 'chart'), ('adapters', 'height_note', 'cautions', 'kit_mark', 'verified'), None),) if ccn is not None else ())):
        hv = keyed(have, key)
        a = ch = s = 0
        seen = set()
        drops = []
        for r in want:
            k = tuple(r[x] for x in key)
            if k in seen:
                continue
            seen.add(k)
            if k not in hv:
                a += 1; ex(f'add {table} {k}')
                names = (dbkey or key) + cols
                sql.append(f"INSERT INTO {table}({', '.join(names)}) VALUES({', '.join(lit(nz(r[x])) for x in names)});")
            else:
                row = hv[k][0]
                # HANDOFF 13 (Rick): the import never touches chart_checks. If a changed text makes a live check of Rick
                # stale (its hash is the hash of the old text), the label falls back by itself; the chart is listed here.
                cmp = cols
                if table == 'chart_notes' and row.get('checked_hash') and row['checked_hash'] == text_hash(row) != text_hash(r):
                    drops.append(f"chart_notes {k[0]} {k[1]}")
                if any(nz(row[x]) != nz(r[x]) for x in cmp):
                    ch += 1; ex(f"change {table} {k}: " + ', '.join(f'{x} {row[x]!r} -> {r[x]!r}' for x in cmp if nz(row[x]) != nz(r[x])))
                    sets = ', '.join(x + ' = ' + lit(nz(r[x])) for x in cmp)
                    sql.append(f"UPDATE {table} SET {sets} WHERE id = {row['id']};")
                else:
                    s += 1
        gone = [r for k, rs in hv.items() if k not in seen for r in rs]
        tally(table, a, ch, s, len(gone))
        if drops:
            counts[table]['level_drops'] = len(drops)
            rep.append(f'  CHECKS THAT FALL BACK ({len(drops)}): "Checked by Rick" goes back to the CSV level because the chart text changed; chart_checks keeps its rows')
            rep.extend('    ' + d for d in drops)
        if prune:
            sql += [f'DELETE FROM {table} WHERE id = {r["id"]};' for r in gone]
    if ca is None:
        counts['apps'] = {'missing_table': True, 'add': len(wa)}
        rep.append(f'apps: no apps table in D1 yet (migration 0006); {len(wa)} to add after it')
        rep.extend('    e.g. add apps ' + repr((r['name'],)) for r in wa[:3])
    if ccn is None:
        counts['chart_notes'] = {'missing_table': True, 'add': len(wcn)}
        rep.append(f'chart_notes: no chart_notes table in D1 yet (migration 0007); {len(wcn)} to add after it')

    # app tabs and fields (make_seed.APP_TABS / APP_FIELDS, e.g. the Oil tab): add the missing
    # ones; never change or remove a tab or field (values point at them)
    a = 0
    for n, lb, srt in make_seed.APP_TABS:
        if n not in ctabs:
            a += 1; ex(f'add tab {n}')
            sql.append(f"INSERT INTO tabs(name, label, sort) VALUES({lit(n)}, {lit(lb)}, {srt});")
    tally('tabs', a, 0, len(make_seed.APP_TABS) - a, 0)
    a = 0
    for tb, n, u, srt, k in make_seed.APP_FIELDS:
        if (tb, n) not in cfields:
            a += 1; ex(f'add field {tb}/{n}')
            sql.append(f"INSERT INTO fields(tab_id, name, unit, sort, is_safety) SELECT id, {lit(n)}, {lit(u)}, {srt}, {k} FROM tabs WHERE name = {lit(tb)};")
    tally('fields', a, 0, len(make_seed.APP_FIELDS) - a, 0)
    cfields = set(cfields) | {(tb, n) for tb, n, *_ in make_seed.APP_FIELDS}

    # model-year values: add, change confidence/source/note/warn, confirm when the input says so
    key = ('tab', 'field', 'make', 'model', 'year_from', 'year_to', 'value')
    hv = keyed(cv, key)
    a = ch = s = 0
    for r in wv:
        if (r['tab'], r['field']) not in cfields:
            raise Stop(f'values.csv: unknown field {r["field"]!r} on tab {r["tab"]!r}')
        k = tuple(r[x] for x in key)
        fid = f"(SELECT f.id FROM fields f JOIN tabs t ON t.id = f.tab_id WHERE t.name = {lit(r['tab'])} AND f.name = {lit(r['field'])})"
        if k not in hv:
            a += 1
            conf_at, conf_by = (lit(NOW), "'import'") if r['status'] == 'confirmed' else ('NULL', 'NULL')
            sql.append(f"INSERT INTO vals(id, field_id, scope, make, model, year_from, year_to, value, confidence, source, note, warn, status, entered_at, entered_by, confirmed_at, confirmed_by, updated_at) "
                       f"VALUES({NEW_VAL_ID}, {fid},'model', {lit(r['make'])}, {lit(r['model'])}, {r['year_from']}, {r['year_to']}, {lit(r['value'])}, {lit(r['confidence'])}, {lit(r['source'])}, {lit(r['note'])}, {r['warn']}, "
                       f"{lit(r['status'])}, {lit(NOW)}, 'import', {conf_at}, {conf_by}, {lit(NOW)});")
            sql.append(f"INSERT INTO history(value_id, action, new_value, new_status, new_confidence, at, device) VALUES(last_insert_rowid(), 'insert', {lit(r['value'])}, {lit(r['status'])}, {lit(r['confidence'])}, {lit(NOW)}, 'import');")
            continue
        row = hv[k][0]
        upd = {x: r[x] for x in ('confidence', 'source', 'note', 'warn') if (row[x] if row[x] is not None else ('' if x != 'warn' else 0)) != r[x]}
        confirm = r['status'] == 'confirmed' and row['status'] != 'confirmed'
        if not upd and not confirm:
            s += 1
            continue
        ch += 1
        if upd:
            sql.append(f"INSERT INTO history(value_id, action, old_value, new_value, old_status, new_status, old_confidence, new_confidence, at, device) "
                       f"SELECT id, 'update', value, value, status, status, confidence, {lit(upd.get('confidence', row['confidence']))}, {lit(NOW)}, 'import' FROM vals WHERE id = {row['id']};")
            sql.append(f"UPDATE vals SET {', '.join(f'{x} = {lit(v)}' for x, v in upd.items())}, updated_at = {lit(NOW)} WHERE id = {row['id']};")
        if confirm:
            sql.append(f"INSERT INTO history(value_id, action, old_value, new_value, old_status, new_status, old_confidence, new_confidence, at, device) "
                       f"SELECT id, 'confirm', value, value, status, 'confirmed', confidence, confidence, {lit(NOW)}, 'import' FROM vals WHERE id = {row['id']};")
            sql.append(f"UPDATE vals SET status = 'confirmed', confirmed_at = {lit(NOW)}, confirmed_by = 'import', updated_at = {lit(NOW)} WHERE id = {row['id']};")
    tally('values', a, ch, s, 0)
    rep.append('values are never pruned (they hold your own entries)')
    return rep, sql, counts


def backup():
    bk = os.environ.get('LP_BACKUP_DIR', '/private/backups')
    os.makedirs(bk, exist_ok=True)
    path = os.path.join(bk, f'{DBN}-preimport-{datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")}.sql')
    r = subprocess.run(W + ['d1', 'export', DBN, WHERE, f'--output={path}'], capture_output=True, text=True, timeout=600)
    if r.returncode != 0:
        raise Stop('the backup before importing failed')
    try:
        with open(path, encoding='utf-8') as f:
            if 'INSERT INTO' not in f.read():
                raise Stop(f'the backup before importing is empty: {path}')
    except OSError:
        raise Stop('the backup before importing was not written')
    return path


def main(argv):
    args = [a for a in argv if not a.startswith('--')]
    flags = {a for a in argv if a.startswith('--')}
    if len(args) != 1 or not os.path.isdir(args[0]) or flags - {'--apply', '--prune'}:
        print(__doc__)
        return 2
    apply_, prune = '--apply' in flags, '--prune' in flags
    if apply_ and prune and os.environ.get('LP_PRUNE_APPROVED') != '1':
        print('import: STOP - --prune --apply deletes rows and needs LP_PRUNE_APPROVED=1 (you approve each prune). Nothing was changed.')
        return 2
    try:
        rep, sql, counts = plan(wanted(args[0]), current(), prune)
        print(f'import: database {DBN} ({WHERE}), {"APPLY" if apply_ else "dry run"}{" with prune" if prune else ""}')
        print('\n'.join('  ' + x for x in rep))
        if not apply_:
            print('import: dry run - nothing changed (add --apply)')
            return 0
        if counts.get('apps', {}).get('missing_table') and counts['apps']['add']:
            raise Stop('apps.csv has rows but D1 has no apps table: apply migration 0006 first')
        if counts.get('chart_notes', {}).get('missing_table') and counts['chart_notes']['add']:
            raise Stop('chart-notes.csv has rows but D1 has no chart_notes table: apply migration 0007 first')
        if not sql:
            print('import: nothing to do')
            return 0
        b = backup()
        print(f'import: backup {b} ({os.path.getsize(b)} bytes)')
        with tempfile.NamedTemporaryFile('w', suffix='.sql', delete=False, encoding='utf-8') as f:
            f.write('\n'.join(sql) + '\n')
        r = subprocess.run(W + ['d1', 'execute', DBN, WHERE, '--file', f.name, '-y'], capture_output=True, text=True, timeout=600)
        os.unlink(f.name)
        if r.returncode != 0:
            print(f'import: FAILED while writing. Restore: {b}')
            print((r.stderr or r.stdout)[-400:])
            return 1
        rep2, sql2, _ = plan(wanted(args[0]), current(), prune)
        left = [x for x in sql2 if not x.startswith('DELETE')] if not prune else sql2
        print('import: after: ' + '; '.join(rep2[:-1]))
        if left:
            print(f'import: FAILED - {len(left)} statement(s) still needed after the import. Backup: {b}')
            return 1
        print('import: done')
        return 0
    except Stop as e:
        print(f'import: STOP - {e}. Nothing was changed.')
        return 3


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
