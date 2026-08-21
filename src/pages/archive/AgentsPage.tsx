// /:archive/agents — one scoped assistant per subject, in the References
// card-grid layout.
//
// Honest copy rule (LANE-MEDRXIV-ROOMS): an agent is the SAME retrieval stack
// confined to one subject's preprints. It is NEVER described as a separately
// trained model. Selecting a card lands in that agent's chat.
import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { ArrowUp, ArrowUpDown, Bot } from "lucide-react";
import { SearchInput } from "@/components/SearchInput";
import { Skeleton } from "@/components/ui/skeleton";
import { ARCHIVE_LABEL, useArchiveCategories, type ArchiveServer } from "@/hooks/useArchive";
import { findSubject, meshUrl, subjectTitle } from "@/lib/subjects";

const fmt = (n: number) => n.toLocaleString("en-US");

export default function AgentsPage({ server }: { server: ArchiveServer }) {
  const navigate = useNavigate();
  const label = ARCHIVE_LABEL[server];
  const { data: categories, isLoading, error } = useArchiveCategories(server);
  const [query, setQuery] = useState("");
  // a–z is the default; the Name toggle flips to z–a and back.
  const [nameSortAsc, setNameSortAsc] = useState(true);

  const agents = useMemo(() => {
    if (!categories) return null;
    const q = query.trim().toLowerCase();
    let out = categories;
    if (q) out = out.filter((c) => c.value.includes(q));
    return [...out].sort((a, b) =>
      nameSortAsc ? a.value.localeCompare(b.value) : b.value.localeCompare(a.value),
    );
  }, [categories, query, nameSortAsc]);

  const openAgent = (category: string) =>
    navigate(`/${server}/agents/${encodeURIComponent(category)}`);

  return (
    <div className="h-full flex flex-col">
      {document.getElementById("header-search") &&
        createPortal(
          <SearchInput value={query} onChange={setQuery} placeholder="Search agents..." />,
          document.getElementById("header-search")!,
        )}

      <div className="sticky top-0 z-10 bg-background px-3 md:px-6 pt-3 pb-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-foreground">{label} agents</span>
          <button
            onClick={() => setNameSortAsc((p) => !p)}
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            Name
            <ArrowUpDown className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-3 md:px-6 py-4">
        {error != null && (
          <p className="text-sm text-muted-foreground">
            The agent list failed to load — reload the page to retry.
          </p>
        )}

        {isLoading && (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 9 }).map((_, i) => (
              <Skeleton key={i} className="h-[240px] w-full" />
            ))}
          </div>
        )}

        {agents && agents.length > 0 && (
          <>
            <div className="mb-2 text-xs text-muted-foreground">
              Showing {agents.length} of {categories!.length} agents
            </div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
              {agents.map((c) => {
                const title = subjectTitle(c.value);
                const mesh = findSubject(server, c.value)?.mesh;
                return (
                  <div
                    key={c.value}
                    onClick={() => openAgent(c.value)}
                    className="group relative rounded-lg border border-border/40 bg-muted/40 p-4 pb-14 md:p-6 md:pb-16 min-h-[280px] transition-all hover:shadow-lg hover:border-border cursor-pointer"
                  >
                    <div className="flex items-center gap-2 mb-3">
                      <span className="text-base font-bold">{title} Agent</span>
                      <Bot className="ml-auto h-5 w-5 text-muted-foreground" />
                    </div>

                    <p className="text-sm text-foreground leading-snug mb-3">
                      Answers from {label}&apos;s {title.toLowerCase()} preprints.
                    </p>

                    <div className="grid grid-cols-1 gap-y-2 text-xs">
                      <div className="min-w-0">
                        <span className="text-muted-foreground">Scope</span>
                        <p className="font-medium truncate">
                          {label} · {title}
                          {mesh ? ` · MeSH ${mesh.id}` : ""}
                        </p>
                      </div>
                      {mesh && mesh.seeAlso.length > 0 && (
                        <div className="min-w-0">
                          <span className="text-muted-foreground">See Also</span>
                          <p className="font-medium truncate">
                            {mesh.seeAlso.map((s, i) => (
                              <span key={s.id}>
                                {i > 0 && ", "}
                                <a
                                  href={meshUrl(s.id)}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  onClick={(e) => e.stopPropagation()}
                                  className="hover:underline"
                                >
                                  {s.label}
                                </a>
                              </span>
                            ))}
                          </p>
                        </div>
                      )}
                    </div>

                    <div className="absolute bottom-3 left-4 md:bottom-4 md:left-6 right-4 flex items-center justify-between">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          navigate(`/${server}/papers?category=${encodeURIComponent(c.value)}`);
                        }}
                        className="text-xs text-brand hover:underline"
                      >
                        {fmt(c.record_count)} Papers
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          openAgent(c.value);
                        }}
                        title={`Chat with the ${label} ${title} preprints`}
                        className="flex h-10 w-10 items-center justify-center rounded-full bg-foreground text-background shadow-lg transition-all hover:scale-110 opacity-0 group-hover:opacity-100"
                      >
                        <ArrowUp className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {agents && agents.length === 0 && (
          <p className="text-center text-muted-foreground py-12">
            No matching agents. Try a different query.
          </p>
        )}
      </div>
    </div>
  );
}
