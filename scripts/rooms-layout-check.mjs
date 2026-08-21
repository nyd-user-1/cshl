// Is the "Keep reading" follow-up row actually reachable, or hidden behind the
// pinned composer? The full-page screenshot of a nested scroll container makes
// clipped and un-clipped look identical, so measure the real geometry.
import { chromium } from "playwright";

const base = process.argv[2] ?? "http://localhost:3999";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

await page.goto(`${base}/medrxiv/rooms/neurology`);
await page.waitForSelector("textarea");
await page.fill("textarea", "What do these preprints say about stroke rehabilitation outcomes?");
await page.keyboard.press("Enter");
await page.waitForSelector('button[title="Copy response"]', { timeout: 180000 });
await page.waitForSelector("text=Keep reading", { timeout: 30000 });

// No manual scrolling: a reader who just watched the answer stream is already
// at the bottom, and the app is responsible for keeping the follow-ups on
// screen when they arrive. Give the re-pin a moment to run.
await page.waitForTimeout(1500);

const geom = await page.evaluate(() => {
  const label = [...document.querySelectorAll("p")].find((p) => /Keep reading/i.test(p.textContent ?? ""));
  const block = label?.parentElement;                 // the whole follow-up section
  const composer = document.querySelector("textarea")?.closest(".rounded-2xl");
  const pane = document.querySelector(".flex-1.overflow-y-auto");
  const r = block?.getBoundingClientRect();
  const c = composer?.getBoundingClientRect();
  const p = pane?.getBoundingClientRect();
  return r && c && p
    ? {
        rows: block.querySelectorAll("a").length,
        blockTop: Math.round(r.top), blockBottom: Math.round(r.bottom),
        paneBottom: Math.round(p.bottom), composerTop: Math.round(c.top),
      }
    : null;
});

console.log("geometry:", geom);
// EVERY follow-up row must be fully visible: above the composer and inside the
// scroll pane. Checking only the block's top is what let the clipped version
// pass the first time.
const ok =
  geom && geom.rows >= 1 &&
  geom.blockBottom <= geom.composerTop + 1 &&
  geom.blockBottom <= geom.paneBottom + 1;
console.log(ok ? `PASS  all ${geom.rows} follow-up rows fully visible above the composer`
               : "FAIL  follow-up rows are clipped or overlapped");
await page.screenshot({ path: "/tmp/rooms-shots/6-followups.png" });
await browser.close();
process.exit(ok ? 0 : 1);
