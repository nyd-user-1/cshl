import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams, useNavigate, useParams } from "react-router-dom";
import { ChatInput } from "@/components/ChatInput";
import { DetailBody, type EntityType } from "@/components/EntityDetail";
import { Badge } from "@/components/ui/badge";
import { X } from "lucide-react";
import { useChat } from "@/hooks/useChat";

// ChatMessage drags in react-markdown + KaTeX (~200 KB gz). A fresh landing
// renders zero messages, so that weight loads only once a conversation exists.
const ChatMessage = lazy(() =>
  import("@/components/ChatMessage").then((m) => ({ default: m.ChatMessage })),
);

export default function Chat() {
  const [searchParams] = useSearchParams();
  const { sessionId: routeSessionId } = useParams();
  const navigate = useNavigate();
  const { messages, isLoading, sendMessage, stopGeneration, clearMessages, loadSession, sessionId } =
    useChat();
  const messagesEndRef = useRef<HTMLDivElement>(null);
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

  // Update URL when session is created (without remounting)
  useEffect(() => {
    if (sessionId && !routeSessionId && messages.length > 0 && !isLoading) {
      window.history.replaceState(null, "", `/c/${sessionId}`);
    }
  }, [sessionId, routeSessionId, messages.length, isLoading]);

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
          "\n\nThe paper is available at: " +
          url +
          "\nPlease reference this DOI link in your response and provide a thorough " +
          "analysis of the paper's content, methodology, and significance.";
      }

      systemContext +=
        "\n\nProvide a detailed, expert-level analysis. Explain the significance of the " +
        "research and its methodology, and highlight connections to related work in the field.";

      // The inline PDF viewer must be pointed at our own /api/pdf proxy, not the DOI link.
      // bioRxiv and medRxiv send `x-frame-options: SAMEORIGIN` on their PDFs, so framing
      // their URL directly yields a blank panel with no error. The key is the DOI suffix,
      // which is our business key, so it derives from the DOI without touching the caller.
      const keyFromDoi = url?.includes("/") ? url.split("/").pop()!.trim() : "";
      const viewerUrl = keyFromDoi
        ? `/api/pdf?key=${encodeURIComponent(keyFromDoi)}`
        : url || undefined;

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
          <div className="flex-1 overflow-y-auto">
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
            <ChatInput
              onSubmit={(text, modelId) => sendMessage(text, undefined, undefined, modelId)}
              onStop={stopGeneration}
              isLoading={isLoading}
              searchToggle
            />
          </div>
        </>
      ) : (
        /* Empty state — input vertically centered */
        <div className="flex flex-1 flex-col items-center justify-center px-4">
          <ChatInput
            onSubmit={(text, modelId) => sendMessage(text, undefined, undefined, modelId)}
            isLoading={isLoading}
            searchToggle
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
        <h2 className="font-mono text-sm font-semibold text-nuclear">{entity.id}</h2>
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
