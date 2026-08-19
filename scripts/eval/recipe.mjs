// recipe.mjs — THE canonical embed-input definition. One place, imported by
// everything on the repo side.
//
// Why this file exists: the lead's cross-lane seam audit (2026-08-19) found that
// lane-mine capped `left(abstract, 4000)` with the title held separate, while
// this lane caps the whole concatenation. Those are different strings for the
// ~1.1% of papers where title+abstract exceeds the cap — precisely the tail our
// own length measurement says gets truncated. Training text would have diverged
// from embedded text there, and it would have shown up as unexplained eval
// weakness rather than as an error. Nothing about that is visible at review time
// unless the expression lives in exactly one place.
//
// SOURCE OF TRUTH is scripts/embed-nsr/worker.mjs (the `JOB.page` SELECT). That
// file cannot import this one — it is uploaded to S3 standalone and runs on a
// GPU box with no repo checkout — so it carries a literal copy, and
// `assertWorkerMatches()` below fails loudly if the two ever drift.
//
// If you change the cap, it is a THREE-lane decision: this lane, lane-mine, and
// whoever owns the model cards. Tell both.

export const CAP = 4000

/** The canonical SQL expression. `alias` is the preprints alias in your query. */
export const recipeSql = (alias = 'p', cap = CAP) =>
  `left(trim(coalesce(${alias}.title,'') || E'\\n\\n' || coalesce(${alias}.abstract,'')), ${cap})`

/** The canonical JS equivalent, for text that never round-trips through SQL. */
export const recipeJs = (title, abstract, cap = CAP) =>
  `${title ?? ''}\n\n${abstract ?? ''}`.trim().slice(0, cap)

/** The exclusion predicate that decides whether a row is embeddable at all. */
export const embeddableSql = (alias = 'p') =>
  `length(regexp_replace(coalesce(${alias}.title,'') || coalesce(${alias}.abstract,''), '\\\\s+', '', 'g')) >= 20`

/**
 * Fail loudly if the box-side worker's literal has drifted from this file.
 * Cheap enough to call at the top of any script that builds training or eval
 * text. Reads the worker source rather than trusting a comment.
 */
export async function assertWorkerMatches() {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../embed-nsr/worker.mjs', import.meta.url), 'utf8')
  // The worker builds its SELECT with ${CAP} interpolated; compare the shape.
  const want = "left(trim(coalesce(p.title,'') || E'\\n\\n' || coalesce(p.abstract,'')), ${CAP})"
  if (!src.includes(want)) {
    throw new Error(
      'RECIPE DRIFT: scripts/embed-nsr/worker.mjs no longer contains the canonical ' +
      'embed expression. Reconcile it with scripts/eval/recipe.mjs before building ' +
      'any training or eval text, and tell lane-mine.',
    )
  }
  return true
}
