import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { GitHubMark } from "@/components/icons/GitHubMark";

/** The IAEA NSDD network's public code repositories (public/data/nsdd-repos.json). */
interface Repo {
  name: string;
  description: string | null;
  html_url: string;
  language: string | null;
  updated_at: string;
}

const LEGACY_PREFIX = /^LEGACY CODE\.?\s*/i;

/** Section membership follows the IAEA NSDD repository page; the rest is legacy. */
const ANALYSIS = [
  "AlphaHF", "BetaShape", "BrIcc", "BrIccMixing", "GABS",
  "JGAMUT", "Java-RULER", "RadiationReport", "GLSC", "EvaluationToolkit",
];
const UTILITY = [
  "AME-NUBASE-viewer", "AVETOOLS", "KeynumberCheck", "ConsistencyCheck",
  "FormatCheck", "McMaster-MSU-Java-NDS", "V.AveLib", "Excel2ENSDF",
];

/** Descriptions the GitHub repo leaves empty, taken from the IAEA page. */
const DESCRIPTIONS: Record<string, string> = {
  ConsistencyCheck:
    "Check data consistency among ENSDF datasets, group levels and gammas, and average values from different datasets.",
  FormatCheck: "Java code for ENSDF format and syntax checking.",
};

function RepoCard({ repo }: { repo: Repo }) {
  const name = repo.name.trim();
  const description = (repo.description ?? "").replace(LEGACY_PREFIX, "").trim() || DESCRIPTIONS[name] || "";
  return (
    <a
      href={repo.html_url}
      target="_blank"
      rel="noopener noreferrer"
      className="group relative flex flex-col rounded-lg border border-border/40 bg-muted/40 p-4 transition-all hover:border-border hover:shadow-lg"
    >
      {/* GitHub mark — every card here is a repository */}
      <GitHubMark className="absolute right-3 top-3 h-4 w-4 text-muted-foreground transition-colors group-hover:text-foreground" />
      <span className="pr-6 text-sm font-bold text-foreground">{name}</span>
      <p className="mt-6 text-xs leading-relaxed text-muted-foreground">{description}</p>
    </a>
  );
}

function Section({ heading, repos }: { heading: string; repos: Repo[] }) {
  if (repos.length === 0) return null;
  return (
    <div className="mb-6">
      <h2 className="mb-3 text-sm font-semibold text-foreground">{heading}</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        {repos.map((r) => <RepoCard key={r.name} repo={r} />)}
      </div>
    </div>
  );
}

export default function CodePage() {
  const { data, isLoading } = useQuery({
    queryKey: ["nsdd-repos"],
    queryFn: async (): Promise<Repo[]> => {
      const res = await fetch("/data/nsdd-repos.json");
      if (!res.ok) throw new Error(`nsdd-repos.json: ${res.status}`);
      return res.json();
    },
    staleTime: Infinity,
  });

  const sections = useMemo(() => {
    const repos = data ?? [];
    const pick = (names: string[]) =>
      names.map((n) => repos.find((r) => r.name.trim() === n)).filter((r): r is Repo => !!r);
    const analysis = pick(ANALYSIS);
    const utility = pick(UTILITY);
    const claimed = new Set([...analysis, ...utility].map((r) => r.name));
    return { analysis, utility, legacy: repos.filter((r) => !claimed.has(r.name)) };
  }, [data]);

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 md:px-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-primary">ENSDF Codes</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Analysis and utility codes used to produce and check ENSDF evaluations. Maintained by the
          IAEA NSDD network —{" "}
          <a
            href="https://github.com/IAEA-NSDDNetwork"
            target="_blank"
            rel="noopener noreferrer"
            className="text-nuclear hover:underline"
          >
            github.com/IAEA-NSDDNetwork
          </a>
        </p>
      </div>

      {isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {[...Array(9)].map((_, i) => <Skeleton key={i} className="h-24 w-full" />)}
        </div>
      ) : (
        <>
          <Section heading="Analysis codes" repos={sections.analysis} />
          <Section heading="Utility codes" repos={sections.utility} />
          <Section heading="Legacy codes" repos={sections.legacy} />
        </>
      )}
    </div>
  );
}
