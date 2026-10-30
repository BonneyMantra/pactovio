"""Pull EU TED contract notices (v3 search API, no key) and build the Pactovio extraction dataset.
Input = the buyer's own free text rendered like the notice form: buyer, procedure title, description, lots
(title + description), time limit for receipt of tenders, estimated value lines. TED's translated `notice-title`
(which embeds country and CPV category names) is deliberately NOT used: it would leak labels.
Labels come from TED structured fields. Split is grouped by buyer so a buyer never straddles train/val/test.
Usage: python3 build_dataset.py data/ [target_pages]"""
import json, re, sys, time, random, hashlib, urllib.request, collections, unicodedata
from pathlib import Path

ENDPOINT = 'https://api.ted.europa.eu/v3/notices/search'
FIELDS = ['publication-number', 'title-proc', 'description-proc', 'title-lot', 'description-lot', 'identifier-lot',
          'deadline-receipt-tender-date-lot', 'deadline-receipt-tender-time-lot', 'estimated-value-lot',
          'estimated-value-cur-lot', 'classification-cpv', 'buyer-country', 'buyer-name', 'notice-type']
QUERY = 'publication-date>=20260801 AND notice-type=cn-standard'

def post(page):
    body = json.dumps({'query': QUERY, 'fields': FIELDS, 'limit': 250, 'page': page, 'paginationMode': 'PAGE_NUMBER'}).encode()
    for a in range(4):
        try:
            r = urllib.request.Request(ENDPOINT, body, {'content-type': 'application/json', 'accept': 'application/json'})
            return json.load(urllib.request.urlopen(r, timeout=90))
        except Exception as e:
            print('retry', page, e, file=sys.stderr); time.sleep(2 + 3 * a)
    return {'notices': []}

def lang(d, pref=None):
    if not d: return []
    k = pref if pref in d else next(iter(d))
    v = d[k]
    return v if isinstance(v, list) else [v]

def norm(s): return re.sub(r'\s+', ' ', unicodedata.normalize('NFKC', s)).strip()

def render(n):
    tp = n.get('title-proc') or {}
    pref = next(iter(tp), None)
    buyer = norm(' / '.join(lang(n.get('buyer-name'), pref)))
    title = norm(' '.join(lang(tp, pref)))
    desc = norm(' '.join(lang(n.get('description-proc'), pref)))
    ids = n.get('identifier-lot') or []
    lt = [norm(x) for x in lang(n.get('title-lot'), pref)]
    ld = [norm(x) for x in lang(n.get('description-lot'), pref)]
    dates = n.get('deadline-receipt-tender-date-lot') or []
    times = n.get('deadline-receipt-tender-time-lot') or []
    vals = n.get('estimated-value-lot') or []
    cur = n.get('estimated-value-cur-lot') or []
    parts = [f'Contract notice. Buyer: {buyer}', f'Title: {title}', f'Description: {desc[:700]}']
    for i, lid in enumerate(ids):
        t = lt[i] if i < len(lt) else ''
        d = ld[i][:260] if len(ld) == len(ids) else ''
        parts.append(f'{lid}: {t[:160]}' + (f' - {d}' if d and d != desc[:260] else ''))
    for i, d in enumerate(dates):
        t = times[i] if i < len(times) else ''
        parts.append(f'Time limit for receipt of tenders ({ids[i] if i < len(ids) else "lot"}): {d} {t}'.strip())
    for i, v in enumerate(vals):
        parts.append(f'Estimated value ({ids[i] if i < len(ids) else "lot"}): {v} {cur[i] if i < len(cur) else ""}'.strip())
    text = '\n'.join(parts)
    return text[:4200], buyer

def label(n):
    dates = sorted(re.match(r'\d{4}-\d{2}-\d{2}', d).group(0) for d in n['deadline-receipt-tender-date-lot'] if re.match(r'\d{4}-\d{2}-\d{2}', d))
    return {'deadline': dates[0], 'lot_count': len(n['identifier-lot']), 'cpv_division': n['classification-cpv'][0][:2],
            'has_estimated_value': bool(n.get('estimated-value-lot')), 'buyer_country': n['buyer-country'][0]}

def main(out, pages=11):
    out = Path(out); out.mkdir(parents=True, exist_ok=True)
    raw, total = [], None
    for p in range(1, pages + 1):
        r = post(p); total = r.get('totalNoticeCount', total)
        raw += r['notices']; print('page', p, len(r['notices']), file=sys.stderr)
        if len(r['notices']) < 250: break
    stats = collections.Counter(pulled=len(raw)); seen_id, seen_txt, rows = set(), set(), []
    for n in raw:
        nid = n.get('publication-number')
        if nid in seen_id: stats['dup_id'] += 1; continue
        seen_id.add(nid)
        if not (n.get('title-proc') and n.get('description-lot') and n.get('identifier-lot') and n.get('classification-cpv')
                and n.get('buyer-country') and n.get('deadline-receipt-tender-date-lot')): stats['missing_field'] += 1; continue
        if len(n['identifier-lot']) > 15: stats['too_many_lots'] += 1; continue
        text, buyer = render(n)
        key = hashlib.sha1(re.sub(r'\W+', '', text.lower()).encode()).hexdigest()
        if key in seen_txt: stats['dup_text'] += 1; continue
        seen_txt.add(key)
        rows.append({'id': nid, 'buyer': buyer, 'input': text, 'label': label(n)})
    # grouped split by buyer: test >= 200, val ~100, rest train
    random.Random(7).shuffle(rows)
    groups = collections.defaultdict(list)
    for r in rows: groups[r['buyer'].lower()].append(r)
    keys = list(groups); random.Random(11).shuffle(keys)
    split = {'test': [], 'val': [], 'train': []}
    for k in keys:
        tgt = 'test' if len(split['test']) < 220 else 'val' if len(split['val']) < 100 else 'train'
        split[tgt] += groups[k]
    for s, rs in split.items():
        with open(out / f'{s}.jsonl', 'w') as f:
            for r in rs: f.write(json.dumps({k: r[k] for k in ('id', 'input', 'label')}, ensure_ascii=False) + '\n')
    # cross-split check: no shared notice id, normalised input, or buyer
    inp = {s: {re.sub(r'\W+', '', r['input'].lower()) for r in rs} for s, rs in split.items()}
    buy = {s: {r['buyer'].lower() for r in rs} for s, rs in split.items()}
    ids = {s: {r['id'] for r in rs} for s, rs in split.items()}
    ov = lambda d: sum(len(d['test'] & d[o]) for o in ('train', 'val')) + len(d['val'] & d['train'])
    lab = collections.Counter(r['label']['cpv_division'] for r in rows)
    rep = {'source': 'TED v3 search API', 'query': QUERY, 'total_matching': total, 'stats': dict(stats), 'kept': len(rows),
           'split': {s: len(v) for s, v in split.items()}, 'overlap_ids': ov(ids), 'overlap_inputs': ov(inp), 'overlap_buyers': ov(buy),
           'lot_count_dist': dict(collections.Counter(r['label']['lot_count'] for r in rows)),
           'country_dist': dict(collections.Counter(r['label']['buyer_country'] for r in rows).most_common(12)),
           'has_value_rate': sum(r['label']['has_estimated_value'] for r in rows) / max(1, len(rows)), 'cpv_top': lab.most_common(8)}
    (out / 'report.json').write_text(json.dumps(rep, indent=1)); print(json.dumps(rep, indent=1))

if __name__ == '__main__': main(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 11)
