// Build src/data/subjects.json — the Subjects pages' data.
//
// One row per (server, category): the archive's own category list (live counts
// come from /api/dict at runtime, never from this file) enriched with its MeSH
// descriptor — name, unique ID, tree number(s), scope note — resolved against
// NLM's id.nlm.nih.gov lookup service. Run from the laptop (NLM rate limits are
// gentle; ~80 categories × ≤3 requests). Misses are kept with mesh: null and
// logged, so the page can render every subject whether or not MeSH knows it.
//
//   npx tsx scripts/subjects/build-subjects.mts
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SITE = "https://cshl.nysgpt.com";
const MESH = "https://id.nlm.nih.gov/mesh";

// Categories whose archive name is not a MeSH label or entry term. Curated by
// hand once; everything else resolves automatically.
const ALIAS: Record<string, string> = {
  "hiv aids": "Acquired Immunodeficiency Syndrome",
  "addiction medicine": "Behavior, Addictive",
  "intensive care and critical care medicine": "Critical Care",
  "primary care research": "Primary Health Care",
  "sexual and reproductive health": "Reproductive Health",
  "sports medicine": "Sports Medicine",
  "health systems and quality improvement": "Quality Improvement",
  "health informatics": "Medical Informatics",
  "genetic and genomic medicine": "Genomic Medicine",
  "obstetrics and gynecology": "Gynecology",
  "allergy and immunology": "Allergy and Immunology",
  "otolaryngology": "Otolaryngology",
  "nutrition": "Nutritional Sciences",
  "pain medicine": "Pain Management",
  "radiology and imaging": "Radiology",
  "rehabilitation medicine and physical therapy": "Physical and Rehabilitation Medicine",
  "respiratory medicine": "Pulmonary Medicine",
  "rheumatology": "Rheumatology",
  "scientific communication and education": "Communication",
  "synthetic biology": "Synthetic Biology",
  "systems biology": "Systems Biology",
  "zoology": "Zoology",
  "animal behavior and cognition": "Behavior, Animal",
  "cancer biology": "Neoplasms",
  "developmental biology": "Developmental Biology",
  "evolutionary biology": "Biological Evolution",
  "plant biology": "Plant Physiological Phenomena",
  "scientific communication": "Communication",
  "paleontology": "Paleontology",
  "pharmacology and toxicology": "Pharmacology",
  "bioengineering": "Bioengineering",
  "biochemistry": "Biochemistry",
  "bioinformatics": "Computational Biology",
  "cell biology": "Cell Biology",
  "molecular biology": "Molecular Biology",
  "cardiovascular medicine": "Cardiology",
  "emergency medicine": "Emergency Medicine",
  "forensic medicine": "Forensic Medicine",
  "medical education": "Education, Medical",
  "medical ethics": "Ethics, Medical",
  "nuclear medicine": "Nuclear Medicine",
  "occupational and environmental health": "Occupational Health",
  "psychiatry and clinical psychology": "Psychiatry",
  "public and global health": "Global Health",
  "infectious diseases": "Communicable Diseases",
  "epidemiology": "Epidemiology",
  "health economics": "Economics, Medical",
  "geriatric medicine": "Geriatrics",
  "surgery": "General Surgery",
  "pharmacology and therapeutics": "Pharmacology, Clinical",
  "dentistry and oral medicine": "Dentistry",
  "immunology": "Allergy and Immunology",
  "neuroscience": "Neurosciences",
  "clinical trials": "Clinical Trials as Topic",
  "oncology": "Medical Oncology",
};

interface SubjectRow {
  category: string;
  name: string;
  papers: number;
  mesh: null | {
    id: string;
    label: string;
    treeNumbers: string[];
    scopeNote: string | null;
  };
}

const titleCase = (s: string) =>
  s.replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/\bAnd\b/g, "and").replace(/\bHiv\b/g, "HIV").replace(/\bAids\b/g, "AIDS");

async function json<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

type LookupHit = { resource: string; label: string };

async function findDescriptor(category: string): Promise<LookupHit | null> {
  const tries = [ALIAS[category] ?? category];
  if (!ALIAS[category]) tries.push(titleCase(category));
  for (const label of tries) {
    for (const kind of ["descriptor", "term"] as const) {
      const hits = await json<LookupHit[]>(
        `${MESH}/lookup/${kind}?label=${encodeURIComponent(label)}&match=exact&limit=1`,
      );
      if (hits?.length) return hits[0];
    }
  }
  const contains = await json<LookupHit[]>(
    `${MESH}/lookup/descriptor?label=${encodeURIComponent(ALIAS[category] ?? category)}&match=contains&limit=1`,
  );
  return contains?.length ? contains[0] : null;
}

async function enrich(category: string, papers: number): Promise<SubjectRow> {
  const hit = await findDescriptor(category);
  if (!hit) return { category, name: titleCase(category), papers, mesh: null };

  // A term hit points at a term resource; its descriptor is findable via the
  // descriptor lookup on the term's label — but term lookups already return the
  // owning descriptor's resource in practice. Guard: only D-ids are descriptors.
  const id = hit.resource.split("/").pop()!;
  if (!/^D\d+/.test(id)) return { category, name: titleCase(category), papers, mesh: null };

  const detail = await json<Record<string, unknown>>(`${MESH}/${id}.json`);
  const tn = detail?.treeNumber;
  const treeNumbers = (Array.isArray(tn) ? tn : tn ? [tn] : []).map((u) =>
    String(u).split("/").pop()!,
  );
  let scopeNote: string | null = null;
  const pc = detail?.preferredConcept;
  if (typeof pc === "string") {
    const concept = await json<Record<string, unknown>>(`${pc}.json`);
    const note = concept?.scopeNote;
    if (typeof note === "string") scopeNote = note.trim();
    else if (note && typeof note === "object" && "@value" in (note as object))
      scopeNote = String((note as Record<string, unknown>)["@value"]).trim();
  }
  return {
    category,
    name: hit.label,
    papers,
    mesh: { id, label: hit.label, treeNumbers, scopeNote },
  };
}

async function main() {
  const out: Record<string, SubjectRow[]> = {};
  for (const server of ["medrxiv", "biorxiv"] as const) {
    const cats = await json<{ value: string; record_count: number }[]>(
      `${SITE}/api/dict?type=categories&server=${server}`,
    );
    if (!cats) throw new Error(`category list failed for ${server}`);
    const rows: SubjectRow[] = [];
    for (const c of cats) {
      const row = await enrich(c.value, c.record_count);
      rows.push(row);
      console.log(
        `${server} · ${c.value} → ${row.mesh ? `${row.mesh.id} (${row.mesh.label}) [${row.mesh.treeNumbers.join(", ")}]` : "NO MESH MATCH"}`,
      );
      await new Promise((r) => setTimeout(r, 150));
    }
    out[server] = rows;
  }
  const dir = join(dirname(fileURLToPath(import.meta.url)), "../../src/data");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "subjects.json"), JSON.stringify(out, null, 1));
  const misses = Object.values(out).flat().filter((r) => !r.mesh);
  console.log(`\nwrote src/data/subjects.json — ${misses.length} unmatched:`, misses.map((m) => m.category));
}

main();
