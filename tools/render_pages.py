#!/usr/bin/env python3
"""LiftPad: render the pages of one ALI guide edition to JPEG files and write their list.

Run (needs poppler's pdftoppm; on the N100 in the liftpad-tools:h3 image):
  python3 tools/render_pages.py PDF EDITION OUTDIR ALI_INDEX_CSV
Writes OUTDIR/p<NNN>.jpg for every PDF page (NNN = PDF page, 3 digits; 300 dpi, grayscale,
     JPEG quality 82) and OUTDIR/ali-pages.csv with columns
     edition,pdf_page,guide_page,status,w,h,bytes: one 'ok' row per PDF page, plus one
     'missing_from_scan' row per guide page whose ali-index rows all say missing_from_scan.
     guide_page of a PDF page is taken from the ali-index rows that point at it (empty if none).
     tools/import.py loads ali-pages.csv into the ali_pages table; tools/upload_pages.sh puts the
     images into R2.
Changes: only OUTDIR (created if missing; files of the same names are replaced). Never sends a
     page anywhere. The images are private data: OUTDIR must be outside git.
Exit: 0 done; 2 bad arguments; 3 a page did not render.
"""
import csv
import os
import struct
import subprocess
import sys
from collections import Counter, defaultdict

DPI, QUALITY = 300, 82   # 300 dpi = the scan's own resolution (Rick, 2026-10-17)


def jpeg_size(path):
    """Width and height from the JPEG SOF marker (standard library only)."""
    with open(path, 'rb') as f:
        d = f.read()
    i = 2
    while i < len(d) - 9:
        if d[i] != 0xFF:
            i += 1
            continue
        m = d[i + 1]
        if m in (0xC0, 0xC1, 0xC2):
            h, w = struct.unpack('>HH', d[i + 5:i + 9])
            return w, h
        if m in (0xD8, 0x01) or 0xD0 <= m <= 0xD7:
            i += 2
            continue
        i += 2 + struct.unpack('>H', d[i + 2:i + 4])[0]
    raise ValueError('no SOF marker in ' + path)


def page_count(pdf):
    out = subprocess.run(['pdfinfo', pdf], capture_output=True, text=True, check=True).stdout
    return int(next(x.split()[1] for x in out.splitlines() if x.startswith('Pages:')))


def guide_pages(index_csv, edition):
    """(pdf page -> guide page, sorted guide pages that are missing from the scan)."""
    with open(index_csv, encoding='utf-8', newline='') as f:
        # A CSV without an edition column holds one edition: the one named on the command line
        # (ali-index-2026.csv has no such column; ali-index.csv rows default to 2019).
        rows = [r for r in csv.DictReader(f) if (r.get('edition') or edition) == edition]
    per_pdf = defaultdict(Counter)
    status = defaultdict(set)
    for r in rows:
        if r['guide_page']:
            status[int(r['guide_page'])].add(r['status'])
        if r['pdf_page'] and r['guide_page']:
            per_pdf[int(r['pdf_page'])][int(r['guide_page'])] += 1
    g = {p: c.most_common(1)[0][0] for p, c in per_pdf.items()}
    missing = sorted(gp for gp, s in status.items() if s == {'missing_from_scan'})
    return g, missing


def main(argv):
    if len(argv) != 5:
        print(__doc__)
        return 2
    pdf, edition, out, index_csv = argv[1:]
    if not edition.replace('-', '').isalnum() or not os.path.isfile(pdf) or not os.path.isfile(index_csv):
        print('render_pages: need an existing PDF, an edition like 2019, and an existing ali-index.csv')
        return 2
    os.makedirs(out, exist_ok=True)
    g, missing = guide_pages(index_csv, edition)
    rows, total = [], 0
    for n in range(1, page_count(pdf) + 1):
        base = os.path.join(out, f'p{n:03d}')
        r = subprocess.run(['pdftoppm', '-f', str(n), '-l', str(n), '-r', str(DPI), '-gray', '-jpeg',
                            '-jpegopt', f'quality={QUALITY}', '-singlefile', pdf, base], capture_output=True, text=True)
        if r.returncode != 0 or not os.path.isfile(base + '.jpg'):
            print(f'render_pages: page {n} did not render: {r.stderr.strip()[:200]}')
            return 3
        w, h = jpeg_size(base + '.jpg')
        b = os.path.getsize(base + '.jpg')
        total += b
        rows.append([edition, n, g.get(n, ''), 'ok', w, h, b])
    rows += [[edition, '', gp, 'missing_from_scan', '', '', ''] for gp in missing]
    with open(os.path.join(out, 'ali-pages.csv'), 'w', encoding='utf-8', newline='') as f:
        w = csv.writer(f, lineterminator='\n')
        w.writerow(['edition', 'pdf_page', 'guide_page', 'status', 'w', 'h', 'bytes'])
        w.writerows(rows)
    ok = len(rows) - len(missing)
    print(f'render_pages: edition {edition}: {ok} pages, {total} bytes; guide pages missing from the scan: '
          + (', '.join(map(str, missing)) or 'none'))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
