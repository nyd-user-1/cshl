import katex from "katex";
import "katex/dist/katex.min.css";
import { Copy, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { TexText } from "@/components/TexText";

/**
 * NDS General Policies — transcribed from data/NDSPolicies.pdf (pages i–vi):
 * presentation of data, the theory the evaluators lean on, and the summary of
 * bases for spin and parity assignments. Display math is re-typeset in KaTeX.
 */

const PDF_URL = "https://www.nndc.bnl.gov/nds/docs/NDSPolicies.pdf";

/** Display math lives in a card — the one place cards belong on this page. */
function MathBlock({ tex }: { tex: string }) {
  const copy = () => {
    navigator.clipboard.writeText(tex).then(
      () => toast.success("LaTeX copied"),
      () => toast.error("Couldn't copy"),
    );
  };
  return (
    <div className="group relative my-4 rounded-lg border border-border/40 bg-muted/40 p-4 shadow-sm">
      <button
        type="button"
        onClick={copy}
        title="Copy LaTeX"
        className="absolute right-3 top-3 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
      >
        <Copy className="h-3.5 w-3.5" />
      </button>
      <div
        className="overflow-x-auto text-foreground"
        dangerouslySetInnerHTML={{
          __html: katex.renderToString(tex, { displayMode: true, throwOnError: false }),
        }}
      />
    </div>
  );
}

const TOC = [
  { id: "presentation", title: "General Policies — Presentation of Data" },
  { id: "theory", title: "Theory" },
  { id: "spin-parity", title: "Summary of Bases for Spin and Parity Assignments" },
];
const idFor = (title: string) => TOC.find((t) => t.title === title)?.id ?? title.toLowerCase().replace(/[^a-z0-9]+/g, "-");

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section id={idFor(title)} className="mb-8 scroll-mt-4">
      <h2 className="mb-3 text-base font-semibold text-primary">{title}</h2>
      {children}
    </section>
  );
}

function Sub({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-2 mt-4 text-sm font-semibold text-foreground first:mt-0">{children}</h3>;
}

function Para({ children }: { children: React.ReactNode }) {
  return <p className="mb-3 text-sm leading-relaxed text-muted-foreground">{children}</p>;
}

/** A paragraph of source prose that may carry inline TeX. */
function Text({ t }: { t: string }) {
  return <p className="mb-3 text-sm leading-relaxed text-muted-foreground"><TexText text={t} /></p>;
}

interface Prop {
  n: string;
  text: string;
  sub?: string[];
}

function PropList({ items }: { items: Prop[] }) {
  return (
    <ol className="mb-3 space-y-2">
      {items.map((p) => (
        <li key={p.n} className="flex gap-2 text-sm leading-relaxed text-muted-foreground">
          <span className="w-7 flex-shrink-0 font-mono text-xs text-nuclear">{p.n}</span>
          <span className="min-w-0">
            <TexText text={p.text} />
            {p.sub && (
              <span className="mt-1 block space-y-1 pl-4">
                {p.sub.map((s) => <span key={s} className="block"><TexText text={s} /></span>)}
              </span>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}

/* ------------------------------------------------------------------ */
/*  Content                                                            */
/* ------------------------------------------------------------------ */

const GENERAL: Prop[] = [
  { n: "1.", text: "The excitation energies of levels connected by γ transitions are from a least-squares fit to the adopted γ energies." },
  { n: "2.", text: "Dominant decay branches (i.e., for the decay of ground states and isomeric states) are rounded off to 100 when the competing branches total less than approximately 0.001%. When only one branch has been observed and no estimate can be made for expected competing branches, the observed branch is given as ≤100 and the competing branch(es) as \"%branching=?\"." },
  { n: "3.", text: "Total internal-conversion coefficients (α) for each transition are theoretical values corresponding to the listed radiation character (i.e., multipolarity) and mixing ratio (δ). For a transition of mixed character (two or more multipolarities) and unknown mixing ratio, α is the average of the possible extremes and the uncertainty overlaps the full range of values. In all calculations by the evaluator involving internal-conversion coefficients, a 1.4% uncertainty is assumed for the theoretical coefficients." },
  { n: "4.", text: "The cross reference flags (XREF), defined in the Adopted Levels table, are given for each adopted level. When a level in an individual reaction or decay data set may correspond to more than one adopted level, the flag for that data set is given in lower case. In case of ambiguity, the energy from a particular data set is given as a comment." },
];

const FOR_NUCLIDE: Prop[] = [
  { n: "1.", text: "$Q(\\beta)$: β⁻ decay energy [always presented as $Q(\\beta^-)=M(A,Z)-M(A,Z+1)$] and α decay energy [$Q(\\alpha)$] for the ground state." },
  { n: "2.", text: "$S(n)$ and $S(p)$: Neutron and proton separation energies." },
  { n: "3.", text: "XREF: Cross-reference symbol assignments for the various experimental data sets." },
];

const FOR_LEVEL: Prop[] = [
  { n: "1.", text: "$E(\\mathrm{lev})$: Excitation energy (relative to the ground state)." },
  { n: "2.", text: "$J^\\pi$: Spin and parity with arguments supporting the assignment." },
  { n: "3.", text: "$T_{1/2}$ or $\\Gamma$: Half-life or total width in center of mass." },
  { n: "4.", text: "Decay branching for the ground state and isomers (an isomer is defined as a nuclear level with $T_{1/2}\\ge100$ ns or one for which a separate decay data set is given in ENSDF)." },
  { n: "5.", text: "$Q,\\mu$: Static electric and magnetic moments." },
  { n: "6.", text: "XREF Flags to indicate in which reaction and/or decay data sets the level is seen." },
  { n: "7.", text: "Configuration assignments (e.g., Nilsson orbitals in deformed nuclei, shell-model assignments in spherical nuclei)." },
  { n: "8.", text: "Band assignments and possibly band parameters (e.g., rotational bands in deformed regions)." },
  { n: "9.", text: "Isomer and isotope shifts (usually only a literature reference is given)." },
  { n: "10.", text: "Charge distribution of ground states (usually only a literature reference is given)." },
  { n: "11.", text: "Deformation parameters." },
  { n: "12.", text: "$B(E2)\\uparrow$, $B(M1)\\uparrow$, …: Electric or magnetic excitation probabilities when the level half-life or the ground-state branching is not known." },
];

const FOR_GAMMA: Prop[] = [
  { n: "1.", text: "Placement in level scheme." },
  { n: "2.", text: "$E_\\gamma$: Measured γ-ray or E0 transition energy." },
  { n: "3.", text: "$I_\\gamma$: Relative photon intensity from each level." },
  { n: "4.", text: "Mult,δ: Electric or magnetic multipole character, the mixing ratio, and nuclear penetration parameter." },
  { n: "5.", text: "CC: Total internal-conversion coefficient (when $\\ge1.0\\times10^{-4}$)." },
  { n: "6.", text: "$B(EL)(\\mathrm{W.u.})$, $B(ML)(\\mathrm{W.u.})$, …: Reduced transition probabilities in Weisskopf units." },
];

const REACTION_DECAY: Prop[] = [
  { n: "1.", text: "The $J^\\pi$ values in decay data sets are taken from the associated Adopted Levels, Gammas data set. For reaction data sets the $J^\\pi$ values are from the reaction data. The $J^\\pi$ value to the capture state in thermal-neutron capture is assigned assuming s-wave capture." },
  { n: "2.", text: "The multipolarity of a γ ray and its mixing ratio given in a decay data set are from the associated Adopted γ radiation table." },
  { n: "3.", text: "The term \"absolute intensity\" has the same meaning as the term \"emission probability\", and the term \"relative intensity\" is equivalent to \"relative emission probability\" or \"relative emission rate\". The former are given as intensities per 100 decays." },
  { n: "4.", text: "Beta and electron-capture intensities are per 100 decays of the parent and are usually deduced from γ intensity imbalance for the levels fed. The separation of $I(\\varepsilon+\\beta^+)$ into $I(\\varepsilon)$ and $I(\\beta^+)$ is based on theoretical $\\varepsilon/\\beta^+$ ratios. The log ft values for nonunique transitions are calculated as for allowed transitions." },
  { n: "5.", text: "Particle transition intensities (other than β's) are per 100 particle decays. The total particle branching is given both in the drawings and in the tables." },
  { n: "6.", text: "Tabular γ-ray intensities are relative values. The normalization factor to convert them to absolute intensities [photons per 100 decays of the parent for decay data sets, or photons per 100 neutron captures for (n,γ) data sets, etc.] is given in a footnote." },
  { n: "7.", text: "Radiations from the decay of neutron or proton resonances are not presented. The energies and other level properties for bound levels deduced from resonance experiments are included. Primary as well as secondary γ's following thermal-neutron capture are generally included." },
  { n: "8.", text: "$B(E\\lambda)$, $B(M\\lambda)$ for the excitation of levels are generally given." },
  { n: "9.", text: "Up to three references that make major contributions to the information in a specific data set are given in the data set heading. These major references also appear in the drawings." },
];

const ORGANIZATION: Prop[] = [
  { n: "1.", text: "Adopted levels in $^AZ$ — all adopted level properties are shown for each level, together with explanatory comments." },
  { n: "2.", text: "Adopted γ radiations in $^AZ$." },
  { n: "3.", text: "Band structure is shown where known." },
  {
    n: "4.",
    text: "Levels and radiations in $^AZ$ from radioactive decays — decays are ordered by increasing A, Z, and excitation energy of the parent.",
    sub: ["a. Table of levels deduced from the decay.", "b. Tables of radiations observed in the decay.", "c. Decay scheme."],
  },
  {
    n: "5.",
    text: "Levels and γ rays in $^AZ$ from nuclear reactions — reactions are ordered by increasing A, Z of the target, then by increasing A, Z of the incident nucleus. A heading is given for each reaction.",
    sub: ["a. Table of levels deduced from the reaction.", "b. Table of γ rays observed in the reaction, if any.", "c. Level scheme, if γ rays were observed and placed."],
  },
];

/** Γγ/Γw upper limits, page iv. Footnote markers as printed in the source. */
const GAMMA_LIMITS: [string, string, string, string][] = [
  ["E1 (IV)", "0.3ᵃ˒#", "0.01", "0.01"],
  ["E2 (IS)ᵉ", "100", "300", "1000"],
  ["E3", "100", "100", "100"],
  ["E4", "100", "100†", "—"],
  ["M1 (IV)", "10", "3", "2"],
  ["M2 (IV)", "3", "1", "1"],
  ["M3 (IV)", "10", "10", "10"],
  ["M4", "30", "10", "—"],
];

const GAMMA_LIMIT_NOTES = [
  "* \"IV\" and \"IS\" stand for isovector and isoscalar.",
  "† Γγ/Γw (Upper Limit) = 30 for A=90–150.",
  "# Γγ/Γw (Upper Limit) = 0.1 for A=21–44.",
  "§ Γγ/Γw (Upper Limit) = 0.003 for E1 (IS), 10 for E2 (IS), 0.03 for M1 (IS), 0.1 for M2 (IS).",
  "a From 1979En05.  b From 1979En04.  c From 1981En06.  d Deduced from ENSDF by M. J. Martin.",
  "e In super-deformed bands the E2 transitions can have Γγ/Γw > 1000.",
];

const GROUND_STATES: Prop[] = [
  { n: "1.", text: "The ground state of an even-even nucleus has $J^\\pi=0^+$." },
  { n: "2.", text: "Spin determinations by such techniques as atomic-beam resonance, paramagnetic resonance, electron-spin resonance, and optical spectroscopy give correct values." },
];

const GAMMA_TRANSITIONS: Prop[] = [
  { n: "3.", text: "The agreement of the measured value of a single conversion coefficient with the theoretical value for a multipolarity which is well separated from the value for any other multipolarity determines the transition multipolarity." },
  { n: "4.", text: "In all other cases if there is no other evidence for multipolarity, agreement of two or more measured conversion coefficients or ratios with theoretical values is necessary in order to establish the multipolarities of a transition and its mixing ratio." },
  { n: "5.", text: "Since an E0 transition can proceed only by conversion or pair production, pure E0 is ruled out if photons are observed." },
  { n: "6.", text: "Recommended upper limits for γ-ray strengths ($\\Gamma_\\gamma/\\Gamma_w$, $\\Gamma_w$ = Weisskopf estimate) for various A values are given below." },
];

const BETA_PROPS: Prop[] = [
  { n: "7.", text: "If $\\log ft<5.9$, the transition is allowed: ΔJ=0 or 1, Δπ=no (no change in parity). Superallowed (ΔT=0) $0^+\\to0^+$ transitions have $\\log ft$ in the range 3.48 to 3.50. Isospin forbidden (ΔT=1) $0^+\\to0^+$ transitions have $\\log ft>6.4$. If $3.6<\\log ft<6.4$, the transition is not $0^+\\to0^+$." },
  { n: "8.", text: "If $\\log f^{1u}t<8.5$ ($\\log f't<7.4$), ΔJ=0,1; Δπ=yes or no, ($\\log f^{1u}t=\\log f't+1.079$)." },
  { n: "9.", text: "If $\\log ft<11.0$, ΔJ=0,1; Δπ=yes or no; or ΔJ=2, Δπ=yes." },
  { n: "10.", text: "If $\\log ft<12.8$, ΔJ=1,2; Δπ=yes or no." },
  { n: "11.", text: "If $\\log f^{1u}t>8.5$ ($\\log f't\\ge7.4$) and if the Fermi plot has the curvature corresponding to a shape factor $(p^2+q^2)$, then the transition is first-forbidden unique (ΔJ=2, Δπ=yes)." },
];

const GG_CORR: Prop[] = [
  { n: "12.", text: "If a gamma-gamma directional-correlation experiment yields $A_2\\approx+0.36$ and $A_4\\approx+1.1$, then the spin sequence is $0\\to2\\to0$." },
  { n: "13.", text: "Results of $\\gamma\\gamma(\\theta)$ are strong evidence for excluding spin sequences for which the theoretical $A_2$ or $A_4$ falls well outside the experimental range." },
];

const BG_CORR: Prop[] = [
  { n: "14.", text: "If $|A_2(\\beta)|\\ge0.1(A_2=0)$, the transition is not allowed. The converse is not true." },
  { n: "15.", text: "If $A_4(\\beta)\\neq0$, the transition is neither allowed nor first forbidden." },
  { n: "16.", text: "If $A_4(\\beta)=0$, the transition is allowed or first forbidden." },
];

const BG_POL: Prop[] = [
  {
    n: "17.",
    text: "In allowed transitions,",
    sub: [
      "$\\beta^-$:  $A_1(\\beta)<0$ if $J_i=J_f$;  $A_1(\\beta)\\ge0$ if $J_i=J_f+1$;  $A_1(\\beta)<0$ if $J_i=J_f-1$.",
      "$\\beta^+$:  $A_1(\\beta)>0$ if $J_i=J_f$;  $A_1(\\beta)\\le0$ if $J_i=J_f+1$;  $A_1(\\beta)>0$ if $J_i=J_f-1$.",
    ],
  },
  { n: "18.", text: "If $A_4(\\beta)\\neq0$, the β-transition is not allowed. The converse is not always true." },
];

const ANG_DIST: Prop[] = [
  {
    n: "19.",
    text: "In the angular distribution of gamma rays from deexcitation of states populated in high-spin reactions (for a typical value of $\\sigma/J\\approx0.3$, where σ is the magnetic substate population parameter):",
    sub: [
      "a. If $A_2\\approx+0.3$ and $A_4\\approx-0.1$, the transition is generally ΔJ=2 (stretched quadrupole). (The same $A_2$ and $A_4$ values are possible for ΔJ=0, D+Q transitions also, but such transitions are less common. $A_4=0$ for ΔJ=0, dipole transition.)",
      "b. If $A_2\\approx-0.2$ and $A_4\\approx0$, the transition is generally ΔJ=1 (stretched dipole).",
      "c. If $A_2<0$ ($A_2\\approx+0.5$ to $-0.8$), the transition is ΔJ=1, D+Q.",
    ],
  },
];

const DCO: Prop[] = [
  {
    n: "20.",
    text: "For ΔJ=2, stretched quadrupole as a gating transition:",
    sub: [
      "a. $R(\\mathrm{DCO})\\approx1.0$, the transition is generally ΔJ=2 (stretched quadrupole). (The same value is possible for ΔJ=0, but such transitions are less common.)",
      "b. If $R(\\mathrm{DCO})\\approx0.5$, the transition is generally ΔJ=1 (stretched dipole).",
      "c. If $R(\\mathrm{DCO})$ differs significantly from $\\approx0.5$ or $\\approx1.0$, the transition is ΔJ=1 (or 0), D+Q.",
    ],
  },
  {
    n: "21.",
    text: "For ΔJ=1, stretched dipole as a gating transition:",
    sub: [
      "a. If $R(\\mathrm{DCO})\\approx2.0$, the transition is generally ΔJ=2 (stretched quadrupole). (The same value is possible for ΔJ=0, dipole transitions, but such transitions are less common.)",
      "b. If $R(\\mathrm{DCO})\\approx1.0$, the transition is generally ΔJ=1 (stretched dipole).",
      "c. If $R(\\mathrm{DCO})$ differs significantly from $\\approx2.0$ or $\\approx1.0$, the transition is ΔJ=1 (or 0), D+Q.",
    ],
  },
];

const REACTIONS_A: Prop[] = [
  { n: "22.", text: "Low-energy Coulomb excitation is predominantly E2 excitation." },
  { n: "23.", text: "Coulomb excitation determines $J^\\pi$ if the excitation probability agrees with the calculated values of Alder (1960Al23)." },
  { n: "24.", text: "The spin of the compound nuclear state resulting from thermal-neutron capture is equal to the spin of the target nucleus plus or minus 1/2." },
  { n: "25.", text: "Primary γ's from neutron capture are E1, M1, E2, or M1+E2." },
  { n: "26.", text: "If the angular distribution in a single-nucleon transfer reaction can be fitted with a unique L value, the spin of the final state $J_f$ is related to the spin of the initial state $J_i$ by $\\vec{J_f}=\\vec{J_i}+\\vec{L}+\\tfrac{1}{2}$, with parity change if L is odd." },
  { n: "27.", text: "If the vector analyzing power for a single-nucleon transfer reaction shows a clear preference between $J=L+1/2$ and $J=L-1/2$ and if the L value is known, then the J value is determined." },
  { n: "28.", text: "Generally for the states populated in high-spin reactions, spins increase with increasing excitation energy. This is a result of the fact that these reactions tend to populate yrast or near yrast states." },
  {
    n: "29.",
    text: "If the angular distribution can be fitted with a unique L-value, the $J^\\pi$ of the final state is related to that of the initial state by $\\vec{J_f}=\\vec{J_i}+\\vec{L}$, $\\pi_i\\pi_f=(-1)^L$, for the following cases:",
    sub: [
      "a. A strong group observed in (p,t), (t,p), and (³He,n) reactions (strong groups are assumed to result from two identical nucleons transferred in a relative s state).",
      "b. A strong group observed in the α-particle transfer reaction (⁶Li,d).",
      "c. (e,e′) and (α,α′) inelastic scattering.",
    ],
  },
  {
    n: "30.",
    text: "In reactions with $J^\\pi=0^+$ target, projectile, and ejectile, if the yield of a group at 0° or 180° is",
    sub: [
      "a. non-zero, the parity of the final state is $(-1)^{J_f}$;",
      "b. zero at several uncorrelated energies, the parity of the final state is $(-1)^{J_f+1}$.",
    ],
  },
  {
    n: "31.",
    text: "In reactions with a polarized $J^\\pi=1$ projectile in the m=0 substate, with $J^\\pi=0^+$ ejectile and target, if the yield of a group at 0° or 180° is",
    sub: [
      "a. non-zero, the parity of the final state is $(-1)^{J_f+1}$;",
      "b. zero at several uncorrelated energies, the parity of the final state is $(-1)^{J_f}$.",
    ],
  },
];

const DEFORMATION_A: Prop[] = [
  { n: "32.", text: "Level-energy considerations. If the couplings among the states are not too strong, the energies of the lower members of a band can be expressed by the relatively simple relation (see, e.g., 1971Bu16 and references therein):" },
];

const DEFORMATION_B: Prop[] = [
  { n: "33.", text: "Allowed-unhindered beta transitions. In this region, beta transitions having $\\log ft$ values $<5.0$ are classified as \"allowed unhindered\" (au). Such transitions take place between one-quasiparticle orbitals having the same asymptotic quantum numbers. In the \"rare-earth\" region ($90\\le N\\le112$, $60\\le Z\\le76$), four such orbital pairs are known: [532], near the beginning of this region; [523], near the middle of this region; [514], above the middle of this region; and, at the high end, [505]. Observation of an au transition is definitive evidence for the presence of the particular pair of orbitals." },
  { n: "34.", text: "Coulomb excitation. If a sequence of levels having \"rotational-like\" energy spacings is found to be excited with enhanced probabilities, this is evidence that this sequence (at least below the first \"backbend\") forms the ground-state rotational band for the nuclide involved. If the E2 transition probabilities involved are large (tens of Weisskopf units or larger) and comparable to each other, then this is definitive evidence for both a band structure and the sequence of $J^\\pi$ values, assuming one of the spins is known." },
  { n: "35.", text: "Alpha decay. Observation of a \"favored\" α transition (HF<4) indicates that the two states involved have the same nucleonic configuration. If a sequence of levels having \"rotational-like\" energy spacings is associated with the level fed by this favored transition and these levels have HF's that vary according to the established trend within rotational bands (1972El21), then this sequence can be considered to form a rotational band whose nucleonic configuration is the same as that of the alpha-decaying state. If the $J^\\pi$ value of this latter state and its configuration are known, then the corresponding quantities can be deduced for the band in the daughter nuclide, or vice versa." },
  { n: "36.", text: "Single-nucleon-transfer reactions (light-ion-induced). For a single-nucleon transfer reaction induced by light ions (³He and lighter), the characteristic pattern of cross sections among rotational-band members (\"fingerprint\") can be used to assign a set of levels as specific $J\\pi$ members of a band based on a particular Nilsson configuration, if the fingerprint agrees well with that predicted by the Nilsson-model wavefunctions and is distinct from those expected for other configurations in the mass region. (This method is even stronger if angular distributions giving unique L values, or vector analyzing powers, support the assignments for one or more of the levels.)" },
];

const HIGH_SPIN: Prop[] = [
  {
    n: "37.",
    text: "For a deformed nucleus, a regular sequence of gamma-ray transitions can be assigned to a ΔJ=2 (decoupled) or a ΔJ=1 (strongly-coupled or magnetic-dipole) rotational-band structure with definite spin-parity assignments if:",
    sub: [
      "a) the spin and parity of at least one level in this band is unambiguously determined; and",
      "b) for ΔJ=2 band structures, or, for ΔJ=1 band structures, i) at least one of the crossover (ΔJ=2) transitions has a well established E2 multipolarity, or, ii) at least one of the stopover (ΔJ=1) transitions has a well established M1 (or M1+E2) multipolarity or (for parity-doublet bands) E1 multipolarity; and",
      "c) some other in-band transitions are stretched quadrupole for the ΔJ=2 band structures or stretched dipole (or dipole plus quadrupole) for ΔJ=1 band structures.",
    ],
  },
];

const ALPHA_PROTON: Prop[] = [
  { n: "38.", text: "The hindrance factor for an α transition from the ground state of an even-even nucleus to the ground state of the daughter nucleus is 1.0 by definition. For odd-A and odd-odd nuclei, hindrance factors $\\le4$ identify favored α transitions, and these connect states having the same spin, parity and configuration." },
  { n: "39.", text: "For α-decay between two states, one of which has J=0, the parity change is given by $\\Delta\\pi=(-1)^{\\Delta J}$." },
  { n: "40.", text: "The spin and parity of a level exhibiting proton radioactivity and belonging to a nearly-spherical odd-Z, even-N nucleus can be taken equal to a particular set of $J\\pi$ values of the emitted proton if a) the transition reaches the ground state of the daughter nucleus, b) the proton $J\\pi$ values are physically reasonable, i.e., supported by systematic studies / Shell Model calculations, c) the calculated proton radioactivity half-life for those $J\\pi$ values is smaller than the experimental value, and d) the calculated proton radioactivity half-lives for the other physically possible $J\\pi$ values are far larger or far smaller than the experimental value." },
];

const WEAK_A: Prop[] = [
  { n: "1.", text: "In cases where gammas of one multipolarity \"cluster\" in one time region in the half-life vs. energy plot, as is true for M4's, other γ's whose half-lives fall in this region may be assigned the corresponding multipolarity." },
  { n: "2.", text: "In cases where a cluster of two multipolarities, e.g. M1 and E2, occupies one time region, a new gamma of which the half-life falls in this region may be assigned one of these two multipolarities or a mixture of the two." },
  { n: "3.", text: "Whenever $\\Delta J\\ge2$, an appreciable part of the gamma transition proceeds by the lowest possible multipole order. (This statement is based on the scarcity of counter-examples and the observation that few E2 γ's are as slow as M3's, few E2's as slow as E3's, etc.)" },
  { n: "4.", text: "The spin and parity of a parent state may be inferred from the measured properties of its assumed isobaric analog resonance, and vice versa." },
  { n: "5.", text: "Low-lying states of odd-A nuclei have shell-model spins and parities, except in the regions where deformations appear. This argument is much stronger when supported by expected cross-section strengths ($C^2S$) in single-nucleon transfer reactions." },
  { n: "6a.", text: "For low-lying states of odd-odd spherical nuclei, the Nordheim rules (1950No10) may be helpful in obtaining the ground-state spins and parities, if there is supporting evidence." },
];

const WEAK_B: Prop[] = [
  { n: "6b.", text: "For excited states of strongly deformed odd-odd nuclei, the Gallagher-Moszkowski rules (1958Ga27) may be helpful in deducing the relative positions of the two two-quasiparticle states formed by the two different couplings of the quasiparticle constituents, if there is supporting evidence. Here, the state corresponding to the parallel alignment (Σ=1) of the projections (=1/2) of the intrinsic spins of the two odd particles is expected to lie lower than that produced by the antiparallel (Σ=0) alignment. This can be particularly useful in establishing the ground state $J\\pi$ values and nucleonic configurations for odd-odd nuclei." },
  { n: "7.", text: "Statements similar to 5 and 6 based on other models." },
  { n: "8.", text: "Statements based on interpolation or extrapolation of regional trends, such as shown in 1971Bu16, 1972El21, 1977Ch27, 1990Ja11 and 1998Ja07 for the rare-earth and heavy-mass regions." },
  { n: "9.", text: "All statements connected with the nonobservation of expected transitions." },
  { n: "10.", text: "Rules extracted from the survey by 1972El21 for unfavored α transitions can be used to deduce the configuration of the parent or the daughter level, if the configuration of the other is known." },
  { n: "11.", text: "For magnetic moments, the extreme rarity of pure single-particle states and observation of large deviations from free-nucleon g-factors in nuclei means that comparison between the experiment and the 'Schmidt Limit' estimates (based on such pure states) is not a sound basis for spin or parity assignment. The magnetic moments, or g-factors, however, can give supporting, and in some cases decisive, evidence for assignments where predictions of g-factors based on local systematics of measured moments differ widely. For excited states, the 'collective' aspects of the state frequently make substantial contribution to the magnetic moment. The correct g-factor for this contribution, however, is a matter of detailed theory and any potential assignment based on assumed $g(\\mathrm{collective})=Z/A$ must be viewed with caution." },
  { n: "12.", text: "In the absence of angular distribution/correlation data or other supporting arguments, a regular sequence of gamma-ray transitions in high-spin data may be assigned to a common structure or band which represents tentative spin-parity assignments if either the bandhead or some other low-lying member of this structure has reasonably well established spin and parity." },
];

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */

export default function Docs() {
  const jump = (id: string) =>
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  return (
    <div className="mx-auto max-w-4xl px-4 py-6 md:px-8">
      <div className="mb-5">
        <h1 className="text-2xl font-semibold text-primary">ENSDF policies</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The general policies that govern every Nuclear Data Sheets evaluation.
        </p>
      </div>

      <div className="mb-8 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm leading-relaxed text-muted-foreground">
          Transcribed from <span className="font-medium text-foreground">Nuclear Data Sheets — General
          Policies</span> (pages i–vi), the front matter distributed with every NDS issue. Display math
          is re-typeset here; content follows the source.
        </p>
        <a href={PDF_URL} target="_blank" rel="noopener noreferrer">
          <Button variant="outline" size="sm">
            Official PDF <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
          </Button>
        </a>
      </div>

      {/* ---------------- Presentation of data ---------------- */}
      <div className="flex flex-col gap-6 md:flex-row">
        {/* Mini TOC — sticky alongside the content on md+ */}
        <nav className="md:sticky md:top-2 md:h-fit md:w-52 md:flex-shrink-0">
          <p className="mb-2 text-[10px] uppercase tracking-wide text-muted-foreground">On this page</p>
          <div className="space-y-0.5">
            {TOC.map((t) => (
              <button
                key={t.id}
                onClick={() => jump(t.id)}
                className="flex w-full items-center rounded-lg px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                {t.title}
              </button>
            ))}
          </div>
        </nav>

        <div className="min-w-0 flex-1">
      <Section title="General Policies — Presentation of Data">
        <Para>
          The Nuclear Data Sheets are prepared from the Evaluated Nuclear Structure Data File (ENSDF),
          a computer file maintained by the National Nuclear Data Center on behalf of the
          International Network for Nuclear Structure and Decay Data Evaluations. The presentation of
          material in the Nuclear Data Sheets reflects the organization of ENSDF, which is a
          collection of "data sets". For each nuclear species, these data sets present the following
          types of information:
        </Para>
        <ul className="mb-3 ml-5 list-disc space-y-1.5 text-sm leading-relaxed text-muted-foreground">
          <li>The adopted properties of the nucleus.</li>
          <li>
            The evaluated results of a single type of experiment, such as a radioactive decay, a
            single nuclear reaction, or the combined results of a number of similar types of
            experiments, such as (HI,xnγ) reactions. The data given in ENSDF are primarily derived
            from experimental information.
          </li>
        </ul>

        <Sub>General</Sub>
        <Para>
          The following policies apply to the adoption or presentation of data. Deviations from these
          policies will be noted by the evaluator.
        </Para>
        <PropList items={GENERAL} />

        <Sub>Adopted Levels, Gammas data set</Sub>
        <Para>
          The Adopted Levels and γ radiations tables in the NDS are generated from an Adopted Levels,
          Gammas data set in ENSDF. This data set represents the best values for the level and γ
          properties as determined by the evaluator on the basis of all the available information.
        </Para>
        <p className="mb-2 text-sm font-medium text-foreground">For the nuclide:</p>
        <PropList items={FOR_NUCLIDE} />
        <p className="mb-2 text-sm font-medium text-foreground">For each level:</p>
        <PropList items={FOR_LEVEL} />
        <p className="mb-2 text-sm font-medium text-foreground">For γ-ray and E0 transitions:</p>
        <PropList items={FOR_GAMMA} />

        <Sub>Reaction and decay data sets</Sub>
        <Text t={"These data sets include information about different types of experiments and may include data sets for β decay, α decay, isomeric transition (IT) decay, Coulomb excitation, charged-particle reactions [such as (d,p) and (t,p)], heavy-ion reactions [such as $(^{40}\\mathrm{Ar},xn\\gamma)$], (γ,γ′), and mesonic atoms."} />
        <Para>
          The following policies apply to the presentation of data in reaction and decay data sets.
          Any deviation from these policies will be noted by the evaluator.
        </Para>
        <PropList items={REACTION_DECAY} />

        <Sub>Organization of material</Sub>
        <Text t={"Within each A chain, information is presented by nuclides which are arranged in order of increasing Z. There is an index for each evaluation which is followed by an isobaric diagram. A table of properties for the ground state and isomeric levels for all nuclides of the A chain is given following or with the isobaric diagram."} />
        <Text t={"For each nuclide, $^AZ$, the arrangement of material and conventions for inclusion in tables are given below."} />
        <PropList items={ORGANIZATION} />
      </Section>

      {/* ---------------- Theory ---------------- */}
      <Section title="Theory">
        <Para>
          A reference "Theory 1967Xy01" indicates theoretical predictions computed by the authors of
          1967Xy01. A reference "Theory" alone indicates a determination by the evaluator of
          theoretical predictions described below.
        </Para>

        <Sub>Internal conversion coefficients</Sub>
        <Text t={"Theoretical conversion electron coefficients are obtained by cubic spline interpolation (BrIcc, 2008Ki07) from tables calculated using the relativistic Dirac-Fock method and the so-called \"Frozen Orbitals\" approximation (2002Ba85, 2002Ra45). These tables cover the K, L1, L2, … R2 shells, E1–E5 and M1–M5 multipolarity, Z=10 to 110 atomic numbers and $E_\\gamma$ transition energies from 1 keV above shell binding energy up to 6000 keV. Conversion electron coefficients for transitions outside the $E_\\gamma$, A, or Z ranges of BrIcc are obtained as follows: for $E_\\gamma<6000$ keV and Z=3 and interpolation from the tables of Band, et al. (1976Ba63); for $E_\\gamma>6000$ keV, by graphical interpolation from the tables of Trusov (1972Tr09). For Z>110 atomic numbers theoretical conversion electron coefficients are obtained by cubic spline interpolation from the tables of Band, et al. (2002Ba85) and Kibedi, et al. (2008Ki07)."} />

        <Sub>Angular distribution and correlation coefficients</Sub>
        <Text t={"The coefficients required for analysis of directional correlation, polarization correlation, directional distribution, and polarization distribution data are obtained as described by Steffen (1971St47, 1971St48). In particular, we adopt the phase convention for the mixing ratio, δ, defined by Krane and Steffen (1970Kr03). Particle parameters required for the analysis of correlation and distribution data involving conversion electrons are obtained by graphical interpolation from tables of Hager and Seltzer (1968Ha54). The expression for the deorientation coefficient required to account for intermediate unobserved mixed radiations is given by Anicin (1972An20).* A tabulation of gamma-gamma directional-correlation coefficients is given by Taylor, et al. (1971Ta32). These authors use the Steffen phase convention."} />
        <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
          * As pointed out by these authors, most earlier references which discuss this coefficient
          define it incorrectly.
        </p>

        <Sub>Penetration parameters</Sub>
        <Para>
          Penetration parameters required for the analysis of internal conversion data and angular
          correlation or distribution data involving electrons are obtained by graphical interpolation
          from tables of Hager and Seltzer (1969Ha61).
        </Para>

        <Sub>Internal pair conversion coefficients</Sub>
        <Para>
          Theoretical pair conversion coefficients for E1-E3 and M1-M3 multipolarities are obtained by
          cubic spline interpolation (2008Ki07) from tables of Schluter and Soff (1979Sc31) for Z=1–49
          and from Hofmann and Soff (1996Ho21) for Z=50–100.
        </Para>

        <Sub>E0 electronic factors</Sub>
        <Para>
          For E0 transitions, electronic factors are obtained by cubic spline interpolation (2008Ki07)
          from tables of Hager and Seltzer (1969Ha61) for Z=30–38, L1– and L2–shell and transition
          energies starting 6 keV above K-shell binding energy up to 1500 keV; Bell et al. (1970Be87)
          for Z=40–102, K–, L1– and L2–shell and transition energies starting from 51.1 keV
          (Z=40–58), 102.2 keV (Z=60–82), 153.3 keV (Z=84–96), 204.4 keV (Z=98–102) up to 2555 keV;
          and Passoja and Salonen (1986PaZM) for K–shell, Z=8–38, transition energies of 511 keV to
          12775 keV and for pair conversion, Z=8–40, transition energies of 1430.8 keV to 12775 keV.
        </Para>

        <Sub>Beta transitions (β⁻, β⁺, and ε decays)</Sub>
        <Para>Beta transitions are classified as allowed or forbidden:</Para>
        <Text t={"(a) Allowed transitions occur between states with the same parity ($\\pi_i\\cdot\\pi_f=+1$) and with a spin difference of $|J_i-J_f|=\\Delta J=0$ or 1. The spins of the emitted beta and neutrino can couple to S=0 (called Fermi transitions) or to S=1 (called Gamow-Teller transitions). Transitions with ΔJ=±1 are pure Gamow-Teller decays, and pure Fermi transitions can only occur between J=0 nuclear states. All other ΔJ=0 transitions are mixed Fermi and Gamow-Teller decays."} />
        <Text t={"(b) Forbidden transitions are further subdivided into their order of forbiddenness, the transitions becoming slower as the order increases. A general definition for an n–times forbidden beta transition is"} />
        <MathBlock tex="\Delta\pi=\pi_i\cdot\pi_f=(-1)^n,\qquad \Delta J=n,\ n+1" />
        <Text t={"(except first-forbidden, which may have ΔJ=0). $\\Delta J=n+1$ transitions are called $n^\\mathrm{th}$ forbidden-unique beta transitions. Therefore:"} />
        <ul className="mb-3 ml-5 list-disc space-y-1.5 text-sm leading-relaxed text-muted-foreground">
          <li><TexText text={"first-forbidden transitions (n=1) occur between states with different parity ($\\pi_i\\cdot\\pi_f=-1$) and with a spin difference of ΔJ=0, ±1, ±2; those with ΔJ=±2 are specified as being first-forbidden unique;"} /></li>
          <li><TexText text={"second-forbidden (n=2) beta transitions occur between states with the same parity ($\\pi_i\\cdot\\pi_f=+1$) and ΔJ=±2, ±3; the ΔJ=±3 transitions being further specified as second-forbidden unique;"} /></li>
          <li>for third-, fourth-forbidden, etc., transitions, n=3, 4, etc., respectively.</li>
        </ul>
        <Para>
          An allowed/forbidden beta transition may also be hindered or may be fast as a result of the
          nuclear structure of the initial and final states involved. See, for example, 1966Ko30 for a
          detailed discussion of the operators involved in various types of beta transitions. The
          selection rules for Nilsson states in deformed regions are tabulated in 1971El12. Violation
          of these selection rules could slow a beta transition. Definitions of some of the frequently
          used terms are given below:
        </Para>
        <ul className="mb-3 ml-5 list-disc space-y-1.5 text-sm leading-relaxed text-muted-foreground">
          <li>If a ΔJ=0 transition occurs between analog states (i.e. states having the same isospin and configuration), then the decay is very fast and is called "superallowed."</li>
          <li>Special cases of "allowed unhindered" (au) transitions in deformed regions are discussed in section 33 of Bases for Spin and Parity.</li>
          <li>"Isospin-forbidden" transitions refer to the decays between J=0 states of different isospin (i.e. non-analog states).</li>
          <li><TexText text={"\"l-forbidden\" transitions are those with $\\Delta l>\\Delta J$, where $\\Delta l$ is the change in $l$ between the initial and final shell-model states."} /></li>
          <li>In deformed regions, if ΔK, the change in the K quantum number between the initial and final states, is larger than the spin change, ΔJ, the transition is called "K-forbidden."</li>
        </ul>
        <Text t={"Log ft values, capture-to-positron ratios, and electron-capture ratios for allowed, first-forbidden unique, and second-forbidden unique transitions are obtained as described by Gove and Martin (1971Go40). A fast (strong) beta transition has a low ft value; forbidden transitions have larger ft values. Compilations of $\\log ft$ values for known and well-established beta transitions appear, for example, in 1998Si17 and 1973Ra10. The rules for various types of beta transitions are given in sections 7–11 under Bases for Spin and Parity."} />

        <Sub>Atomic processes</Sub>
        <Para>
          X-ray fluorescence yields are obtained from Bambynek, et al. (1972Bb16) for Z≤92 and from
          Ahmad (1979Ah01) for Z&gt;92. Electron binding energies for Z&lt;84 are taken from Bearden
          and Burr (1967Be73) and from Porter and Freedman (1978Po08) for Z&gt;84.
        </Para>

        <Sub>α-decay hindrance factors</Sub>
        <Para>
          The α-hindrance factors (the ratio of the measured partial half-life for α-emission to the
          theoretical half-life) are obtained from the spin-independent equations of Preston
          (1947Pr17). The nuclear radius for each even-even nucleus is determined by defining, for the
          g.s. to g.s. α-transition, the hindrance factor (HF)=1. For odd-A and odd-odd nuclei, the
          radius parameters are assumed to be the average of the radii for the adjacent even-even
          nuclei (1998Ak04). In cases where only one adjacent even-even radius is known, the
          extrapolated/interpolated value for the unknown radius is used in the calculation. A survey
          of the dependence of α-hindrance factors on asymptotic quantum numbers and the variation of
          α-hindrance factors within rotational bands is given for A≥229 in 1972El21.
        </Para>

        <Sub>Electromagnetic transition rates</Sub>
        <Text t={"The Weisskopf single-particle estimates for the half-lives of electric and magnetic multipole radiation of energy $E_\\gamma$ are (1952Bl97)"} />
        <MathBlock tex="T_{1/2W}(EL)=0.190\left(\frac{L}{L+1}\right)\left(\frac{3+L}{3}\right)^{2}\frac{\left[(2L+1)!!\right]^{2}}{A^{2L/3}}\left(\frac{164.44}{E_\gamma(\mathrm{MeV})}\right)^{2L+1}\times10^{-21}\ \mathrm{s}" />
        <MathBlock tex="T_{1/2W}(ML)=3.255\,A^{-2/3}\,T_{1/2W}(EL)" />
        <Text t={"for a nuclear radius of $1.2\\,A^{1/3}\\times10^{-13}$ cm."} />

        <Sub>Unweighted and weighted averages</Sub>
        <Text t={"If $x_1\\pm\\Delta x_1,\\ x_2\\pm\\Delta x_2,\\ \\ldots x_n\\pm\\Delta x_n$ are n independent measurements of a given quantity, $\\Delta x_i$ being the uncertainty in $x_i$, then the weighted average of these measurements is $\\bar{x}\\pm\\Delta\\bar{x}$, where"} />
        <MathBlock tex="\bar{x}=W\sum \frac{x_i}{(\Delta x_i)^{2}},\qquad W=\frac{1}{\sum (\Delta x_i)^{-2}}" />
        <Text t={"and $\\Delta\\bar{x}$ is the larger of"} />
        <MathBlock tex="(W)^{1/2}\qquad\text{and}\qquad \left[W\sum (\Delta x_i)^{-2}\frac{(\bar{x}-x_i)^{2}}{n-1}\right]^{1/2}" />
        <Text t={"The unweighted average of these same measurements is given by $\\bar{x}\\pm\\Delta\\bar{x}$, where"} />
        <MathBlock tex="\bar{x}=\sum \frac{x_i}{n},\qquad \Delta\bar{x}=\left[\sum \frac{(\bar{x}-x_i)^{2}}{n(n-1)}\right]^{1/2}" />
      </Section>

      {/* ---------------- Bases for spin and parity ---------------- */}
      <Section title="Summary of Bases for Spin and Parity Assignments">
        <p className="mb-3 text-sm font-medium text-foreground">
          Propositions on which strong arguments are based
        </p>

        <Sub>Ground states</Sub>
        <PropList items={GROUND_STATES} />

        <Sub>Gamma transitions</Sub>
        <PropList items={GAMMA_TRANSITIONS} />
        <p className="mb-2 text-xs text-muted-foreground">
          <TexText text={"$\\Gamma_\\gamma/\\Gamma_w$ (Upper Limit)"} />
        </p>
        <div className="mb-2 overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 font-medium">Character<sup>*</sup></th>
                <th className="px-3 py-2 text-right font-medium">A=6–44<sup>§</sup></th>
                <th className="px-3 py-2 text-right font-medium">A=45–150<sup>b,c</sup></th>
                <th className="px-3 py-2 text-right font-medium">A&gt;150<sup>d</sup></th>
              </tr>
            </thead>
            <tbody>
              {GAMMA_LIMITS.map(([character, a, b, c]) => (
                <tr key={character} className="border-b last:border-0">
                  <td className="px-3 py-1.5 font-mono text-xs text-foreground">{character}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-xs text-muted-foreground">{a}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-xs text-muted-foreground">{b}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-xs text-muted-foreground">{c}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mb-3 space-y-0.5">
          {GAMMA_LIMIT_NOTES.map((n) => (
            <p key={n} className="text-[11px] leading-relaxed text-muted-foreground">{n}</p>
          ))}
        </div>

        <Sub>Beta transitions</Sub>
        <PropList items={BETA_PROPS} />
        <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
          § Note that for nuclei at, or very near to, closed shells, log ft values may be smaller. For
          example, in the mass region around Z=82, the upper limit of 5.9 given in #7 could be 5.1.
        </p>

        <Sub>γγ directional correlation</Sub>
        <MathBlock tex="W(\theta)=\sum_{k\ \mathrm{even}} A_k P_k(\cos\theta)" />
        <PropList items={GG_CORR} />

        <Sub>βγ directional correlation</Sub>
        <MathBlock tex="W(\theta)=\sum_{k\ \mathrm{even}} A_k(\beta)A_k(\gamma)P_k(\cos\theta)" />
        <PropList items={BG_CORR} />

        <Sub>βγ polarization correlation</Sub>
        <MathBlock tex="P(\theta)=\frac{\sum_{k\ \mathrm{odd}} A_k(\beta)A_k(\gamma)P_k(\cos\theta)}{W(\theta)}" />
        <PropList items={BG_POL} />

        <Sub>γ angular distribution</Sub>
        <PropList items={ANG_DIST} />

        <Sub>γ DCO ratio</Sub>
        <PropList items={DCO} />

        <Sub>Reactions</Sub>
        <PropList items={REACTIONS_A} />

        <Sub>Regions of strong nuclear deformation</Sub>
        <Text t={"The systematic occurrence of rotational-band structure in the strongly deformed nuclides can be a considerable help in making $J^\\pi$ assignments, since one can also use the level energy as one of the considerations. This frequently makes it possible to assign a $J^\\pi$ value to a level with confidence from data which, absent such structure, might yield an ambiguous assignment."} />
        <PropList items={DEFORMATION_A} />
        <MathBlock tex="E(J,K)=AX+BX^{2}+CX^{3}+\cdots+(-1)^{J+K}\prod_{i=1}^{K}(J+i)\left\{A_{2K}+B_{2K}X+\cdots\right\},\qquad X=J(J+1)-K^{2}" />
        <Text t={"The inertial parameter, A, exhibits a systematic behavior in the various regions of strongly deformed nuclei, which can be helpful in assigning levels to rotational bands. In some instances (e.g., strong Coriolis coupling) where the A values depart significantly from systematic trends, this observation can itself be useful, since it can help establish the presence of such effects and, hence, provide evidence for the relevant nucleonic configurations. For the case of K=1/2 bands, the decoupling parameter, a, which is characteristic for each such band, is given by the ratio $A_{2K}/A$ in the expression above. Establishing a value for the decoupling parameter of a proposed band can be useful in assigning a nucleonic configuration to it — and vice versa."} />
        <PropList items={DEFORMATION_B} />

        <Sub>High-spin states</Sub>
        <Para>
          In the decay of high-spin states, commonly produced in heavy-ion induced compound nuclear
          reactions or in highly excited nuclides created as products of nuclear fission or in Coulomb
          excitation, the multipolarities of the deexciting γ transitions and the relative spins and
          parities of the levels are generally determined from angular distributions, angular
          correlations (DCO ratios), linear polarizations and internal-conversion coefficients. In
          addition, relative energy-level spacings and the increase of γ intensity with decreasing
          excitation energy are important clues.
        </Para>
        <PropList items={HIGH_SPIN} />

        <Sub>Alpha and proton decay</Sub>
        <PropList items={ALPHA_PROTON} />

        <p className="mb-3 mt-6 text-sm font-medium text-foreground">
          Propositions on which weak arguments are based
        </p>
        <PropList items={WEAK_A} />
        <MathBlock tex="J=j_p+j_n,\ \ \text{if}\ j_p=l_p+\tfrac{1}{2}\ \text{and}\ j_n=l_n-\tfrac{1}{2};\qquad J=|j_p-j_n|,\ \ \text{if}\ j_p=l_p+\tfrac{1}{2}\ \text{and}\ j_n=l_n+\tfrac{1}{2}" />
        <Para>
          It is recognized that some shell-model predictions are stronger than others. For example,
          the shell model would mildly deny that the ground-state Jπ of the 39th proton be 3/2⁻, but
          emphatically deny it being 3/2⁺. However, we have not included this distinction here and
          consider all shell-model arguments to be weak.
        </Para>
        <PropList items={WEAK_B} />
        <Para>
          (In the strongly deformed even-even nuclei, the opposite is expected to obtain, i.e., the
          Σ=0 coupling should lie lower than that with Σ=1. In these nuclei, however, the experimental
          situation is less clear since the two-quasiparticle excitations occur at or above the
          pairing gap, where level densities are high and coupling to vibrational excitations can
          affect the two two-quasiparticle states differently.)
        </Para>
      </Section>
        </div>
      </div>
    </div>
  );
}
