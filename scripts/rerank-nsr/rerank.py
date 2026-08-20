#!/usr/bin/env python3
"""rerank.py — score a frozen candidate pool with the trained cross-encoder.

LANE-RERANK Phase 3. Deliberately reads a FROZEN pool (dump-candidates.mjs's
<arm>.lists.json + docs.jsonl) rather than retrieving: the box needs no database
credential, and raw-vs-reranked is a paired comparison over the identical list,
which is the only way the delta means "the reranker did this".

  python3 rerank.py --model <dir> --lists <arm>.lists.json --docs docs.jsonl \
      --out reranked.json [--batch 256] [--max-len 256] [--query-chars 600]

Out: [{qid, family, raw_top50:[key], reranked_top50:[key]}]
"""
import argparse, json, time, sys
import torch
from transformers import AutoTokenizer, AutoModelForSequenceClassification

AP = argparse.ArgumentParser()
AP.add_argument('--model', required=True)
AP.add_argument('--lists', required=True)
AP.add_argument('--docs', required=True)
AP.add_argument('--out', required=True)
AP.add_argument('--batch', type=int, default=256)
AP.add_argument('--max-len', type=int, default=256)
AP.add_argument('--query-chars', type=int, default=600)
A = AP.parse_args()

T0 = time.time()
log = lambda m: print(f'[{time.time()-T0:8.1f}s] {m}', flush=True)

DEV = 'cuda' if torch.cuda.is_available() else 'cpu'
log(f'device={DEV} ' + (torch.cuda.get_device_name(0) if DEV == 'cuda' else ''))

L = json.load(open(A.lists))
docs = {}
for line in open(A.docs):
    if line.strip():
        o = json.loads(line); docs[o['key']] = o['text']
log(f"lists: {len(L['qids'])} queries, topk={L['topk']}, arm={L['arm']}, version={L['version']}")
log(f'docs: {len(docs)} candidate documents')

missing = sum(1 for lst in L['lists'] for k in lst if k not in docs)
log(f'candidates with no resolved text: {missing} (scored as empty string, rank preserved by tie-break)')

tok = AutoTokenizer.from_pretrained(A.model)
model = AutoModelForSequenceClassification.from_pretrained(A.model, num_labels=1).to(DEV).eval()
log('model loaded')

out = []
lat = []
pairs_done = 0
for i, qid in enumerate(L['qids']):
    cands = L['lists'][i]
    qtext = L['query_text'][i][:A.query_chars]
    t0 = time.time()
    scores = []
    for s in range(0, len(cands), A.batch):
        chunk = cands[s:s + A.batch]
        enc = tok([qtext] * len(chunk), [docs.get(k, '') for k in chunk],
                  padding=True, truncation=True, max_length=A.max_len, return_tensors='pt').to(DEV)
        with torch.no_grad(), torch.amp.autocast('cuda', dtype=torch.bfloat16, enabled=(DEV == 'cuda')):
            logits = model(**enc).logits.view(-1).float()
        scores.extend(logits.tolist())
        pairs_done += len(chunk)
    lat.append((time.time() - t0) * 1000)
    # stable sort on (-score, original rank): ties keep the encoder's order, so a
    # model that scores everything identically reproduces the raw list exactly
    # rather than shuffling it into a fake delta.
    order = sorted(range(len(cands)), key=lambda j: (-scores[j], j))
    out.append({'qid': qid, 'family': L['family'][i],
                'raw_top50': cands, 'reranked_top50': [cands[j] for j in order]})
    if (i + 1) % 250 == 0:
        log(f'{i+1}/{len(L["qids"])} queries · {pairs_done} pairs · {pairs_done/(time.time()-T0):.0f} pairs/s')

lat.sort()
p = lambda q: lat[min(len(lat) - 1, int(q * len(lat)))]
json.dump(out, open(A.out, 'w'))
log(f'wrote {len(out)} rows -> {A.out}')
log(f'rerank latency per query over {L["topk"]} candidates: p50 {p(.5):.1f} ms · p95 {p(.95):.1f} ms (GPU {DEV}, batch {A.batch})')
