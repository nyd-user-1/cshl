import { useState, useRef, useEffect } from "react";
import { ArrowUp, Square, ChevronDown, Search } from "lucide-react";
import { PlusMenu } from "@/components/PlusMenu";
import { useNavigate } from "react-router-dom";import { MODEL_OPTIONS, DEFAULT_MODEL_ID, modelById } from "@/lib/models";

/* ------------------------------------------------------------------ */
/*  Model selector — the roster lives in src/lib/models.ts             */
/* ------------------------------------------------------------------ */
/*  Every id there was verified callable against this AWS account, and
 *  the SELECTION IS REAL now: it rides the request body to the chat
 *  edge function, which passes it to Bedrock. It used to be decorative
 *  ("visual only — we always use GPT-4o"), so picking Claude changed
 *  the label and nothing else.                                        */

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

interface ChatInputProps {
  /** The chosen Bedrock model id rides along — see src/lib/models.ts. */
  onSubmit: (message: string, modelId: string) => void;
  onStop?: () => void;
  isLoading?: boolean;
  initialValue?: string;
  /** Show the magnifier next to "+" — switches to search mode (/search). Only the /chat page sets this. */
  searchToggle?: boolean;
  /** Subject-scoped chats name their room here ("Ask a neurology question…"). */
  placeholder?: string;
}

export function ChatInput({ onSubmit, onStop, isLoading, initialValue, searchToggle, placeholder }: ChatInputProps) {
  const navigate = useNavigate();
  const [value, setValue] = useState(initialValue ?? "");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Model selector state
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelMenuAbove, setModelMenuAbove] = useState(true);
  const [selectedModel, setSelectedModel] = useState(DEFAULT_MODEL_ID);
  const modelRef = useRef<HTMLDivElement>(null);
  const modelBtnRef = useRef<HTMLButtonElement>(null);

  // ---- textarea auto-resize ----
  useEffect(() => {
    if (initialValue) setValue(initialValue);
  }, [initialValue]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      const maxHeight = 144;
      textareaRef.current.style.height =
        Math.min(textareaRef.current.scrollHeight, maxHeight) + "px";
      textareaRef.current.style.overflowY =
        textareaRef.current.scrollHeight > maxHeight ? "auto" : "hidden";
    }
  }, [value]);

  // ---- close model menu on outside click ----
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (modelRef.current && !modelRef.current.contains(e.target as Node)) {
        setModelMenuOpen(false);
      }
    }
    if (modelMenuOpen) document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [modelMenuOpen]);

  // ---- helpers ----
  const handleSubmit = () => {
    const trimmed = value.trim();
    if (!trimmed || isLoading) return;
    onSubmit(trimmed, selectedModel);
    setValue("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleSelectPrompt = (prompt: string) => {
    setValue(prompt);
    textareaRef.current?.focus();
  };

  return (
    <div className="max-w-[720px] mx-auto w-full">
      <div className="rounded-2xl bg-secondary border border-border p-3 shadow-lg">
        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder ?? "Chat with RxivGPT"}
          rows={1}
          className="flex-1 min-h-[40px] w-full resize-none border-0 bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0 p-0 placeholder:text-muted-foreground/60 text-base text-foreground outline-none"
        />

        {/* Bottom row: + button, model label, send button */}
        <div className="flex items-center justify-between pt-1">
          {/* + button with popup, and (on /chat) the search-mode toggle */}
          <div className="flex items-center gap-1">
            <PlusMenu mode="chat" onSelect={handleSelectPrompt} />
            {searchToggle && (
              <button
                type="button"
                onClick={() => navigate("/search")}
                className="h-8 w-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                aria-label="Search mode"
                title="Search mode"
              >
                <Search className="h-4 w-4" />
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            {/* Model selector */}
            <div className="relative" ref={modelRef}>
              <button
                ref={modelBtnRef}
                type="button"
                onClick={() => {
                  if (!modelMenuOpen && modelBtnRef.current) {
                    const rect = modelBtnRef.current.getBoundingClientRect();
                    setModelMenuAbove(rect.top > 350);
                  }
                  setModelMenuOpen(!modelMenuOpen);
                }}
                className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors rounded-lg px-2 py-1"
              >
                <img src={modelById(selectedModel).logo} alt="" width={16} height={16} className="rounded-sm" />
                <span className="font-medium">{modelById(selectedModel).label}</span>
                <ChevronDown className={`h-3 w-3 transition-transform ${modelMenuOpen ? "rotate-180" : ""}`} />
              </button>

              {modelMenuOpen && (
                <div className={`absolute right-0 w-[calc(100vw-2rem)] md:w-[260px] rounded-xl border bg-background shadow-xl animate-in fade-in duration-150 overflow-y-auto max-h-[min(60vh,420px)] py-1 ${
                  modelMenuAbove ? "bottom-full mb-2 slide-in-from-bottom-2" : "top-full mt-2 slide-in-from-top-2"
                }`}>
                  {MODEL_OPTIONS.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => {
                        setSelectedModel(m.id);
                        setModelMenuOpen(false);
                      }}
                      className="flex w-full items-center gap-3 px-4 py-3 text-sm hover:bg-muted transition-colors"
                    >
                      <img src={m.logo} alt="" width={16} height={16} className="shrink-0 rounded-sm" />
                      <div className="flex-1 text-left">
                        <span className="font-medium text-foreground">{m.label}</span>
                        <span className="block text-xs text-muted-foreground">{m.description}</span>
                      </div>
                      {m.id === selectedModel && (
                        <svg className="h-4 w-4 shrink-0 text-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Send / Stop button */}
            <button
              type="button"
              onClick={isLoading ? onStop : handleSubmit}
              disabled={!isLoading && !value.trim()}
              className={`h-10 w-10 rounded-xl flex items-center justify-center transition-colors cursor-pointer ${
                isLoading
                  ? "bg-destructive hover:bg-destructive/90 text-white"
                  : "bg-foreground hover:bg-foreground/85 text-background"
              }`}
            >
              {isLoading ? (
                <Square className="h-4 w-4" fill="currentColor" />
              ) : (
                <ArrowUp className="h-4 w-4" />
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
