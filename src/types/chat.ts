/** A chat message as persisted in chat_sessions.messages (Neon, sql/03). */
export interface PersistedMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  pdfUrl?: string;
  sources?: {
    // `nsr` is the NSR-era wire key for corpus records. It is persisted inside
    // saved chat sessions, so renaming it orphans every stored session's source
    // chips — keep the key, treat it as "records from our corpus".
    nsr: Array<{ key_number: string; title: string; doi?: string | null; similarity: number }>;
    s2: Array<{ title: string; url: string; authors: string; citations: number }>;
  };
}
