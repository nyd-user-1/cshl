/** A chat message as persisted in chat_sessions.messages (Neon, sql/03). */
export interface PersistedMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  pdfUrl?: string;
  sources?: {
    nsr: Array<{ key_number: string; title: string; doi?: string | null; similarity: number }>;
    s2: Array<{ title: string; url: string; authors: string; citations: number }>;
  };
}
