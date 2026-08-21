// cshl-kb-subjectsearch — the subject agents' retrieval tool.
//
// Calls the LIVE site's /api/search (the fine-tuned encoder + FTS, RRF-fused,
// subject-scoped): the AgentCore harness rents the voice, this Lambda keeps the
// pipeline ours. No DB credential — the public API is the contract.
//
// Event shape (LEARNED THE HARD WAY, see docs/AGENTCORE-CSHL-AGENTS.md): an
// AgentCore gateway lambda target passes the tool input AS the event
// ({"query": "..."}). A classic action group sends event.parameters[]. Both
// shapes are handled and the raw event is logged, because a tool that fails
// closed still produces a confident answer.
const SITE = process.env.SITE_URL || "https://cshl.nysgpt.com";

const fromClassic = (event) => {
  const out = {};
  for (const p of event?.parameters ?? []) out[p.name] = p.value;
  return out;
};

export const handler = async (event) => {
  console.log("raw event:", JSON.stringify(event).slice(0, 2000));
  const classic = Array.isArray(event?.parameters);
  const input = classic ? fromClassic(event) : (event ?? {});

  const query = String(input.query ?? "").trim();
  const server = ["biorxiv", "medrxiv"].includes(String(input.server)) ? String(input.server) : null;
  const category = String(input.category ?? "").trim().toLowerCase() || null;
  const limit = Math.min(20, Math.max(1, Number(input.limit) || 8));

  const respond = (body) =>
    classic
      ? { messageVersion: "1.0", response: { actionGroup: event.actionGroup, function: event.function, functionResponse: { responseBody: { TEXT: { body: JSON.stringify(body) } } } } }
      : body;

  if (!query) return respond({ error: "query is required" });

  const u = new URL("/api/search", SITE);
  u.searchParams.set("q", query);
  u.searchParams.set("mode", "hybrid");
  u.searchParams.set("limit", String(limit));
  if (server) u.searchParams.set("server", server);
  if (server && category) u.searchParams.set("category", category);

  const r = await fetch(u, { headers: { accept: "application/json" } });
  if (!r.ok) return respond({ error: `search ${r.status}` });
  const d = await r.json();

  return respond({
    count: d.count ?? 0,
    mode: d.mode,
    scope: server ? { server, category } : "whole corpus",
    widened: d.widened ?? false,
    results: (d.records ?? []).slice(0, limit).map((p) => ({
      key_number: p.key_number,
      title: p.title,
      authors: p.authors,
      year: p.pub_year,
      doi: p.doi,
      similarity: p.similarity == null ? null : Number(Number(p.similarity).toFixed(3)),
      published_journal: p.published_journal ?? null,
      abstract: p.abstract ? String(p.abstract).slice(0, 700) : null,
    })),
  });
};
