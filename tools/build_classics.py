#!/usr/bin/env python3
"""LiftPad classics list: Wikidata model names + Wikipedia infobox production years.
One-off data build. Needs internet. Wikidata is rate-limited; expect retries.
Run:    python3 tools/build_classics.py OUTPUT.csv   (for example private-data/classics.csv)
Writes: OUTPUT.csv only  (make,model,start,end,years_src,wiki_title,qid,note,raw_years,description)"""
import csv, json, re, sys, time, urllib.parse, urllib.request
if len(sys.argv) != 2: sys.exit('usage: python3 tools/build_classics.py OUTPUT.csv')
OUT = sys.argv[1]
UA = 'LiftPad-build/0.1 (personal use)'
MAKES = {  # Wikidata QID -> display make
 'Q938876':'Studebaker','Q202708':'AMC','Q2034074':'Rambler','Q1313428':'Hudson','Q1081459':'Nash',
 'Q40971':'Packard','Q913474':'Bricklin','Q1141056':'Crosley','Q6746':'Citroën','Q1241608':'DeLorean',
 'Q173085':'De Tomaso','Q125765830':'De Tomaso','Q1502806':'Geo','Q35896':'Lancia','Q36018':'MG',
 'Q1140388':'Triumph','Q776997':'Morris','Q1045210':'Shelby','Q12010087':'MG','Q1881443':'MG'}
def get(url, data=None, accept='application/json'):
    req = urllib.request.Request(url, data=data, headers={'User-Agent':UA,'Accept':accept})
    for i in range(4):
        try:
            with urllib.request.urlopen(req, timeout=170) as r: return r.read().decode()
        except Exception as e:
            print('retry', i, e); time.sleep(65)
    raise SystemExit('failed: '+url[:80])
vals = ' '.join('wd:'+q for q in MAKES)
q = f"""SELECT DISTINCT ?mfr ?m ?mLabel ?title ?s ?e ?concept WHERE {{
 VALUES ?mfr {{ {vals} }}
 {{ ?m wdt:P176 ?mfr }} UNION {{ ?m wdt:P1716 ?mfr }}
 ?m wdt:P31/wdt:P279* wd:Q3231690 .
 OPTIONAL {{ ?m wdt:P2031 ?s }} OPTIONAL {{ ?m wdt:P2032 ?e }}
 OPTIONAL {{ ?a schema:about ?m ; schema:isPartOf <https://en.wikipedia.org/> ; schema:name ?title }}
 SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en" }} }}"""
res = json.loads(get('https://query.wikidata.org/sparql', urllib.parse.urlencode({'query':q,'format':'json'}).encode()))
models = {}
for b in res['results']['bindings']:
    qid = b['m']['value'].rsplit('/',1)[1]
    d = models.setdefault(qid, {'make':MAKES[b['mfr']['value'].rsplit('/',1)[1]], 'label':b['mLabel']['value'],
        'title':b.get('title',{}).get('value',''), 's':None, 'e':None, 'concept':False, 'desc':b.get('desc',{}).get('value','')})
    if 's' in b: y=int(b['s']['value'][:4]); d['s']=y if d['s'] is None else min(d['s'],y)
    if 'e' in b: y=int(b['e']['value'][:4]); d['e']=y if d['e'] is None else max(d['e'],y)
    if 'concept' in b: d['concept']=True
print('models', len(models))
# Wikipedia infobox production years
titles = sorted({d['title'] for d in models.values() if d['title']})
prod = {}
yr = re.compile(r'(1[89]\d\d|20\d\d)')
for i in range(0, len(titles), 50):
    chunk = titles[i:i+50]
    url = 'https://en.wikipedia.org/w/api.php?' + urllib.parse.urlencode({'action':'query','prop':'revisions','rvprop':'content','rvslots':'main','format':'json','formatversion':'2','titles':'|'.join(chunk)})
    for p in json.loads(get(url))['query']['pages']:
        try: txt = p['revisions'][0]['slots']['main']['content']
        except Exception: continue
        m = re.search(r'\|\s*model_years\s*=\s*(.+?)\n\s*\|', txt, re.S) or re.search(r'\|\s*production\s*=\s*(.+?)\n\s*\|', txt, re.S)
        if m and not yr.search(re.sub(r'<ref.*?(/>|</ref>)', '', m.group(1), flags=re.S)):
            m = re.search(r'\|\s*production\s*=\s*(.+?)\n\s*\|', txt, re.S)
        if m:
            kind = 'model_years' if 'model_years' in m.group(0) else 'production'
            raw = re.sub(r'<ref.*?(/>|</ref>)', '', m.group(1), flags=re.S)
            ys = [int(y) for y in yr.findall(raw)]
            pres = 'present' in raw.lower()
            if ys: prod[p['title']] = (min(ys), 2026 if pres else max(ys), kind+': '+raw.strip()[:80].replace('\n',' '))
    time.sleep(1.5)
print('wiki years', len(prod))
missing = sorted({d['title'] for d in models.values() if d['title'] and d['title'] not in prod and d['s'] is None})
lead = {}
rng = re.compile(r'(1[89]\d\d|20\d\d)\s*(?:–|-|—|to|until)\s*(1[89]\d\d|20\d\d|present)')
for i in range(0, len(missing), 20):
    url = 'https://en.wikipedia.org/w/api.php?' + urllib.parse.urlencode({'action':'query','prop':'extracts','exintro':1,'explaintext':1,'exlimit':20,'format':'json','formatversion':'2','titles':'|'.join(missing[i:i+20])})
    for p in json.loads(get(url))['query']['pages']:
        m = rng.search(p.get('extract','')[:800])
        if m: lead[p['title']] = (int(m.group(1)), 2026 if m.group(2)=='present' else int(m.group(2)), 'lead: '+m.group(0))
        else:
            m1 = yr.search(p.get('extract','')[:300])
            if m1: lead[p['title']] = (int(m1.group(1)), int(m1.group(1)), 'lead-single: '+m1.group(0))
    time.sleep(1.5)
print('lead years', len(lead))
CONCEPT_NAMES = {'Amitron','Cavalier','Astro-Gnome','Tarpon'}
HAND = [('Shelby','Cobra',1962,1967),('Shelby','GT350',1965,1970),('Shelby','GT500',1967,1970),('Shelby','GT500 (Ford, 2007-14)',2007,2014),
 ('Shelby','GT350 (Ford, 2015-20)',2015,2020),('Shelby','GT500 (Ford, 2020-22)',2020,2022),('Geo','Metro',1989,1997),('Geo','Tracker',1989,1997),
 ('Geo','Prizm',1989,1997),('Geo','Spectrum',1989,1989),('Crosley','Crosley (prewar)',1939,1942),('Crosley','CC',1946,1949),
 ('Crosley','Hotshot',1949,1952),('Crosley','Super Sports',1950,1952),('Crosley','Farm-O-Road',1950,1952),('MG','TA',1936,1939),('MG','TB',1939,1939),('MG','TC',1945,1949),('MG','TD',1950,1953),('MG','TF',1953,1955),('MG','MGA',1955,1962),('MG','Midget',1961,1979),('MG','MGB',1962,1980),('MG','MGB GT',1965,1980),('MG','MGC',1967,1969),('MG','RV8',1992,1995),('MG','MGF',1995,2002)]
out=[]
for qid, d in models.items():
    label=d['label']; make=d['make']
    if label.startswith('Rambler '): make='Rambler'
    model = re.sub(r'^(AMC|Rambler|Studebaker|Hudson|Nash|Packard|Bricklin|Crosley|Citroën|DeLorean|De Tomaso|Geo|Lancia|MG|Triumph|Morris|Shelby)\s+', '', label)
    s_,e_,src,raw = d['s'],d['e'],'wikidata',''
    if d['title'] in prod: s_,e_,raw = prod[d['title']]; src='wikipedia'
    elif s_ is None and d['title'] in lead: s_,e_,raw = lead[d['title']]; src='wikipedia-lead'
    if s_ is None: src=''
    dl = d['desc'].lower()
    note = 'concept' if (d['concept'] or model in CONCEPT_NAMES or 'concept' in dl or 'prototype' in dl or 'show car' in dl) else ''
    if model.startswith('Jeep'): note='belongs under Jeep'
    if model=='Geo/Chevrolet Prizm': note='duplicate'
    out.append([make, model, s_ or '', e_ or '', src, d['title'], qid, note, raw, d['desc'][:60]])
for mk,md,a,b in HAND:
    out = [o for o in out if not (o[0]==mk and o[1]==md)]
    out.append([mk, md, a, b, 'hand', '', '', '', '', 'hand entry - check'])
out.sort(key=lambda o:(o[0], str(o[2]) or '9999', o[1]))
with open(OUT,'w',newline='') as f:
    w = csv.writer(f); w.writerow(['make','model','start','end','years_src','wiki_title','qid','note','raw_years','description'])
    w.writerows(out)
print('rows', len(out)); print('done')
