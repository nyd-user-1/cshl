// /:archive/subjects — the subject catalog (formerly "subjects").
//
// One card per archive category, in the References card-grid layout. Nearly all
// of these categories are MeSH Subject Headings (or named after one), so each
// card carries its MeSH descriptor: scope note, tree number(s), unique ID, and
// a link into NLM's MeSH browser. Selecting a card lands in a chat already
// scoped to that subject — the click IS the routing decision (SMALL-WORLDS:
// every query is scoped before it is typed).
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { ArrowUp, ArrowUpDown, BookMarked, ChevronDown } from "lucide-react";
import { ScopeSwitcher } from "@/components/ScopeSwitcher";
import { SearchInput } from "@/components/SearchInput";
import { Skeleton } from "@/components/ui/skeleton";
import { DictCombobox } from "@/components/DictCombobox";
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
      className="group relative rounded-lg border border-border/40 bg-muted/40 p-4 pb-14 md:p-6 md:pb-16 min-h-[280px] transition-all hover:shadow-lg hover:border-border cursor-pointer"
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

/** MeSH top-level trees, the ones this corpus actually lands in. */
const TREES: { code: string; label: string }[] = [
  { code: "C", label: "Diseases" },
  { code: "E", label: "Techniques" },
  { code: "F", label: "Psychiatry" },
  { code: "G", label: "Phenomena" },
  { code: "H", label: "Disciplines" },
  { code: "I", label: "Social" },
  { code: "L", label: "Information" },
  { code: "N", label: "Health Care" },
];

function TreeFilter({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);
  const active = TREES.find((t) => t.code === value);
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition-colors ${
          value ? "bg-foreground text-background font-medium" : "text-muted-foreground hover:bg-muted hover:text-foreground"
        }`}
      >
        {active ? `Tree: ${active.label}` : "Tree"}
        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 min-w-[180px] rounded-lg border bg-background shadow-md">
          {value && (
            <button
              onClick={() => { onChange(""); setOpen(false); }}
              className="flex w-full px-3 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              Clear filter
            </button>
          )}
          {TREES.map((t) => (
            <button
              key={t.code}
              onClick={() => { onChange(t.code); setOpen(false); }}
              className={`flex w-full px-3 py-2 text-sm transition-colors ${
                value === t.code ? "bg-muted font-medium text-foreground" : "text-foreground hover:bg-muted"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function SubjectsPage({ server }: { server: ArchiveServer }) {
  const navigate = useNavigate();
  const { data: live, isLoading } = useArchiveCategories(server);
  const [query, setQuery] = useState("");
  // a–z is the default; the Name toggle flips to z–a and back.
  const [nameSortAsc, setNameSortAsc] = useState(true);
  const [sizeSortDesc, setSizeSortDesc] = useState<boolean | null>(null);
  const [subjectFilter, setSubjectFilter] = useState("");
  // MeSH tree letter — C is Diseases, E Techniques, H Disciplines, N Health Care.
  const [tree, setTree] = useState("");

  // The static file is the row source (it carries the MeSH data); the live
  // dict supplies current counts.
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
    const subj = subjectFilter.trim().toLowerCase();
    if (subj) out = out.filter(({ subject }) => subject.category === subj);
    if (tree)
      out = out.filter(({ subject }) =>
        (subject.mesh?.treeNumbers ?? []).some((t) => t.startsWith(tree)),
      );
    if (sizeSortDesc !== null)
      return [...out].sort((a, b) => (sizeSortDesc ? b.papers - a.papers : a.papers - b.papers));
    return [...out].sort((a, b) =>
      nameSortAsc
        ? a.subject.category.localeCompare(b.subject.category)
        : b.subject.category.localeCompare(a.subject.category),
    );
  }, [server, live, query, nameSortAsc, sizeSortDesc, subjectFilter, tree]);

  return (
    <div className="h-full flex flex-col">
      {document.getElementById("header-search") &&
        createPortal(
          <SearchInput value={query} onChange={setQuery} placeholder="Search subjects..." />,
          document.getElementById("header-search")!,
        )}

      <div className="sticky top-0 z-10 bg-background px-3 md:px-6 pt-3 pb-2">
        <div className="flex flex-wrap items-center gap-2">
          <ScopeSwitcher server={server} section="subjects" />
          <button
            onClick={() => { setNameSortAsc((p) => !p); setSizeSortDesc(null); }}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition-colors ${
              sizeSortDesc === null
                ? "bg-foreground text-background font-medium"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
          >
            Name
            <ArrowUpDown className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setSizeSortDesc((p) => (p === null ? true : !p))}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition-colors ${
              sizeSortDesc !== null
                ? "bg-foreground text-background font-medium"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
          >
            Papers
            <ArrowUpDown className="h-3.5 w-3.5" />
          </button>
          <TreeFilter value={tree} onChange={setTree} />
          <DictCombobox
            label="Subject"
            dictType="categories"
            placeholder="e.g. neurology"
            value={subjectFilter}
            onChange={setSubjectFilter}
            onSubmit={(v) => setSubjectFilter(v ?? "")}
            server={server}
          />
          <span className="ml-auto text-xs text-muted-foreground">
            {subjects.length} of {(SUBJECTS[server] ?? []).length} subjects
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
