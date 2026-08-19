import { memo, useState, type ReactNode } from "react";
import { useNavigate, Link } from "react-router-dom";
import { Hash, Copy, Check, ArrowUp, ExternalLink } from "lucide-react";
import { useFeedEmitter } from "@/hooks/useFeedEmitter";

/**
 * One ENSDF / XUNDL dataset as an index card — a structural twin of
 * EndfReportCard (same frame, same rows, same hover circles), so /ensdf and
 * /xundl read exactly like /endf and /nsr.
 */
export interface DatasetRow {
  nucid: string;
  a: number | null;
  dsid: string;
  revised: string | null;
  refs: number;
}

interface DatasetCardProps {
  d: DatasetRow;
  variant: "ensdf" | "xundl";
  searchQuery?: string;
}

/** "148GD" → "148Gd"; chain-level "148" stays "148". */
const nucLabel = (nucid: string) =>
  nucid.replace(/^(\d+)([A-Z])([A-Z]?)$/, (_m, a, b, c) => `${a}${b}${c.toLowerCase()}`);

function highlightText(text: string, query: string): ReactNode {
  if (!query) return text;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`(${escaped})`, "gi");
  const parts = text.split(regex);
  return parts.map((part, i) =>
    regex.test(part) ? (
      <mark key={i} className="bg-nuclear/20 text-foreground rounded-sm px-0.5">
        {part}
      </mark>
    ) : (
      part
    )
  );
}

export const DatasetCard = memo(function DatasetCard({ d, variant, searchQuery }: DatasetCardProps) {
  const navigate = useNavigate();
  const [copied, setCopied] = useState(false);
  const { emit } = useFeedEmitter();

  const label = nucLabel(d.nucid);
  const chainLevel = !/[A-Za-z]/.test(label);
  const name = variant.toUpperCase();
  const pagePath = chainLevel ? `/${variant}/${d.a}` : `/${variant}/${label}`;
  const refsPath = `${pagePath}/refs?dsid=${encodeURIComponent(d.dsid)}`;

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    const text = [
      d.dsid,
      chainLevel ? `A=${d.a}` : label,
      d.revised ? `Last revised ${d.revised}` : "",
      `${name} · ${d.refs} reference${d.refs === 1 ? "" : "s"}`,
    ]
      .filter(Boolean)
      .join("\n");
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleSendToChat = (e: React.MouseEvent) => {
    e.stopPropagation();

    const prompt = `Tell me about the ${name} dataset "${d.dsid}" for ${chainLevel ? `A=${d.a}` : label}. What does it contain and what is its significance?`;

    const context = [
      `Source: ${name}`,
      `Dataset: ${d.dsid}`,
      `Nuclide: ${chainLevel ? `A=${d.a}` : label}`,
      d.revised ? `Last revised: ${d.revised}` : null,
      `NSR references cited: ${d.refs}`,
    ]
      .filter(Boolean)
      .join("\n");

    navigate(`/?${new URLSearchParams({ prompt, context }).toString()}`);

    emit({
      event_type: "record_inquiry",
      category: "chat",
      entity_type: `${variant}_dataset`,
      entity_value: `${d.nucid}|${d.dsid}`,
      display_text: `Inquired about ${label} ${d.dsid}`,
      metadata: { source: variant },
    });
  };

  return (
    <div
      onTouchStart={() => {}}
      onClick={() => navigate(pagePath)}
      className="group relative cursor-pointer rounded-lg border border-border/40 bg-muted/40 p-4 pb-14 md:p-6 md:pb-16 min-h-[240px] md:min-h-[280px] transition-all hover:shadow-lg hover:border-border active:shadow-lg active:border-border"
    >
      {/* Top row: # icon + nuclide + revised date */}
      <div className="flex items-center gap-2 mb-3">
        <Hash className="h-5 w-5 text-muted-foreground" />
        <span className="text-base font-bold">
          {chainLevel ? `A=${d.a}` : searchQuery ? highlightText(label, searchQuery) : label}
        </span>
        {d.revised && (
          <span className="ml-auto text-sm font-medium text-muted-foreground">{d.revised}</span>
        )}
      </div>

      {/* Title: the dataset id */}
      <p className="text-sm text-foreground leading-snug mb-3 line-clamp-2">
        {searchQuery ? highlightText(d.dsid, searchQuery) : d.dsid}
      </p>

      {/* Metadata grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-2 text-xs">
        <div className="min-w-0">
          <span className="text-muted-foreground">Nuclide</span>
          <p className="font-medium truncate">{chainLevel ? `Mass chain ${d.a}` : label}</p>
        </div>
        <div className="min-w-0">
          <span className="text-muted-foreground">Last Revised</span>
          <p className="font-medium truncate">{d.revised ?? "—"}</p>
        </div>
        <div className="min-w-0">
          <span className="text-muted-foreground">{name} Dataset</span>
          <p className="font-medium truncate">{d.dsid}</p>
        </div>
      </div>

      {/* Bottom bar: references link left, action buttons right */}
      <div className="absolute bottom-3 left-4 md:bottom-4 md:left-6 right-4 flex items-center justify-between">
        {d.refs > 0 ? (
          <Link
            to={refsPath}
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center gap-1 text-xs text-nuclear hover:underline truncate max-w-[60%]"
          >
            <ExternalLink className="h-3 w-3 flex-shrink-0" />
            {d.refs} reference{d.refs === 1 ? "" : "s"}
          </Link>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={handleCopy}
            className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-foreground shadow-lg transition-all hover:scale-110"
            title="Copy dataset details"
          >
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          </button>
          <button
            onClick={handleSendToChat}
            className="flex h-10 w-10 items-center justify-center rounded-full bg-foreground text-background shadow-lg transition-all hover:scale-110"
            title="Ask RxivGPT about this dataset"
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
});
