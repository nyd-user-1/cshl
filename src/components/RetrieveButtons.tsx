/**
 * NNDC's "Retrieve selected ENSDF datasets" set, served from our own parsed
 * distributions: PDF Version opens a typeset printable view, ENSDF text format
 * the raw 80-column card decks, plus Markdown and llms.txt renderings.
 * `pairs` are "<NUCID>|<DSID>" keys in table order. Styled as the /endf–/nsr
 * filter-bar pills, in the TableCard toolbar right of the filter box.
 */
export function RetrieveButtons({ pairs, src = "ensdf" }: { pairs: string[]; src?: "ensdf" | "xundl" }) {
  const open = (extra: string) => {
    const qs = pairs.slice(0, 60).map((p) => `ds=${encodeURIComponent(p)}`).join("&");
    window.open(`/api/nuclide?text=1${extra}${src === "xundl" ? "&src=xundl" : ""}&${qs}`, "_blank", "noopener");
  };
  const none = pairs.length === 0;
  const title = none ? "Select datasets first" : `${pairs.length} selected`;
  // PDF = typeset print view · ENSDF = raw card decks · MD = Markdown · LLMS = llms.txt
  const items: [string, string][] = [
    ["PDF", "&print=1"],
    ["ENSDF", "&fmt=view"],
    ["MD", "&fmt=md"],
    ["LLMS", "&fmt=llms"],
  ];
  return (
    <div className="flex flex-wrap items-center gap-1">
      {items.map(([label, extra]) => (
        <button
          key={label}
          type="button"
          disabled={none}
          title={title}
          onClick={() => open(extra)}
          className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
        >
          {label}
        </button>
      ))}
    </div>
  );
}
