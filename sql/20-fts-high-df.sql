-- fts_high_df — high-document-frequency lexemes, pruned from OR-semantics search.
--
-- WHY. /api/search's lexical arm uses OR semantics (AND matched 13 documents out of
-- 433,449 on a four-concept query). Naive OR is unshippable: it ranks every match and
-- measured 10,157 ms. Nearly all of that cost is carried by terms appearing in a large
-- share of the corpus — "use", "studi", "univers". Pruning them took the same query to
-- 108 ms, a 94x speedup, with no loss of intent: a term in 2% of documents does not
-- discriminate.
--
-- Built from a 3% TABLESAMPLE (2.3 s) rather than a full ts_stat scan (>60 s, times out).
-- The threshold is scaled to the sample. Refresh after a large ingest; it is advisory,
-- and /api/search falls back to the AND path if pruning empties a query.
CREATE TABLE IF NOT EXISTS fts_high_df (lexeme text PRIMARY KEY, ndoc int);

TRUNCATE fts_high_df;
INSERT INTO fts_high_df
SELECT word, ndoc
  FROM ts_stat('SELECT fts FROM preprints TABLESAMPLE SYSTEM (3)')
 WHERE ndoc > (433449 * 0.02 * 0.03);
