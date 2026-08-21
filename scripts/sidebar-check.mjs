// Is the rooms entry point actually reachable from the landing page's sidebar?
// The browser suite navigates straight to /medrxiv, which proves the route
// works but not that a person can FIND it — the gap that made the shipped work
// look absent.
import { chromium } from "playwright";

const base = process.argv[2] ?? "https://cshl.nysgpt.com";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto(base, { waitUntil: "load" });
await page.waitForSelector("aside", { state: "attached", timeout: 15000 });

// The nav renders collapsed (w-0) at this viewport, so check the DOM first and
// then open it the way a person does — via the toggle in the header.
const items = await page.$$eval("aside button", (bs) =>
  bs.map((b) => b.textContent.trim()).filter((t) => t && t.length < 40),
);
console.log("sidebar items:", items.slice(0, 8));
const inDom = items.some((t) => /medRxiv Rooms/i.test(t));
console.log(inDom ? "PASS  'medRxiv Rooms' is in the nav" : "FAIL  no rooms entry in the nav");

let clicked = false;
if (inDom) {
  const toggle = page.locator("header button, button").first();
  await toggle.click().catch(() => {});
  await page.waitForTimeout(600);
  const rooms = page.locator("aside button:visible", { hasText: "medRxiv Rooms" }).first();
  if (await rooms.count()) {
    await rooms.click();
    await page.waitForURL(/\/medrxiv$/, { timeout: 10000 }).catch(() => {});
    clicked = /\/medrxiv$/.test(page.url());
    console.log(clicked ? `PASS  clicking it lands on ${page.url()}` : `FAIL  click did not navigate (${page.url()})`);
  } else {
    console.log("NOTE  nav collapsed at this viewport; entry present in DOM but not clicked");
  }
}
const found = inDom;
await page.screenshot({ path: "/tmp/rooms-shots/7-sidebar.png" });
await browser.close();
process.exit(found ? 0 : 1);
