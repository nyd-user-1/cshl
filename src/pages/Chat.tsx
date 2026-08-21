import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams, useNavigate, useParams, useLocation } from "react-router-dom";
import { ChatInput } from "@/components/ChatInput";
import { DetailBody, type EntityType } from "@/components/EntityDetail";
import { Badge } from "@/components/ui/badge";
import { X } from "lucide-react";
import { useChat, type ChatRoom } from "@/hooks/useChat";

// ChatMessage drags in react-markdown + KaTeX (~200 KB gz). A fresh landing
// renders zero messages, so that weight loads only once a conversation exists.
const ChatMessage = lazy(() =>
  import("@/components/ChatMessage").then((m) => ({ default: m.ChatMessage })),
);

/** The visible scope: the user always sees which room they are in. */
function RoomChip({ category }: { category: string }) {
  return (
    <div className="mx-auto mb-2 flex max-w-[720px] justify-center md:justify-start">
      <span className="inline-flex items-center gap-1.5 rounded-full border border-brand/30 bg-brand/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-brand">
        {category}
        <span className="font-normal normal-case tracking-normal text-muted-foreground">· medRxiv room</span>
      </span>
    </div>
  );
}

export default function Chat() {
  const [searchParams] = useSearchParams();
  const { sessionId: routeSessionId, category: routeCategory } = useParams();
  const navigate = useNavigate();
  const location = useLocation();

  // The ROOM. Set by navigation (a card click landed here), never by a widget:
  // /medrxiv/rooms/:category mounts this same page with the scope pre-applied,
  // and the scope rides every request the conversation makes.
  const room: ChatRoom | null = useMemo(
    () =>
      routeCategory && location.pathname.startsWith("/medrxiv/rooms/")
        ? { server: "medrxiv", category: decodeURIComponent(routeCategory).toLowerCase() }
        : null,
    [routeCategory, location.pathname],
  );

  const { messages, isLoading, sendMessage, stopGeneration, clearMessages, loadSession, sessionId } =
    useChat(room);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollPaneRef = useRef<HTMLDivElement>(null);
  const [autoSubmitted, setAutoSubmitted] = useState(false);
  const [entity, setEntity] = useState<{ type: EntityType; id: string } | null>(null);
  const [entityDetail, setEntityDetail] = useState<Record<string, unknown> | null>(null);

  // Inline citations dispatch open-entity; the panel shows the record.
  useEffect(() => {
    function onOpen(e: Event) {
      const d = (e as CustomEvent).detail as { type: EntityType; id: string };
      setEntity(d);
      setEntityDetail(null);
      fetch(`/api/graph?op=node&type=${d.type}&id=${encodeURIComponent(d.id)}`)
        .then((r) => r.json())
        .then(setEntityDetail)
        .catch(() => setEntityDetail({ error: true }));
    }
    window.addEventListener("open-entity", onOpen);
    return () => window.removeEventListener("open-entity", onOpen);
  }, []);
  const loadedSessionRef = useRef<string | null>(null);

  // Auto-scroll on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Late-arriving footer content (the /api/similar follow-ups) grows the
  // transcript after that scroll has already run. Re-pin to the bottom, but
  // only when the reader is still there — never yank someone who has scrolled
  // up to re-read.
  useEffect(() => {
    function onFollowups() {
      const pane = scrollPaneRef.current;
      if (!pane) return;
      const distanceFromBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight;
      if (distanceFromBottom < 240) {
        requestAnimationFrame(() => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }));
      }
    }
    window.addEventListener("followups-rendered", onFollowups);
    return () => window.removeEventListener("followups-rendered", onFollowups);
  }, []);

  // Cmd+Shift+O → new chat
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        clearMessages();
        navigate("/new-chat");
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [clearMessages, navigate]);

  // Load existing session from route param, or clear for new chat
  useEffect(() => {
    if (routeSessionId && routeSessionId !== loadedSessionRef.current) {
      loadedSessionRef.current = routeSessionId;
      loadSession(routeSessionId);
    } else if (!routeSessionId && loadedSessionRef.current) {
      // Navigated to "/" or "/new-chat" from a session — start fresh
      loadedSessionRef.current = null;
      clearMessages();
    }
  }, [routeSessionId, loadSession, clearMessages]);

  // Update URL when session is created (without remounting). Skipped inside a
  // room: rewriting to /c/:id would drop the room from the URL and a refresh
  // would silently land the user on an unscoped chat.
  useEffect(() => {
    if (sessionId && !routeSessionId && !room && messages.length > 0 && !isLoading) {
      window.history.replaceState(null, "", `/c/${sessionId}`);
    }
  }, [sessionId, routeSessionId, room, messages.length, isLoading]);

  // Listen for "new-chat" event from Sidebar (handles replaceState URL mismatch)
  useEffect(() => {
    function handler() {
      loadedSessionRef.current = null;
      setAutoSubmitted(false);
      clearMessages();
    }
    window.addEventListener("new-chat", handler);
    return () => window.removeEventListener("new-chat", handler);
  }, [clearMessages]);

  // Auto-submit from URL params (from reference card click)
  useEffect(() => {
    if (autoSubmitted || routeSessionId) return;

    const prompt = searchParams.get("prompt");
    const context = searchParams.get("context");
    const url = searchParams.get("url");

    if (prompt) {
      setAutoSubmitted(true);

      let systemContext =
        "You are RxivGPT, an AI research assistant for the biomedical and life-science " +
        "preprint literature. You help researchers explore bioRxiv and medRxiv preprints " +
        "from Cold Spring Harbor Laboratory. Preprints have not been peer reviewed — say so " +
        "when it bears on how a finding should be read, and note when a preprint has since " +
        "been published in a journal.";

      if (context) {
        systemContext +=
          "\n\nThe user is asking about a specific preprint. " +
          "Here is the record data:\n" +
          context;
      }

      if (url) {
        systemContext +=
          "\n\nThe paper is available at: " + url +
          "\nReference this DOI link in your response.";
      }

      // Task 1c: structure creates slots, and slots get filled. The old wording
      // here asked for "a thorough analysis of … significance" — an invitation
      // to scaffold sections and fabricate into them. Plain prose, grounded.
      systemContext +=
        "\n\nWrite plain prose paragraphs — no section headings or scaffolding. " +
        "Report what the supplied record and any retrieved full text actually say, " +
        "and when they do not answer something, say so rather than completing plausibly.";

      // Point the PDF viewer at /api/pdf, which resolves the canonical URL and the
      // Google-viewer wrapper. Prefer an explicit ?key= from the caller; fall back to the
      // DOI suffix, which is our business key. Deriving is the fallback rather than the
      // rule because only the caller knows the key for certain — a DOI link could be to
      // the published journal article, whose suffix is not ours.
      const keyParam = searchParams.get("key")?.trim();
      const keyFromDoi = url?.includes("/") ? url.split("/").pop()!.trim() : "";
      const pdfKey = keyParam || keyFromDoi;
      const viewerUrl = pdfKey ? `/api/pdf?key=${encodeURIComponent(pdfKey)}` : url || undefined;

      sendMessage(prompt, systemContext, viewerUrl);
      navigate("/", { replace: true });
    }
  }, [searchParams, autoSubmitted, routeSessionId, sendMessage, navigate]);

  const hasMessages = messages.length > 0;

  return (
    <div className="flex h-full min-h-0">
    <div className="flex h-full min-w-0 flex-1 flex-col">
      {hasMessages ? (
        <>
          {/* Messages — scrollable */}
          <div ref={scrollPaneRef} className="flex-1 overflow-y-auto">
            <div className="mx-auto max-w-[720px] px-2 md:px-4 py-4 md:py-8">
              {messages.map((msg) => (
                <Suspense key={msg.id} fallback={<div className="mb-6 h-16 animate-pulse rounded-lg bg-muted/40" />}>
                <ChatMessage
                  key={msg.id}
                  role={msg.role}
                  content={msg.content}
                  isStreaming={msg.isStreaming}
                  sources={msg.sources}
                  pdfUrl={msg.pdfUrl}
                />
                </Suspense>
              ))}
              <div ref={messagesEndRef} />
            </div>
          </div>

          {/* Input pinned to bottom */}
          <div className="px-2 md:px-4 py-3 md:py-4 shrink-0 bg-background">
            {room && <RoomChip category={room.category} />}
            <ChatInput
              onSubmit={(text, modelId) => sendMessage(text, undefined, undefined, modelId)}
              onStop={stopGeneration}
              isLoading={isLoading}
              searchToggle
              placeholder={room ? `Ask a ${room.category} question…` : undefined}
            />
          </div>
        </>
      ) : (
        /* Empty state — input vertically centered */
        <div className="flex flex-1 flex-col items-center justify-center px-4">
          {room && (
            <div className="mb-3 w-full max-w-[720px] text-center">
              <RoomChip category={room.category} />
              <p className="mt-1 text-xs text-muted-foreground">
                Every question here searches only medRxiv&apos;s {room.category} preprints.
              </p>
            </div>
          )}
          <ChatInput
            onSubmit={(text, modelId) => sendMessage(text, undefined, undefined, modelId)}
            isLoading={isLoading}
            searchToggle
            placeholder={room ? `Ask a ${room.category} question…` : undefined}
          />
        </div>
      )}
    </div>
    {entity && (
      <div className="hidden w-80 shrink-0 overflow-y-auto border-l bg-card p-4 md:block">
        <div className="mb-2 flex items-start justify-between">
          <Badge variant="secondary" className="text-[10px]">{entity.type}</Badge>
          <button onClick={() => setEntity(null)} className="text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
        </div>
        <h2 className="font-mono text-sm font-semibold text-brand">{entity.id}</h2>
        {!entityDetail && <p className="mt-3 text-xs text-muted-foreground">Loading…</p>}
        {entityDetail && !entityDetail.error && (
          <DetailBody type={entity.type} detail={entityDetail} navigate={navigate} />
        )}
        {entityDetail?.error === true && <p className="mt-3 text-xs text-muted-foreground">Not found in the corpus.</p>}
      </div>
    )}
    </div>
  );
}
