#!/opt/pytorch/bin/python3
# LANE-TRAIN Phase 3: candidate-embed the frozen 277,068-row corpus +
# LANE-EVAL's frozen nsr_eval_queries with the trained checkpoint, build the
# HNSW index. Fetched fresh from S3 at the point of use (not baked into
# train.sh at boot) specifically so it can be fixed and re-uploaded WHILE a
# Phase 2 training run is already in flight on the same box.
#
# TWO fixes landed here on 2026-08-17, not just "use TEI for speed":
#
# 1. CORRECTNESS BUG, found while building the speed fix: the checkpoint
#    FlagEmbedding's trainer saves carries NO sentence-transformers config
#    (no modules.json / 1_Pooling/config.json), even though training used
#    --sentence_pooling_method cls. Loading it via bare
#    `SentenceTransformer(ckpt)` silently defaults to MEAN pooling (confirmed:
#    `Pooling({'pooling_mode': 'mean', ...})` printed from the loaded model) —
#    NOT what the model was trained with. Measured cosine between the
#    sentence_transformers (mean) and TEI (cls, TEI's own fallback for a
#    BERT-variant with no pooling config) embedding of the same text: 0.76 —
#    not a rounding difference, a different vector. This means LANE-TRAIN
#    Phase 1's rehearsal sanity-embed (dims/norm/NaN via bare
#    SentenceTransformer) validated SHAPE, not semantic correctness — it was
#    silently checking a mean-pooled embedding, not the model's real
#    (cls-pooled) output. `ensure_pooling_config()` below writes the correct
#    SBERT config into the checkpoint dir before anything reads it, so both
#    TEI and sentence_transformers agree from here on — and TEI is ALSO told
#    `--pooling cls` explicitly rather than relying on its own fallback guess
#    (which happened to be right, but "happened to" is not a foundation).
# 2. SPEED: raw sentence_transformers.encode() measured 224.6 rows/s on the
#    rehearsal's 5,000-row check — TEI (the rig that did 277,068 rows in
#    4.2 min = 1,089 rows/s on LANE-EMBED) is ~4.8x faster and is what
#    Phase 1's own speed-config lever (5) specifies for this exact step.
#
# Env: RUN_ID, DATABASE_URL, CKPT (checkpoint dir, defaults to /opt/train/out)
import json, os, subprocess, time, urllib.request
import psycopg2

RUN_ID = os.environ['RUN_ID']
CKPT = os.environ.get('CKPT', '/opt/train/out')
CAP = 2000
DB_BATCH = 1024   # rows per DB round-trip (matches embed-nsr worker.mjs PAGE)
CHUNK = 128       # texts per TEI call (matches embed-nsr worker.mjs CHUNK)
TEI = 'http://127.0.0.1:8080'


def ensure_pooling_config(ckpt):
    os.makedirs(f'{ckpt}/1_Pooling', exist_ok=True)
    with open(f'{ckpt}/modules.json', 'w') as f:
        json.dump([
            {"idx": 0, "name": "0", "path": "", "type": "sentence_transformers.models.Transformer"},
            {"idx": 1, "name": "1", "path": "1_Pooling", "type": "sentence_transformers.models.Pooling"},
        ], f)
    with open(f'{ckpt}/1_Pooling/config.json', 'w') as f:
        json.dump({
            "word_embedding_dimension": 1024,
            "pooling_mode_cls_token": True,
            "pooling_mode_mean_tokens": False,
            "pooling_mode_max_tokens": False,
            "pooling_mode_mean_sqrt_len_tokens": False,
            "pooling_mode_weightedmean_tokens": False,
            "pooling_mode_lasttoken": False,
        }, f)
    with open(f'{ckpt}/sentence_bert_config.json', 'w') as f:
        json.dump({"max_seq_length": 256, "do_lower_case": False}, f)
    print(f'[candidate-embed] wrote explicit CLS-pooling SBERT config into {ckpt}')


ensure_pooling_config(CKPT)

subprocess.run(['docker', 'rm', '-f', 'candidate-tei'], capture_output=True)
subprocess.run([
    'docker', 'run', '-d', '--gpus', 'all', '-p', '8080:80', '--name', 'candidate-tei',
    '-v', f'{CKPT}:/model',
    'ghcr.io/huggingface/text-embeddings-inference:89-1.8',
    '--model-id', '/model', '--pooling', 'cls', '--dtype', 'float16',
    '--max-client-batch-size', str(CHUNK * 2), '--max-batch-tokens', '131072',
], check=True)
for _ in range(60):
    try:
        urllib.request.urlopen(f'{TEI}/health', timeout=3)
        print('[candidate-embed] TEI healthy')
        break
    except Exception:
        time.sleep(5)
else:
    raise RuntimeError('TEI did not become healthy within 300s')


def tei_embed(texts):
    out = []
    for i in range(0, len(texts), CHUNK):
        chunk = texts[i:i + CHUNK]
        req = urllib.request.Request(
            f'{TEI}/embed',
            data=json.dumps({'inputs': chunk, 'truncate': True}).encode(),
            headers={'content-type': 'application/json'},
        )
        out.extend(json.loads(urllib.request.urlopen(req).read()))
    return out


# psycopg2 adapts a nested Python list of floats to a `numeric[]` literal,
# and Postgres has no numeric[]->vector[] array cast (only scalar
# text->vector). Build the bracketed text literal per vector and cast each
# UNNESTED scalar, matching scripts/embed-nsr/worker.mjs's proven pattern
# exactly (`unnest($2::text[])::vector(1024)`) — verified end-to-end against
# nsr_embeddings_candidate on a live box before trusting it here (20-row
# write + read-back, self cosine-distance 0.0).
def vec_lit(v):
    return '[' + ','.join(f'{x:.6f}' for x in v) + ']'


conn = psycopg2.connect(os.environ['DATABASE_URL'])
conn.autocommit = False


def embed_table(cur, select_sql, upsert_sql, id_field):
    cur.execute(select_sql)
    rows = cur.fetchall()
    print(f"[candidate-embed] {id_field}: {len(rows)} rows to embed")
    n = 0
    t0 = time.time()
    for i in range(0, len(rows), DB_BATCH):
        chunk = rows[i:i + DB_BATCH]
        ids = [r[0] for r in chunk]
        texts = [r[1] for r in chunk]
        vecs = [vec_lit(v) for v in tei_embed(texts)]
        cur.execute(upsert_sql, (ids, RUN_ID, vecs))
        conn.commit()
        n += len(chunk)
        if n % (DB_BATCH * 10) == 0 or n == len(rows):
            print(f"[candidate-embed] {id_field}: {n}/{len(rows)} ({n / (time.time() - t0):.1f} rows/s)")
    return n


with conn.cursor() as cur:
    n_corpus = embed_table(
        cur,
        f"""SELECT key_number, left(trim(coalesce(title,'') || E'\n\n' || coalesce(abstract,'')), {CAP})
              FROM nsr
             WHERE length(regexp_replace(coalesce(title,'') || coalesce(abstract,''), '\\s+', '', 'g')) >= 20""",
        """INSERT INTO nsr_embeddings_candidate (key_number, run_id, embedding)
           SELECT unnest(%s::text[]), %s, unnest(%s::text[])::vector(1024)
               ON CONFLICT (key_number) DO UPDATE
              SET run_id = EXCLUDED.run_id, embedding = EXCLUDED.embedding, embedded_at = now()""",
        'corpus',
    )
    n_queries = embed_table(
        cur,
        "SELECT qid, text FROM nsr_eval_queries",
        """INSERT INTO nsr_eval_queries_candidate (qid, run_id, embedding)
           SELECT unnest(%s::text[]), %s, unnest(%s::text[])::vector(1024)
               ON CONFLICT (qid) DO UPDATE
              SET run_id = EXCLUDED.run_id, embedding = EXCLUDED.embedding, embedded_at = now()""",
        'eval_queries',
    )
    print("[candidate-embed] HNSW build...")
    t0 = time.time()
    cur.execute("SET maintenance_work_mem = '4GB'")
    cur.execute("DROP INDEX IF EXISTS nsr_embeddings_candidate_embedding_idx")
    cur.execute("""CREATE INDEX nsr_embeddings_candidate_embedding_idx
                     ON nsr_embeddings_candidate USING hnsw (embedding vector_cosine_ops)
                     WITH (m = 16, ef_construction = 64)""")
    cur.execute("ANALYZE nsr_embeddings_candidate")
    conn.commit()
    print(f"[candidate-embed] HNSW build: {time.time() - t0:.0f}s. corpus={n_corpus} queries={n_queries}")

subprocess.run(['docker', 'rm', '-f', 'candidate-tei'], capture_output=True)
