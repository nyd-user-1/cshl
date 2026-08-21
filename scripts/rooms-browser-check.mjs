// Browser spot-check for the rooms product (LANE-MEDRXIV-ROOMS §6).
//
//   npx playwright ... / node scripts/rooms-browser-check.mjs [baseUrl]
//
// Drives the flow a person actually takes — /medrxiv, /medrxiv/cards, click a
// card, ask a question, read one full answer — in a real Chromium, and asserts
// what the lane requires: honest card copy, a visible room chip, a scoped
// placeholder, and a grounded answer. Page-load timings are printed so the
// under-1-second constraint is measured, not assumed.
import { chromium } from "playwright";

const base = process.argv[2] ?? "http://localhost:3999";
const shots = "/tmp/rooms-shots";
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));

async function go(path) {
  const t0 = Date.now();
  await page.goto(base + path, { waitUntil: "load" });
  return Date.now() - t0;
}

// 1. /medrxiv — the bucket landing. Scope the h1 to the routed page: the
// sidebar carries its own <h1>RxivGPT</h1> and matches a bare "h1" first.
let ms = await go("/medrxiv");
const pageH1 = page.locator("main h1, h1.text-2xl").first();
await pageH1.waitFor({ timeout: 15000 });
const h1 = await pageH1.textContent();
check("/medrxiv loads", h1?.toLowerCase().includes("medrxiv"), `${ms}ms, h1="${h1}"`);

// the stat tiles must fill in with real numbers, not sit on the "—" placeholder
await page.waitForFunction(
  () => !/Preprints\s*—/.test(document.body.innerText),
  { timeout: 20000 },
);
const stats = await page.textContent("body");
check(
  "landing stats show real counts",
  stats.includes("87,567") && /Rooms\s*51/.test(stats.replace(/\s+/g, " ")),
  "87,567 preprints / 51 rooms",
);
await page.screenshot({ path: `${shots}/1-home.png` });

// 2. /preprints must redirect, never 404. The redirect is client-side, so wait
// for it rather than reading the URL the instant `load` fires.
await go("/preprints");
await page.waitForURL(/\/medrxiv$/, { timeout: 10000 }).catch(() => {});
check("/preprints redirects to /medrxiv", new URL(page.url()).pathname === "/medrxiv", page.url());

// 3. /medrxiv/cards — the catalog
ms = await go("/medrxiv/cards");
await page.waitForSelector("text=/Searches [\\d,]+/", { timeout: 15000 });
const cards = await page.locator("button:has(h2)").count();
check("card catalog renders 51 rooms", cards === 51, `${ms}ms, ${cards} cards`);

const bodyText = await page.textContent("body");
check(
  "card copy shows real counts",
  bodyText.includes("Searches 12,697 infectious diseases preprints") &&
    bodyText.includes("Searches 5,879 neurology preprints"),
  "infectious diseases 12,697 / neurology 5,879",
);
check(
  "no card claims to be a separately trained model",
  !/\b(fine-?tuned|trained)\b.*\bmodel\b/i.test(bodyText),
  "no per-card model claim",
);
await page.screenshot({ path: `${shots}/2-cards.png`, fullPage: false });

// 4. card → scoped chat
await page.locator("button:has(h2)", { hasText: "neurology" }).first().click();
await page.waitForURL(/\/medrxiv\/rooms\//, { timeout: 10000 });
check("card click lands in a room", /\/medrxiv\/rooms\/neurology/.test(page.url()), page.url());

await page.waitForSelector("textarea");
const placeholder = await page.getAttribute("textarea", "placeholder");
check("placeholder names the room", /neurology/i.test(placeholder ?? ""), `"${placeholder}"`);

const chipText = await page.textContent("body");
check("room chip is visible", /NEUROLOGY|neurology/.test(chipText) && chipText.includes("medRxiv room"), "chip present");
await page.screenshot({ path: `${shots}/3-room-empty.png` });

// 5. one full answer, in-room
await page.fill("textarea", "What do these preprints say about stroke rehabilitation outcomes?");
await page.keyboard.press("Enter");
// wait for streaming to finish: the footer buttons only render once done
await page.waitForSelector('button[title="Copy response"]', { timeout: 180000 });
const answer = await page.locator(".mb-6.max-w-\\[720px\\]").last().textContent();
check("answer is non-trivial", (answer?.length ?? 0) > 400, `${answer?.length} chars`);
check(
  "answer has no invented section scaffolding",
  !/^#{1,4} /m.test(answer ?? ""),
  "no markdown headings",
);
check(
  "answer does not assert peer-review status",
  !/\b(has been|was) peer[- ]reviewed\b|\bnot yet published\b/i.test(answer ?? ""),
  "no publication-status assertion",
);
await page.screenshot({ path: `${shots}/4-answer.png`, fullPage: true });

// 6. sources panel — full-text badges and receipts
const srcBtn = page.locator('button[title$="sources"], button[title$="source"]').first();
if (await srcBtn.count()) {
  await srcBtn.click();
  await page.waitForTimeout(800);
  const panel = await page.textContent("body");
  check("sources panel lists preprints", /Preprints/.test(panel), "sources open");
  await page.screenshot({ path: `${shots}/5-sources.png`, fullPage: true });
} else {
  check("sources panel lists preprints", false, "sources button not found");
}

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
console.log(`screenshots in ${shots}`);
process.exit(failed.length ? 1 : 0);
