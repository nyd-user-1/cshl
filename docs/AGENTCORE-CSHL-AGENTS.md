# Two CSHL agents on Bedrock AgentCore

**Run 2026-08-20, branch `lane/bedrock-kb`, account 638175140432, us-east-1.**

## Why AgentCore and not Bedrock Agents

`bedrock-agent create-agent` returns:

> Bedrock Agents is in Maintenance Mode. New agent creation is not available for accounts
> without prior service usage.

So classic agents are closed to this account. The working path is **AgentCore**, which the
account already runs (`Scout`, `Penny`, `Friday`). The configuration here was read off the
live `Friday` harness rather than reconstructed from docs.

## Shape

```
harness (model + system prompt)  ──►  gateway (MCP, AWS_IAM inbound)  ──►  lambda target
CshlPubStatusClerk-PIqerJSycD          cshl-kb-gateway-ydn5tqpavx           cshl-kb-pubstatus
CshlRelatedWork-i5WqGC0h0t             targets: cshl-pubstatus, cshl-related cshl-kb-relatedwork
```

Inbound auth is **AWS_IAM**, not Cognito. 44b's gateway uses `CUSTOM_JWT` with a user pool and
an OAuth credential provider; with `outboundAuth: {awsIam:{}}` on the harness side none of
that is needed, which removes a user pool, a client secret and a token vault entry from the
blast radius. Model is `claude-haiku-4-5`, matching /chat.

## Agent 1 — `CshlPubStatusClerk`

**Job.** Given a preprint, establish whether it has since been peer reviewed.

**Why it exists.** /chat asserted in bold that Vink et al. `2021.05.04.442622` "remains a
preprint and has not yet been published in peer-reviewed literature", and built a whole
Limitations section on that premise. It has been in *Genome Biology* since 2021-09-30. The
model was faithful to our row; `published_journal` is NULL there and on **50.3% of 433,449
rows**.

**The design decision that matters.** The match is a Crossref **bibliographic query on title
plus author surnames**, never the DOI relation — because the DOI relation is exactly what
fails when a paper is retitled on acceptance, which is what happened here ("Comprehensive PAM
prediction…" became "PAM-repeat associations…"). Author agreement (≥2 shared surnames) is the
gate; title overlap only ranks. A same-title paper by different authors must not match.

**Test — passed:**

```
$ node scripts/kb/invoke-harness.mjs pubstatus 'Has this preprint been peer reviewed? …Vink…'

Journal: Genome Biology
Published DOI: 10.1186/s13059-021-02495-9
Publication Date: September 30, 2021
Note on title change: retitled upon acceptance — [both titles given]

usage: input=1666 output=151 est_cost=$0.0024
```

## Agent 2 — `CshlRelatedWork`

**Job.** Related work, and candidate peer reviewers with a conflict filter.

**Why it exists.** `preprint_embeddings_cshl` holds 433,449 CITE-encoder vectors. The main
report names it the better document→document encoder (R@10 0.2120 vs 0.1980) and "the right
arm for more-like-this, reviewer matching and systematic-review expansion", then records that
it has **no query-side route in the app**. It has been inert since the qpairs flip. This is
its route.

It is doc→doc, so the probe is the source paper's own stored vector: no encoder call, no
serve box, and no way to disturb a checkpoint another lane has loaded.

**Test — passed.** Reviewers for `2021.05.04.442622`:

| # | first author | paper | sim |
|---|---|---|---|
| 1 | Roux, S. (2025) | Planetary-scale metagenomic search reveals new patterns of CRISPR targeting | 0.884 |
| 2 | Mendoza, B. J. (2018) | In Silico Processing of the Complete CRISPR-Cas Spacer Space… (*Biotechnology Journal*) | 0.884 |
| 3 | Collins, A. J. (2022) | CRISPR comparison toolkit (CCTK) (*The CRISPR Journal*) | 0.877 |
| 6 | Fehrenbach, A. (2025) | An evolutionary approach to predict the orientation of CRISPR arrays (*PLOS Comp Biol*) | 0.862 |

#6 is the array-orientation literature an outside reviewer independently said this paper gets
cited in — surfaced by our own encoder, from a table that had no route.

**Conflict filter verified firing** on a separate case: source `2022.05.30.494039`
(Dhingra/Sashital), `mode=reviewers` drops `2023.06.05.543779` — the same authors' follow-up.

## The bug worth keeping

Both Lambdas worked locally and failed in production, silently.

An **AgentCore Gateway lambda target passes the tool input as the event itself**
(`{"title": "…"}`). A **classic action group** sends `event.parameters[{name,value}]` and
expects a `{messageVersion, response:{…}}` envelope. The first build understood only the
classic shape. The gateway invoked it four times, each threw `title is required` in 1.7 ms,
and the agent — unable to use the tool it exists to use — fell back to memory and asserted
the paper appeared in *Nucleic Acids Research*. Wrong journal, stated confidently, by the
agent whose entire purpose is preventing that error.

**A tool that fails closed still produces a confident answer.** Both handlers now detect the
shape and reply in kind, and both log the raw event.

## Known gaps

- `invoke-harness.mjs` prints `tools called: (none)` even when the tool plainly ran — the
  frame parser does not recognise AgentCore's tool-event key. Cosmetic; the transcript proves
  the call. Left visible rather than silently patched over.
- `DATABASE_URL` is a Lambda environment variable on `cshl-kb-relatedwork`. Adequate for an
  experiment, not for long. Secrets Manager is the right home, and the handoff already carries
  an open "rotate the Neon password" item — rotating a shared credential is not this lane's
  call.
- Surname-only conflict checking is coarse: it misses shared institutions, recent
  collaboration and funding ties. The agent says so in its own output.

## Invoking

```sh
python3 -m venv /tmp/cshl-kb-venv && /tmp/cshl-kb-venv/bin/pip install boto3
node scripts/kb/invoke-harness.mjs pubstatus "Has <title> by <authors> been peer reviewed?"
node scripts/kb/invoke-harness.mjs related   "Who should review 2021.05.04.442622?"
```

`InvokeHarness` is a data-plane operation aws-cli 2.36.5 does not expose, so this shells out
to boto3 — the same pattern as 44b's `invoke-agent.mjs`. Every call prints token counts and
an estimated cost. Typical run $0.002–$0.005.
