/**
 * Structure and Decay Data Retrieval — help page, transcribed from NNDC's
 * help page (data/ensdf-help.html) into titled sections.
 */

interface Section {
  id: string;
  title: string;
  body: React.ReactNode;
}

const P = "text-sm leading-relaxed text-muted-foreground";

const SECTIONS: Section[] = [
  {
    id: "general",
    title: "General information",
    body: (
      <>
        <p className={P}>
          This site can be used to retrieve evaluated and/or compiled nuclear structure datasets from
          the NNDC databases. Several options are available for selecting datasets. Data may be
          retrieved based on nuclide, charge, or mass, or by indexed reaction and decay quantities.
        </p>
        <p className={`mt-3 ${P}`}>
          Once a set of datasets matching specified criteria is found, the nuclide and dataset ID
          string will be listed, along with several retrieval options. The options can apply to
          selected datasets, or to all datasets from a given database. Individual datasets can be
          selected using provided checkboxes. <span className="italic">Note:</span> if a very large
          number of datasets are listed, the "get all datasets" option will not appear. In this case
          the user should use the checkboxes to select particular datasets of interest.
        </p>
        <p className={`mt-3 ${P}`}>
          The first dataset retrieval option is a formatted HTML page containing tables and comments
          for the dataset. This page will also provide links for the display of level schemes in
          graphical format. The second option is to download the ENSDF-formatted file. If your browser
          has a plug-in for type "application/ensdf" (i.e., Isotope Explorer), it will recognize the
          data in this format. The third choice displays the ENSDF file in plain text form in the
          browser.
        </p>
        <p className={`mt-3 ${P}`}>
          In addition, for each dataset there is an option to retrieve a list of references quoted in
          the dataset.
        </p>
        <p className={`mt-3 ${P}`}>
          For many of the search options, you will be asked to specify which "types" of dataset you
          want to retrieve. There are five types of dataset in the database: Comments, Reference,
          Adopted, Decay, and Reaction. The first three apply only to evaluated data. Adopted data
          contains the "recommended" values for nuclear structure quantities, as established by the
          evaluator. Reaction and Decay datasets contain data associated with specific reaction and
          decay measurements. Note that Adopted, Reaction, and Decay datasets are always associated
          with a specific nuclide, while Comment and Reference datasets are usually associated with an
          entire mass chain.
        </p>
      </>
    ),
  },
  {
    id: "browse",
    title: "Browse",
    body: <p className={P}>This page can be used to browse the datasets by charge or mass.</p>,
  },
  {
    id: "nuclide",
    title: "Nuclide search",
    body: (
      <>
        <p className={P}>
          This form can be used to find datasets for a particular nuclide, or for all nuclides with a
          given mass or atomic number. Z can be entered as an element symbol or as a numeric value,
          and A should be entered as a numeric value. Nuclides should be entered in the form "AAAZZ"
          or "ZZ-AAA" (i.e. 44TI or TI-44). Retrievals are not case-sensitive (TI=ti=Ti). The
          exception to this is "n" vs. "N". In this case, "n" refers to neutron, whereas "N" refers to
          nitrogen.
        </p>
        <p className={`mt-3 ${P}`}>
          For nuclides with Z&gt;111, use the number (Z−100) as the element symbol in nuclide
          retrievals. For instance, for Z=112, A=281, the nuclide can be entered as "28112" or
          "12-281".
        </p>
      </>
    ),
  },
  {
    id: "decay",
    title: "Decay search",
    body: (
      <p className={P}>
        This form can be used to select decay datasets based on decay-related quantities. The Z- and
        A-range inputs can be used to restrict the area of interest on the chart of nuclides. The
        "parent" input can be used to specify the decay parent. Finally, the specific type of decay
        can be chosen from the drop-down list.
      </p>
    ),
  },
  {
    id: "reaction",
    title: "Reaction search",
    body: (
      <p className={P}>
        This form can be used to select reaction datasets based on reaction-related quantities. The Z-
        and A-range inputs can be used to restrict the area of interest on the chart of nuclides. A
        reaction can be specified — it should be entered as it appears in the dataset ID string
        (though parentheses are optional). Target and residual nuclides can be specified (in some
        cases, the residual may be different than the nuclide being studied). Incident and outgoing
        particles can be specified (A = alpha, P = proton, etc.). Finally, a specific reaction-related
        "subject", such as "stripping" or "Coulomb excitation", can be specified.
      </p>
    ),
  },
  {
    id: "recent",
    title: "Recent additions",
    body: (
      <p className={P}>
        This page can be used to retrieve all datasets which have been added or modified since the
        specified date. Dates up to one year before the present can be specified.
      </p>
    ),
  },
  {
    id: "indices",
    title: "Database indices",
    body: (
      <p className={P}>
        The ENSDF and XUNDL indices provide information on the contents of the respective databases.
        For ENSDF, literature cut-off dates and publication information are given.
      </p>
    ),
  },
];

export default function Help() {
  const jump = (id: string) =>
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 md:px-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-primary">Dataset retrieval — help</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Evaluated and compiled nuclear structure data: how the NNDC retrieval forms work.
        </p>
      </div>

      <div className="flex flex-col gap-6 md:flex-row">
        {/* Mini TOC — sticky alongside the content on md+ */}
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
        </div>
      </div>
    </div>
  );
}
