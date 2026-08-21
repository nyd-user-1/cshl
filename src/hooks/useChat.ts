import { useState, useCallback, useRef } from "react";
import { useChatPersistence } from "./useChatPersistence";
import type { PersistedMessage } from "@/types/chat";

export interface MessageSources {
  nsr: Array<{
    key_number: string;
    title: string;
    doi?: string | null;
    similarity: number;
  }>;
  s2: Array<{
    title: string;
    url: string;
    authors: string;
    citations: number;
  }>;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  isStreaming?: boolean;
  sources?: MessageSources;
  pdfUrl?: string;
}

function makeId() {
  return Math.random().toString(36).slice(2, 10);
}

function toPersistedMessages(msgs: Message[]): PersistedMessage[] {
  return msgs
    .filter((m) => m.content && !m.isStreaming)
    .map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      timestamp: new Date().toISOString(),
      ...(m.pdfUrl ? { pdfUrl: m.pdfUrl } : {}),
      ...(m.sources ? { sources: m.sources } : {}),
    }));
}

export function useChat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const messagesRef = useRef<Message[]>([]);
  messagesRef.current = messages;
  const persistence = useChatPersistence();

  const sendMessage = useCallback(
    async (userText: string, systemContext?: string, pdfUrl?: string, modelId?: string, useKb?: boolean) => {
      const userMsg: Message = {
        id: makeId(),
        role: "user",
        content: userText,
      };

      const assistantMsg: Message = {
        id: makeId(),
        role: "assistant",
        content: "",
        isStreaming: true,
        ...(pdfUrl ? { pdfUrl } : {}),
      };

      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setIsLoading(true);

      // Create session on first message
      let sessionId = persistence.currentSessionId;
      if (!sessionId) {
        const title = userText.slice(0, 80);
        try {
          sessionId = await persistence.createSession(title, [
            {
              id: userMsg.id,
              role: "user",
              content: userText,
              timestamp: new Date().toISOString(),
            },
          ]);

          // Fire-and-forget feed event
          fetch("/api/feed", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ event_type: "chat_started", category: "chat", display_text: `Started chat: "${title}"`, metadata: { session_id: sessionId } }),
            keepalive: true,
          }).catch(() => {});
        } catch {
          // continue without persistence
        }
      }

      // Build conversation history for the Edge Function
      const historyMessages = messagesRef.current.slice(-10).map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

      try {
        abortRef.current = new AbortController();

        // Lightning toggle: the whole turn goes through the managed pipeline —
        // Bedrock KB retrieval + generation in one non-streaming call. The
        // model picker is deliberately ignored here; the KB generates with the
        // model it is configured for.
        if (useKb) {
          const res = await fetch(`/api/kb-rag?q=${encodeURIComponent(userText)}`, {
            signal: abortRef.current.signal,
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || data.error) throw new Error(data.error || `KB error ${res.status}`);
          const kbSources: MessageSources = {
            nsr: (data.sources ?? []).map(
              (s: { key_number: string; title: string | null; doi: string | null }) => ({
                key_number: s.key_number,
                title: s.title ?? s.key_number,
                doi: s.doi,
                similarity: 0,
              }),
            ),
            s2: [],
          };
          setMessages((prev) => {
            const updated = prev.map((m) =>
              m.id === assistantMsg.id
                ? { ...m, content: data.answer ?? "", isStreaming: false, sources: kbSources }
                : m,
            );
            if (sessionId) persistence.updateMessages(sessionId, toPersistedMessages(updated));
            return updated;
          });
          return;
        }

        const res = await fetch(
          // Our own API route (Neon retrieval + Bedrock generation) — the
          // Supabase edge function is retired.
          `/api/chat`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              messages: historyMessages,
              userMessage: userText,
              systemContext: systemContext || undefined,
              // The picker's choice. Omitted → the function falls back to its
              // own default, so an older client keeps working.
              modelId: modelId || undefined,
            }),
            signal: abortRef.current.signal,
          }
        );

        if (!res.ok) {
          const err = await res.text();
          throw new Error(`Chat error ${res.status}: ${err}`);
        }

        const reader = res.body?.getReader();
        const decoder = new TextDecoder();
        let accumulated = "";
        let parsedSources: MessageSources | undefined;
        let isFirstDataLine = true;

        if (reader) {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split("\n");

            for (const line of lines) {
              if (!line.startsWith("data: ")) continue;
              const data = line.slice(6);
              if (data === "[DONE]") break;

              try {
                const parsed = JSON.parse(data);

                // First data event contains sources metadata
                if (isFirstDataLine && parsed.sources) {
                  isFirstDataLine = false;
                  parsedSources = parsed.sources as MessageSources;
                  continue;
                }
                isFirstDataLine = false;

                // Remaining events are OpenAI streaming deltas
                const delta = parsed.choices?.[0]?.delta?.content;
                if (delta) {
                  accumulated += delta;
                  const current = accumulated;
                  setMessages((prev) =>
                    prev.map((m) =>
                      m.id === assistantMsg.id
                        ? { ...m, content: current, isStreaming: true }
                        : m
                    )
                  );
                }
              } catch {
                // skip malformed chunks
              }
            }
          }
        }

        // Mark streaming complete
        const finalContent = accumulated;
        const finalSources = parsedSources;
        setMessages((prev) => {
          const updated = prev.map((m) =>
            m.id === assistantMsg.id
              ? {
                  ...m,
                  content: finalContent,
                  isStreaming: false,
                  sources: finalSources,
                }
              : m
          );

          // Persist completed messages
          if (sessionId) {
            persistence.updateMessages(sessionId, toPersistedMessages(updated));
          }

          return updated;
        });
      } catch (err: any) {
        if (err.name === "AbortError") return;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsg.id
              ? {
                  ...m,
                  content: `Error: ${err.message}`,
                  isStreaming: false,
                }
              : m
          )
        );
      } finally {
        setIsLoading(false);
        abortRef.current = null;
      }
    },
    [persistence]
  );

  const loadSession = useCallback(
    async (sessionId: string) => {
      const session = await persistence.loadSession(sessionId);
      if (session) {
        persistence.setCurrentSessionId(session.id);
        setMessages(
          session.messages.map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            ...(m.pdfUrl ? { pdfUrl: m.pdfUrl } : {}),
            ...(m.sources ? { sources: m.sources as MessageSources } : {}),
          }))
        );
        return session;
      }
      return null;
    },
    [persistence]
  );

  const stopGeneration = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setIsLoading(false);
    // Mark any streaming messages as complete
    setMessages((prev) =>
      prev.map((m) => (m.isStreaming ? { ...m, isStreaming: false } : m))
    );
  }, []);

  const clearMessages = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setMessages([]);
    setIsLoading(false);
    persistence.setCurrentSessionId(null);
  }, [persistence]);

  return {
    messages,
    isLoading,
    sendMessage,
    stopGeneration,
    clearMessages,
    loadSession,
    sessionId: persistence.currentSessionId,
  };
}
