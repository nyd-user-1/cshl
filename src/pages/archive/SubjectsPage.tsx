// /:archive/subjects — the subject catalog (formerly "rooms").
//
// One card per archive category, in the References card-grid layout. Nearly all
// of these categories are MeSH Subject Headings (or named after one), so each
// card carries its MeSH descriptor: scope note, tree number(s), unique ID, and
// a link into NLM's MeSH browser. Selecting a card lands in a chat already
// scoped to that subject — the click IS the routing decision (SMALL-WORLDS:
// every query is scoped before it is typed).
import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { ArrowUp, ArrowUpDown, BookMarked } from "lucide-react";
import { SearchInput } from "@/components/SearchInput";
import { Skeleton } from "@/components/ui/skeleton";
import { ARCHIVE_LABEL, useArchiveCategories, type ArchiveServer } from "@/hooks/useArchive";
import { SUBJECTS, meshUrl, subjectTitle, type Subject } from "@/lib/subjects";

const fmt = (n: number) => n.toLocaleString("en-US");

function SubjectCard({
  server,
  subject,
  papers,
  onOpen,
  onPapers,
}: {
  server: ArchiveServer;
  subject: Subject;
  papers: number;
  onOpen: () => void;
  onPapers: () => void;
}) {
  const title = subjectTitle(subject.category);
  return (
    <div
      onClick={onOpen}
      className="group relative rounded-lg border border-border/40 bg-muted/40 p-4 pb-14 md:p-6 md:pb-16 min-h-[240px] transition-all hover:shadow-lg hover:border-border cursor-pointer"
    >
      <div className="flex items-center gap-2 mb-3">
        <span className="text-base font-bold">{title}</span>
        <BookMarked className="ml-auto h-5 w-5 text-muted-foreground" />
      </div>

      <p className="text-sm text-foreground leading-snug mb-3 line-clamp-4">
        {subject.mesh?.scopeNote ??
          `${ARCHIVE_LABEL[server]} preprints in ${title.toLowerCase()}.`}
      </p>

      <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
        {subject.mesh && subject.mesh.treeNumbers.length > 0 && (
          <div className="min-w-0">
            <span className="text-muted-foreground">Tree Number(s)</span>
            <p className="font-medium truncate">{subject.mesh.treeNumbers.join(", ")}</p>
          </div>
        )}
        {subject.mesh && (
          <div className="min-w-0">
            <span className="text-muted-foreground">Unique ID</span>
            <div className="mt-0.5">
              <a
                href={meshUrl(subject.mesh.id)}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                title="Open in NLM's MeSH browser"
                className="inline-flex items-center rounded-full bg-foreground/10 px-2 py-0.5 text-[11px] font-medium text-foreground/80 hover:bg-foreground/20"
              >
                {subject.mesh.id}
              </a>
            </div>
          </div>
        )}
      </div>

      <div className="absolute bottom-3 left-4 md:bottom-4 md:left-6 right-4 flex items-center justify-between">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onPapers();
          }}
          className="text-xs text-brand hover:underline"
        >
          {fmt(papers)} Papers
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
          title={`Chat with the ${ARCHIVE_LABEL[server]} ${title} preprints`}
          className="flex h-10 w-10 items-center justify-center rounded-full bg-foreground text-background shadow-lg transition-all hover:scale-110 opacity-0 group-hover:opacity-100"
        >
          <ArrowUp className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

export default function SubjectsPage({ server }: { server: ArchiveServer }) {
  const navigate = useNavigate();
  const { data: live, isLoading } = useArchiveCategories(server);
  const [query, setQuery] = useState("");
  const [nameSortAsc, setNameSortAsc] = useState<boolean | null>(null);

  // The static file is the row source (it carries the MeSH data); the live
  // dict supplies current counts and default count-descending order.
  const subjects = useMemo(() => {
    const rows = SUBJECTS[server] ?? [];
    const counts = new Map(live?.map((c) => [c.value, c.record_count]));
    const q = query.trim().toLowerCase();
    let out = rows.map((s) => ({ subject: s, papers: counts.get(s.category) ?? s.papers }));
    if (q)
      out = out.filter(
        ({ subject }) =>
          subject.category.includes(q) ||
          subject.mesh?.label.toLowerCase().includes(q) ||
          subject.mesh?.id.toLowerCase().includes(q),
      );
    if (nameSortAsc !== null)
      out = [...out].sort((a, b) =>
        nameSortAsc
          ? a.subject.category.localeCompare(b.subject.category)
          : b.subject.category.localeCompare(a.subject.category),
      );
    else out = [...out].sort((a, b) => b.papers - a.papers);
    return out;
  }, [server, live, query, nameSortAsc]);

  return (
    <div className="h-full flex flex-col">
      {document.getElementById("header-search") &&
        createPortal(
          <SearchInput value={query} onChange={setQuery} placeholder="Search subjects..." />,
          document.getElementById("header-search")!,
        )}

      <div className="sticky top-0 z-10 bg-background px-3 md:px-6 pt-3 pb-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-foreground">
            {ARCHIVE_LABEL[server]} subjects
          </span>
          <button
            onClick={() => setNameSortAsc((p) => (p === null ? true : p ? false : null))}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition-colors ${
              nameSortAsc !== null
                ? "bg-foreground text-background font-medium"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
          >
            Name
            <ArrowUpDown className="h-3.5 w-3.5" />
          </button>
          <span className="ml-auto text-xs text-muted-foreground">
            Pick a subject and ask — every question there searches only that subject&apos;s
            preprints.
          </span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-3 md:px-6 py-4">
        {isLoading && !subjects.length && (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 9 }).map((_, i) => (
              <Skeleton key={i} className="h-[240px] w-full" />
            ))}
          </div>
        )}

        {subjects.length > 0 && (
          <>
            <div className="mb-2 text-xs text-muted-foreground">
              Showing {subjects.length} of {(SUBJECTS[server] ?? []).length} subjects
            </div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
              {subjects.map(({ subject, papers }) => (
                <SubjectCard
                  key={subject.category}
                  server={server}
                  subject={subject}
                  papers={papers}
                  onOpen={() =>
                    navigate(`/${server}/agents/${encodeURIComponent(subject.category)}`)
                  }
                  onPapers={() =>
                    navigate(`/${server}/papers?category=${encodeURIComponent(subject.category)}`)
                  }
                />
              ))}
            </div>
          </>
        )}

        {!isLoading && subjects.length === 0 && (
          <p className="text-center text-muted-foreground py-12">
            No matching subjects. Try a different query.
          </p>
        )}
      </div>
    </div>
  );
}
