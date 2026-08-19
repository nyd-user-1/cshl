import { ExternalLink } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

/**
 * About XUNDL — transcribed from NNDC's page (nndc.bnl.gov/ensdf/xundl/about.jsp),
 * in the same shape as /ensdf/about: stat chips, then an "On this page" rail
 * beside plain sections.
 */

const STATS = [
  { label: "Compiling since", value: "1998" },
  { label: "Coordinator / editor", value: "E.A. McCutchan" },
  { label: "Format", value: "ENSDF card decks" },
];

const P = "text-sm leading-relaxed text-muted-foreground";

const SECTIONS: { id: string; title: string; body: React.ReactNode }[] = [
  {
    id: "origins",
    title: "Origins",
    body: (
      <>
        <p className={P}>
          In response to recommendations of a DOE review panel, circa 1996, the compilation (in ENSDF
          format) of recently published experimental nuclear structure articles was started in 1998 by
          Dr. Balraj Singh at McMaster University, Canada, a participating center in the USNDP network.
          In the same year, the XUNDL database and its web interface were developed and set up at the
          NNDC, BNL by Dr. David Winchell.
        </p>
        <p className={`mt-3 ${P}`}>
          In general, the information in a given XUNDL dataset comes from a single journal article, or
          from a set of closely related articles from the same experimental group. Supplemental
          material sent by researchers in support of their published papers is also compiled and
          archived. Active and timely communication between data compilers and original authors of
          publications is encouraged; such interactions have been a major factor in the successful
          functioning of this database.
        </p>
      </>
    ),
  },
  {
    id: "compilers",
    title: "Who compiles it",
    body: (
      <>
        <p className={P}>
          Datasets are added to the XUNDL database on a regular basis as new results are published.
          Until 2008, all compilations were carried out at McMaster University by Balraj Singh and his
          undergraduate students, while the database was managed at the NNDC, BNL by Dr. David
          Winchell. Since then, Dr. Filip Kondev at Argonne National Laboratory, and Dr. John Kelley
          and Ms. Grace Sheu at the Triangle Universities Nuclear Laboratory have also been contributing
          to XUNDL, while the database at the NNDC, BNL has been maintained by Dr. Jagdish Tuli. Since
          2013, several other USNDP data centers have joined this effort.
        </p>
        <p className={`mt-3 ${P}`}>
          All contributed datasets are reviewed and edited (if needed) by the XUNDL coordinator and
          editor, E.A. McCutchan (
          <a href="mailto:mccutchan@bnl.gov" className="text-nuclear hover:underline">mccutchan@bnl.gov</a>
          ).
        </p>
      </>
    ),
  },
  {
    id: "sources",
    title: "What it covers",
    body: (
      <>
        <p className={P}>
          Compilers continuously monitor journals pertinent to nuclear data and compile new
          experimental measurements into XUNDL to ensure the available data are as up-to-date as
          possible. XUNDL includes new results from Physical Review C, Physical Review Letters,
          Nuclear Physics A, European Physical Journal A, Physics Letters B, Journal of Physics G, and
          many more.
        </p>
      </>
    ),
  },
];

export default function XundlAbout() {
  const jump = (id: string) =>
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 md:px-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-primary">Experimental Unevaluated Nuclear Data List</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          What XUNDL is, who compiles it, and where its data come from.
        </p>
      </div>

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        {STATS.map((s) => (
          <Card key={s.label}><CardContent className="p-3">
            <p className="text-xs text-muted-foreground">{s.label}</p>
            <p className="mt-0.5 text-sm font-medium text-foreground">{s.value}</p>
          </CardContent></Card>
        ))}
      </div>

      <div className="flex flex-col gap-6 md:flex-row">
        <nav className="md:sticky md:top-2 md:h-fit md:w-52 md:flex-shrink-0">
          <p className="mb-2 text-[10px] uppercase tracking-wide text-muted-foreground">On this page</p>
          <div className="space-y-0.5">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                onClick={() => jump(s.id)}
                className="flex w-full items-center rounded-lg px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                {s.title}
              </button>
            ))}
          </div>
        </nav>

        <div className="min-w-0 flex-1 space-y-8">
          {SECTIONS.map((s) => (
            <section key={s.id} id={s.id} className="scroll-mt-4">
              <h2 className="mb-2 text-sm font-bold text-foreground">{s.title}</h2>
              {s.body}
            </section>
          ))}
          <a
            href="https://www.nndc.bnl.gov/ensdf/xundl/about.jsp"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-nuclear hover:underline"
          >
            <ExternalLink className="h-3 w-3" /> nndc.bnl.gov/ensdf/xundl/about.jsp
          </a>
        </div>
      </div>
    </div>
  );
}
