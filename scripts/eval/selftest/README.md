# Eval harness self-tests

Run before paying for a baseline sweep, not after.

- **`discriminate.mjs`** — proves the per-arm similarity metric actually changes the
  ranking. Builds the one case where cosine and inner product *must* disagree: a query on
  axis 0, document A perfectly aligned with norm 1, document B forty-five degrees off with
  norm 5. Cosine must pick A, inner product must pick B. Cleans up after itself.

  This exists because the first version of this test used query vectors identical to their
  own documents, so both operators returned the same winner and the test passed while
  proving nothing about the choice. A self-test that cannot fail is worse than no
  self-test — it manufactures confidence. If you change this file, check that flipping the
  operator still flips the result.

- **`seed.mjs`** — seeds a throwaway arm with varying-norm vectors and a small frozen
  benchmark, so the full `score.mjs` path (registry → query-embedding file → operator →
  metrics → results json) can be exercised end to end without a GPU.

Both write into `preprint_embeddings_medcpt` under `model='selftest'` and delete those rows
on the way out. Neither touches `preprint_embeddings`.
