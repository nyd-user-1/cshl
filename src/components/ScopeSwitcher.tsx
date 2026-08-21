// The page-scope label ("medRxiv agents") as a switcher, in the style of
// Vercel's project picker: the label carries an up/down chevron, and clicking
// it opens a findable menu of every sidebar destination — both archives'
// Agents / Papers / Subjects and the Workspace pages — so the user can jump
// scopes without reaching for the navigation menu.
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { ChevronsUpDown, LayoutGrid, Share2 } from "lucide-react";
import { ARCHIVE_LABEL, type ArchiveServer } from "@/hooks/useArchive";

export type ArchiveSection = "agents" | "papers" | "subjects";

const SECTION_LABEL: Record<ArchiveSection, string> = {
  agents: "agents",
  papers: "papers",
  subjects: "subjects",
};

interface Destination {
  label: string;
  path: string;
}

interface DestinationGroup {
  heading: string;
  icon: React.ReactNode;
  items: Destination[];
}

const GROUPS: DestinationGroup[] = [
  ...(["medrxiv", "biorxiv"] as ArchiveServer[]).map((s) => ({
    heading: ARCHIVE_LABEL[s],
    icon: <LayoutGrid className="h-3.5 w-3.5" />,
    items: (["agents", "papers", "subjects"] as ArchiveSection[]).map((sec) => ({
      label: `${ARCHIVE_LABEL[s]} ${SECTION_LABEL[sec]}`,
      path: `/${s}/${sec}`,
    })),
  })),
  {
    heading: "Workspace",
    icon: <Share2 className="h-3.5 w-3.5" />,
    items: [{ label: "Community", path: "/community" }],
  },
];

export function ScopeSwitcher({ server, section }: { server: ArchiveServer; section: ArchiveSection }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const current = `/${server}/${section}`;
  const label = `${ARCHIVE_LABEL[server]} ${SECTION_LABEL[section]}`;

  useEffect(() => {
    if (!open) return;
    setQuery("");
    inputRef.current?.focus();
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return GROUPS;
    return GROUPS.map((g) => ({
      ...g,
      items: g.items.filter((i) => i.label.toLowerCase().includes(q)),
    })).filter((g) => g.items.length > 0);
  }, [query]);

  const go = (path: string) => {
    setOpen(false);
    if (path !== location.pathname) navigate(path);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded-lg px-1.5 py-1 -mx-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
      >
        {label}
        <ChevronsUpDown className="h-3.5 w-3.5 text-muted-foreground" />
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1 z-50 w-[260px] rounded-xl border bg-background shadow-lg animate-in fade-in slide-in-from-top-1 duration-150 overflow-hidden">
          <div className="flex items-center gap-2 border-b px-3 py-2">
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find page..."
              className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
            <kbd className="rounded-md border px-1.5 py-0.5 text-[10px] text-muted-foreground">Esc</kbd>
          </div>

          <div className="max-h-[320px] overflow-y-auto py-1">
            {groups.map((g) => (
              <div key={g.heading}>
                <div className="flex items-center gap-2 px-3 pt-2 pb-1 text-xs font-medium text-muted-foreground">
                  {g.icon}
                  {g.heading}
                </div>
                {g.items.map((item) => (
                  <button
                    key={item.path}
                    onClick={() => go(item.path)}
                    className={`flex w-full items-center px-3 py-2 pl-8 text-sm transition-colors ${
                      item.path === current
                        ? "bg-muted font-medium text-foreground"
                        : "text-foreground hover:bg-muted"
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            ))}
            {groups.length === 0 && (
              <p className="px-3 py-3 text-sm text-muted-foreground">No matching pages.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
