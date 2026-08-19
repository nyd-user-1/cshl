import { useNavigate, useLocation } from "react-router-dom";
import { STRUCTURE_DATA_V } from "@/lib/structure";
import {
  SquarePen,
  Atom,
  FileText,
  Search,
  ChevronDown,
  MoreHorizontal,
  Pencil,
  Trash2,
  MessageSquare,
  Grid3x3,
  Share2,
  Layers,
} from "lucide-react";
import { useState, useRef, useEffect } from "react";
import { useChatSessions } from "@/hooks/useChatSessions";
import { UserMenu } from "@/components/UserMenu";

/* ------------------------------------------------------------------ */
/*  Chat session item with hover menu                                  */
/* ------------------------------------------------------------------ */

interface ChatSessionItemProps {
  id: string;
  title: string;
  isActive: boolean;
  onNavigate: () => void;
  onRefresh: () => void;
}

function ChatSessionItem({
  id,
  title,
  isActive,
  onNavigate,
  onRefresh,
}: ChatSessionItemProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(title);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  // Close menu on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    if (menuOpen) document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [menuOpen]);

  // Focus input when renaming
  useEffect(() => {
    if (isRenaming) inputRef.current?.focus();
  }, [isRenaming]);

  const handleRename = async () => {
    const trimmed = renameValue.trim();
    if (!trimmed || trimmed === title) {
      setIsRenaming(false);
      setRenameValue(title);
      return;
    }
    await fetch(`/api/chat-sessions?id=${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: trimmed }) });
    setIsRenaming(false);
    onRefresh();
  };

  const handleDelete = async () => {
    await fetch(`/api/chat-sessions?id=${id}`, { method: "DELETE" });
    onRefresh();
    if (isActive) navigate("/");
  };

  if (isRenaming) {
    return (
      <div className="px-3 py-1.5">
        <input
          ref={inputRef}
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleRename();
            if (e.key === "Escape") {
              setIsRenaming(false);
              setRenameValue(title);
            }
          }}
          onBlur={handleRename}
          className="w-full rounded-md border px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-foreground/20"
        />
      </div>
    );
  }

  return (
    <div className="group relative" ref={menuRef}>
      <button
        onClick={onNavigate}
        className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 pr-10 text-sm transition-colors ${
          isActive
            ? "bg-muted font-medium"
            : "text-muted-foreground hover:bg-muted hover:text-foreground"
        }`}
      >
        <MessageSquare className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
        <span className="truncate">{title.replace(/^Tell me about\s*/i, "").replace(/^["'\u201C\u201D]+/, "")}</span>
      </button>

      {/* Hover ... button */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          setMenuOpen(!menuOpen);
        }}
        className={`absolute right-2 top-1/2 -translate-y-1/2 h-7 w-7 rounded-md flex items-center justify-center transition-opacity ${
          menuOpen
            ? "opacity-100 bg-muted"
            : "opacity-100 md:opacity-0 md:group-hover:opacity-100 hover:bg-muted"
        }`}
      >
        <MoreHorizontal className="h-4 w-4 text-muted-foreground" />
      </button>

      {/* Context menu */}
      {menuOpen && (
        <div className="absolute right-0 top-full mt-1 z-50 w-[160px] rounded-lg border bg-background shadow-lg animate-in fade-in slide-in-from-top-1 duration-100 py-1">
          <button
            onClick={() => {
              setMenuOpen(false);
              setIsRenaming(true);
              setRenameValue(title);
            }}
            className="flex w-full items-center gap-2.5 px-3 py-2 text-sm hover:bg-muted transition-colors"
          >
            <Pencil className="h-3.5 w-3.5" />
            Rename
          </button>
          <button
            onClick={() => {
              setMenuOpen(false);
              handleDelete();
            }}
            className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-destructive hover:bg-muted transition-colors"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Sidebar                                                            */
/* ------------------------------------------------------------------ */

interface SidebarProps {
  isOpen: boolean;
  onClose?: () => void;
}

/** ENSDF sub-nav — indented, one size down from the top-level items. */
const ENSDF_ITEMS: { label: string; path: string; prefetch: () => Promise<unknown> }[] = [
  { label: "Chart", path: "/ensdf/chart", prefetch: () => Promise.all([import("@/pages/Structure"), fetch(`/data/structure/index.json?v=${STRUCTURE_DATA_V}`).catch(() => {})]) },
  { label: "About", path: "/ensdf/about", prefetch: () => import("@/pages/ensdf/About") },
  { label: "Help", path: "/ensdf/help", prefetch: () => import("@/pages/ensdf/Help") },
  { label: "Evaluation index", path: "/ensdf/evaluation", prefetch: () => Promise.all([import("@/pages/ensdf/Evaluation"), fetch(`/data/structure/index.json?v=${STRUCTURE_DATA_V}`).catch(() => {})]) },
  { label: "Policies", path: "/ensdf/docs", prefetch: () => import("@/pages/ensdf/Docs") },
  { label: "Archive", path: "/ensdf/archive", prefetch: () => Promise.all([import("@/pages/ensdf/Archive"), fetch("/data/ensdf-archivals.json").catch(() => {})]) },
];

/** NSR sub-nav. */
const NSR_ITEMS: { label: string; path: string; prefetch: () => Promise<unknown> }[] = [
  { label: "Archive", path: "/nsr/archive", prefetch: () => Promise.all([import("@/pages/nsr/Archive"), fetch("/data/nsr-archivals.json").catch(() => {})]) },
];

/** Workspace sub-nav — a–z. */
const WORKSPACE_ITEMS: { label: string; path: string; prefetch: () => Promise<unknown> }[] = [
  { label: "Code", path: "/code", prefetch: () => Promise.all([import("@/pages/CodePage"), fetch("/data/nsdd-repos.json").catch(() => {})]) },
  { label: "Community", path: "/community", prefetch: () => import("@/pages/Community") },
  { label: "Graph", path: "/graph/137", prefetch: () => import("@/pages/GraphPage") },
  { label: "Tools", path: "/tools", prefetch: () => import("@/pages/Tools") },
];

/** A collapsible nav group: the label opens its landing (or toggles when there is none); the chevron only toggles. */
function Group({ label, icon, active, expanded, onToggle, onOpen, onHover, items, pathname, go }: {
  label: string; icon: React.ReactNode; active: boolean; expanded: boolean;
  onToggle: () => void; onOpen: () => void; onHover?: () => void;
  items: { label: string; path: string; prefetch: () => Promise<unknown> }[];
  pathname: string; go: (path: string) => void;
}) {
  return (
    <div>
      <div className={`flex items-center rounded-lg text-sm font-medium transition-colors ${active ? "bg-muted" : "hover:bg-muted"}`}>
        <button onClick={onOpen} onMouseEnter={onHover} className="flex flex-1 items-center gap-3 px-3 py-2.5 text-left">
          {icon}
          {label}
        </button>
        <button
          onClick={onToggle}
          className="mr-1 flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label={expanded ? `Collapse ${label}` : `Expand ${label}`}
        >
          <ChevronDown className={`h-4 w-4 transition-transform ${expanded ? "" : "-rotate-90"}`} />
        </button>
      </div>
      {expanded && (
        <div className="space-y-0.5">
          {items.map((item) => (
            <button
              key={item.path}
              onClick={() => go(item.path)}
              onMouseEnter={() => { item.prefetch(); }}
              className={`flex w-full items-center rounded-lg py-1.5 pl-10 pr-3 text-xs transition-colors ${
                pathname === item.path || (item.path.includes("/graph") && pathname.startsWith("/graph"))
                  ? "bg-muted font-medium text-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** XUNDL sub-nav — same shape as ENSDF's. */
const XUNDL_ITEMS: { label: string; path: string; prefetch: () => Promise<unknown> }[] = [
  { label: "Chart", path: "/xundl/chart", prefetch: () => Promise.all([import("@/pages/Structure"), fetch(`/data/structure/index.json?v=${STRUCTURE_DATA_V}`).catch(() => {})]) },
  { label: "About", path: "/xundl/about", prefetch: () => import("@/pages/xundl/About") },
  { label: "Archive", path: "/xundl/archive", prefetch: () => Promise.all([import("@/pages/xundl/Archive"), fetch("/data/xundl-archivals.json").catch(() => {})]) },
];

export function Sidebar({ isOpen, onClose }: SidebarProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const [chatsExpanded, setChatsExpanded] = useState(true);
  const onEnsdf = location.pathname.startsWith("/ensdf");
  const onXundl = location.pathname.startsWith("/xundl");
  const [ensdfExpanded, setEnsdfExpanded] = useState(onEnsdf);
  const [xundlExpanded, setXundlExpanded] = useState(onXundl);
  const onNsr = location.pathname === "/references" || location.pathname.startsWith("/nsr");
  const [nsrExpanded, setNsrExpanded] = useState(onNsr);
  const onWorkspace = ["/graph", "/tools", "/code", "/community"].some((p) => location.pathname.startsWith(p));
  const [workspaceExpanded, setWorkspaceExpanded] = useState(onWorkspace);
  const { data: sessions, refresh } = useChatSessions();

  // Landing on an ENSDF page from anywhere else opens the group.
  useEffect(() => { if (onEnsdf) setEnsdfExpanded(true); }, [onEnsdf]);
  useEffect(() => { if (onXundl) setXundlExpanded(true); }, [onXundl]);
  useEffect(() => { if (onNsr) setNsrExpanded(true); }, [onNsr]);
  useEffect(() => { if (onWorkspace) setWorkspaceExpanded(true); }, [onWorkspace]);

  // Only close sidebar on mobile (< md breakpoint)
  const closeMobile = () => {
    if (window.innerWidth < 768) onClose?.();
  };

  return (
    <aside
      className={`${
        isOpen ? "w-[281px]" : "w-0"
      } flex-shrink-0 transition-all duration-200 ease-in-out fixed inset-y-0 left-0 z-50 md:relative md:inset-auto ${isOpen ? "overflow-visible" : "overflow-hidden"}`}
    >
      <div className="w-[281px] h-full flex flex-col bg-background">
        {/* Fixed top: title, New Chat / New Search, data sources (a–z), Workspace (a–z) */}
        <div className="shrink-0 px-3 pt-2 space-y-1">
          <h1 className="px-3 pt-1 pb-3 text-[clamp(0.875rem,4.5vw,1.125rem)] font-bold tracking-tight whitespace-nowrap">
            <button
              onClick={() => { navigate("/new-chat"); window.dispatchEvent(new Event("new-chat")); closeMobile(); }}
              className="hover:opacity-80 transition-opacity"
            >
              RxivGPT
            </button>
          </h1>

          <button
            onClick={() => { navigate("/new-chat"); window.dispatchEvent(new Event("new-chat")); closeMobile(); }}
            className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
              location.pathname === "/" || location.pathname === "/new-chat" ? "bg-muted" : "hover:bg-muted"
            }`}
          >
            <SquarePen className="h-4 w-4" />
            New Chat
          </button>
          <button
            onClick={() => { navigate("/search"); closeMobile(); }}
            className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
              location.pathname === "/search" ? "bg-muted" : "hover:bg-muted"
            }`}
          >
            <Search className="h-4 w-4" />
            New Search
          </button>

          {/* ENDF */}
          <button
            onClick={() => { navigate("/endf"); closeMobile(); }}
            onMouseEnter={() => { import("@/pages/Endf"); fetch("/data/endf.json").catch(() => {}); }}
            className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
              location.pathname === "/endf" ? "bg-muted" : "hover:bg-muted"
            }`}
          >
            <FileText className="h-4 w-4" />
            ENDF
          </button>

          <Group
            label="ENSDF"
            icon={<Layers className="h-4 w-4" />}
            active={onEnsdf}
            expanded={ensdfExpanded}
            onToggle={() => setEnsdfExpanded((v) => !v)}
            onOpen={() => { navigate("/ensdf"); closeMobile(); }}
            onHover={() => { import("@/pages/Structure"); fetch(`/data/structure/index.json?v=${STRUCTURE_DATA_V}`).catch(() => {}); }}
            items={ENSDF_ITEMS}
            pathname={location.pathname}
            go={(p) => { navigate(p); closeMobile(); }}
          />

          <Group
            label="NSR"
            icon={<Atom className="h-4 w-4" />}
            active={location.pathname === "/references" || location.pathname.startsWith("/nsr")}
            expanded={nsrExpanded}
            onToggle={() => setNsrExpanded((v) => !v)}
            onOpen={() => { navigate("/nsr"); closeMobile(); }}
            onHover={() => { import("@/pages/References"); }}
            items={NSR_ITEMS}
            pathname={location.pathname}
            go={(p) => { navigate(p); closeMobile(); }}
          />

          <Group
            label="XUNDL"
            icon={<Grid3x3 className="h-4 w-4" />}
            active={onXundl}
            expanded={xundlExpanded}
            onToggle={() => setXundlExpanded((v) => !v)}
            onOpen={() => { navigate("/xundl"); closeMobile(); }}
            onHover={() => { import("@/pages/Structure"); fetch(`/data/structure/index.json?v=${STRUCTURE_DATA_V}`).catch(() => {}); }}
            items={XUNDL_ITEMS}
            pathname={location.pathname}
            go={(p) => { navigate(p); closeMobile(); }}
          />

          {/* Workspace — no landing page yet; the label toggles the group */}
          <Group
            label="Workspace"
            icon={<Share2 className="h-4 w-4" />}
            active={WORKSPACE_ITEMS.some((i) => location.pathname.startsWith(i.path.replace(/\/\d+$/, "")))}
            expanded={workspaceExpanded}
            onToggle={() => setWorkspaceExpanded((v) => !v)}
            onOpen={() => setWorkspaceExpanded((v) => !v)}
            items={WORKSPACE_ITEMS}
            pathname={location.pathname}
            go={(p) => { navigate(p); closeMobile(); }}
          />
        </div>

        {/* Scrolls under the fixed block: Your Chats */}
        <nav className="flex-1 overflow-y-auto px-3 pb-2">
          <div className="pt-4">
            <button
              onClick={() => setChatsExpanded(!chatsExpanded)}
              className="flex w-full items-center justify-between px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
              Your Chats
              <ChevronDown className={`h-4 w-4 transition-transform ${chatsExpanded ? "" : "-rotate-90"}`} />
            </button>

            {chatsExpanded && sessions && sessions.length > 0 && (
              <div className="space-y-0.5">
                {sessions.map((session) => (
                  <ChatSessionItem
                    key={session.id}
                    id={session.id}
                    title={session.title}
                    isActive={location.pathname === `/c/${session.id}`}
                    onNavigate={() => { navigate(`/c/${session.id}`); closeMobile(); }}
                    onRefresh={refresh}
                  />
                ))}
              </div>
            )}

            {chatsExpanded && (!sessions || sessions.length === 0) && (
              <p className="px-3 py-2 text-xs text-muted-foreground">No chats yet</p>
            )}
          </div>
        </nav>

        {/* User menu at bottom */}
        <div className="px-3 py-2">
          <UserMenu />
        </div>
      </div>
    </aside>
  );
}
