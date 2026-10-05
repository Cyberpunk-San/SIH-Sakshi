/**
 * Records the live demo against the running demo stack: 1920x1080 stills and one
 * screen recording per scene (MP4, H.264) for editing in After Effects.
 *
 *   SAKSHI_DATA=demo/data npm run stack      # separate terminal, after npm run demo:seed
 *   npm run demo:capture
 *
 * Uses the locally installed Chrome (playwright-core, channel "chrome"); nothing is downloaded.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";

const BASE = process.env.SAKSHI_URL ?? "http://localhost:3000";
const DEMO = path.resolve("demo");
const SHOTS = path.join(DEMO, "assets", "screens");
const REC = path.join(DEMO, "assets", "recordings");
const RAW = path.join(REC, "_raw");
const PASS = "Sakshi-Demo-2026";
const VIEW = { width: 1920, height: 1080 };
const state = JSON.parse(fs.readFileSync(path.join(DEMO, "demo-state.json"), "utf8"));
const regPass = fs.readFileSync(path.join(DEMO, "data", "bootstrap", "registrar.pass"), "utf8").trim();

for (const d of [SHOTS, REC, RAW]) fs.mkdirSync(d, { recursive: true });

// A visible cursor + click ripple, since screen recordings do not include the OS pointer.
const CURSOR = `
(() => {
  const install = () => {
    if (document.getElementById('__demo_cursor')) return;
    const c = document.createElement('div');
    c.id = '__demo_cursor';
    c.style.cssText = 'position:fixed;left:0;top:0;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:rgba(236,232,222,.92);box-shadow:0 0 0 2px rgba(18,19,20,.6),0 4px 14px rgba(0,0,0,.45);z-index:2147483647;pointer-events:none;transition:transform .12s ease;transform:translate(-100px,-100px)';
    document.documentElement.appendChild(c);
    let x = -100, y = -100;
    addEventListener('mousemove', e => { x = e.clientX; y = e.clientY; c.style.transform = 'translate(' + x + 'px,' + y + 'px)'; }, true);
    addEventListener('mousedown', () => {
      c.style.transform = 'translate(' + x + 'px,' + y + 'px) scale(.75)';
      const r = document.createElement('div');
      r.style.cssText = 'position:fixed;left:' + x + 'px;top:' + y + 'px;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:50%;border:2px solid #e0705f;z-index:2147483646;pointer-events:none;transition:all .55s ease-out;opacity:1';
      document.documentElement.appendChild(r);
      requestAnimationFrame(() => { r.style.width = r.style.height = '64px'; r.style.margin = '-32px 0 0 -32px'; r.style.opacity = '0'; });
      setTimeout(() => r.remove(), 600);
    }, true);
    addEventListener('mouseup', () => { c.style.transform = 'translate(' + x + 'px,' + y + 'px)'; }, true);
  };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', install); else install();
})();`;

const ONLY = process.env.SCENES?.split(",") ?? null;
const want = (n: string) => !ONLY || ONLY.some((x) => n.startsWith(x));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function newScene(browser: Browser, name: string) {
  const ctx = await browser.newContext({
    viewport: VIEW,
    deviceScaleFactor: 1,
    colorScheme: "dark",
    recordVideo: { dir: path.join(RAW, name), size: VIEW },
    acceptDownloads: true,
  });
  await ctx.addInitScript(CURSOR);
  const page = await ctx.newPage();
  await page.mouse.move(VIEW.width / 2, VIEW.height / 2);
  return { ctx, page, name };
}

async function endScene(s: { ctx: BrowserContext; page: Page; name: string }) {
  await sleep(1200);
  const video = s.page.video();
  await s.ctx.close();
  const src = video ? await video.path() : null;
  if (!src) return;
  const out = path.join(REC, `${s.name}.mp4`);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", src, "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p", "-r", "30", out]);
  console.log(`   recording ${path.relative(process.cwd(), out)}`);
}

async function moveTo(page: Page, target: Locator) {
  await target.scrollIntoViewIfNeeded();
  const b = await target.boundingBox();
  if (!b) throw new Error("element not visible");
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 28 });
  await sleep(180);
}

async function click(page: Page, target: Locator) {
  await moveTo(page, target);
  await page.mouse.down();
  await sleep(70);
  await page.mouse.up();
  await sleep(250);
}

async function type(page: Page, target: Locator, text: string, delay = 55) {
  await click(page, target);
  await page.keyboard.type(text, { delay });
}

async function shot(page: Page, name: string, fullPage = false) {
  await sleep(400);
  // Stills are clean; only the recordings show the pointer.
  await page.evaluate(() => document.getElementById("__demo_cursor")?.style.setProperty("visibility", "hidden"));
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage });
  await page.evaluate(() => document.getElementById("__demo_cursor")?.style.setProperty("visibility", "visible"));
  console.log(`   still ${name}.png`);
}

async function slowScroll(page: Page, dy: number, ms = 1600) {
  const steps = Math.max(1, Math.round(ms / 16));
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, dy / steps);
    await sleep(16);
  }
}

/** Client-side navigation through the header, so the unlocked key stays in memory. */
async function nav(page: Page, label: string) {
  await click(page, page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: label }));
  await sleep(900);
}

async function login(page: Page, keyFile: string, passphrase: string) {
  await page.goto(`${BASE}/login`);
  await page.waitForSelector("text=Sign in with your key");
  await sleep(600);
  const importLink = page.getByText("Import a .sakshikey file");
  await moveTo(page, importLink);
  await page.locator('input[type="file"]').setInputFiles(path.join(DEMO, "keys", keyFile));
  await sleep(700);
  await type(page, page.locator('input[type="password"]'), passphrase, 45);
  await sleep(300);
  await click(page, page.getByRole("button", { name: "Sign in" }));
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30000 });
  await sleep(1200);
}

async function main() {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  console.log("capturing against", BASE);

  // 01 — landing
  if (want("01_landing")) {
    const s = await newScene(browser, "01_landing");
    await s.page.goto(BASE);
    await s.page.waitForSelector("text=Every copy looks the same.");
    await sleep(2500);
    await shot(s.page, "01_landing_hero");
    await slowScroll(s.page, 640, 2200);
    await sleep(1500);
    await shot(s.page, "02_landing_how_it_works");
    await slowScroll(s.page, 600, 1800);
    await sleep(1500);
    await shot(s.page, "03_landing_limits");
    await endScene(s);
  }

  // 02 — registrar certifies a new member
  if (want("02_registrar_certifies")) {
    const s = await newScene(browser, "02_registrar_certifies");
    await login(s.page, "registrar.sakshikey", regPass);
    await s.page.waitForSelector("text=Pending enrolments");
    await sleep(1500);
    await shot(s.page, "04_registry_pending");
    const approve = s.page.getByRole("button", { name: "Sign certificate" }).first();
    if (await approve.count()) {
      await click(s.page, approve);
      await s.page.waitForSelector("text=committed in block", { timeout: 30000 });
      await sleep(1800);
      await shot(s.page, "05_registry_certified");
    }
    await slowScroll(s.page, 500, 1500);
    await sleep(1500);
    await shot(s.page, "06_registry_identities");
    await endScene(s);
  }

  // 03 — sender distributes an annex to the committee
  if (want("03_sender_distributes")) {
    const s = await newScene(browser, "03_sender_distributes");
    await login(s.page, "anita.desai.sakshikey", PASS);
    await nav(s.page, "Distribute");
    await s.page.waitForSelector("text=Distribute a document");
    await sleep(1200);
    await moveTo(s.page, s.page.getByText("Drop a PDF or image"));
    await s.page.locator('input[type="file"]').first().setInputFiles(path.join(DEMO, "source", "Coastal-Radar-Phase-II-Brief.pdf"));
    await sleep(900);
    const title = s.page.locator("input").nth(1);
    await title.fill("");
    await type(s.page, title, "Annex B - Risk register and revised schedule", 35);
    for (const name of ["Cdr. Arjun Mehta", "Dr. Kavya Rao", "Rahul Verma", "Priya Nair", "Sanjay Kulkarni"]) {
      await click(s.page, s.page.locator("label", { hasText: name }).locator('input[type="checkbox"]'));
      await sleep(150);
    }
    await sleep(800);
    await shot(s.page, "07_send_ready");
    await click(s.page, s.page.getByRole("button", { name: "Encrypt & distribute" }));
    await s.page.waitForSelector("text=Distributed", { timeout: 60000 });
    await sleep(2000);
    await shot(s.page, "08_send_done");
    await endScene(s);
  }

  // 04 — recipient opens the brief (a new, uniquely watermarked session)
  if (want("04_recipient_opens")) {
    const s = await newScene(browser, "04_recipient_opens");
    await login(s.page, "rahul.verma.sakshikey", PASS);
    await s.page.waitForSelector("text=Documents addressed to you");
    await sleep(1500);
    await shot(s.page, "09_inbox");
    const row = s.page.locator("li", { hasText: "Phase II Procurement Brief" });
    await click(s.page, row.getByRole("button", { name: "Decrypt & open" }));
    await sleep(900);
    await shot(s.page, "10_inbox_decrypting");
    await s.page.waitForSelector("text=Witness record", { timeout: 90000 });
    await sleep(2500);
    await shot(s.page, "11_opened_with_witness_record");
    await moveTo(s.page, s.page.getByText("Gateway timeline"));
    await sleep(2000);
    await endScene(s);
  }

  // 05 — sender's access log
  if (want("05_access_log")) {
    const s = await newScene(browser, "05_access_log");
    await login(s.page, "anita.desai.sakshikey", PASS);
    await nav(s.page, "Access log");
    await click(s.page, s.page.getByRole("button", { name: /Phase II Procurement Brief/ }));
    await s.page.waitForSelector("text=receipt signed", { timeout: 30000 });
    await sleep(2000);
    await shot(s.page, "12_access_log");
    await endScene(s);
  }

  // 06 — investigator traces the chat screenshot
  if (want("06_forensics_trace")) {
    const s = await newScene(browser, "06_forensics_trace");
    await login(s.page, "vikram.singh.sakshikey", PASS);
    await s.page.waitForSelector("text=Trace a leaked copy");
    await sleep(1500);
    await shot(s.page, "13_forensics_empty");
    await moveTo(s.page, s.page.getByText("Drop the leaked file here"));
    await s.page.locator('input[type="file"]').setInputFiles(path.join(DEMO, "leak", "chat-screenshot.jpg"));
    await sleep(600);
    await shot(s.page, "14_forensics_analysing");
    await s.page.waitForSelector("text=Attributed · cryptographically verified", { timeout: 120000 });
    await sleep(2500);
    await shot(s.page, "15_forensics_verdict");
    await slowScroll(s.page, 560, 2200);
    await sleep(2500);
    await shot(s.page, "16_forensics_checks");
    await endScene(s);
  }

  // 07 — ledger, full-chain verification in the browser, then a live tamper attempt
  if (want("07_ledger_and_tamper")) {
    const s = await newScene(browser, "07_ledger_and_tamper");
    await s.page.goto(`${BASE}/ledger`);
    await s.page.waitForSelector("text=Ledger & validators");
    await sleep(2500);
    await shot(s.page, "17_ledger");
    await click(s.page, s.page.getByRole("button", { name: "Verify full chain here" }).first());
    await s.page.waitForSelector("text=state transition verified", { timeout: 120000 });
    await sleep(1500);
    await shot(s.page, "18_ledger_verified");
    execFileSync(process.execPath, ["--import", "tsx", "scripts/tamper-demo.ts", "--node", "v3"], { env: { ...process.env, SAKSHI_DATA: path.join(DEMO, "data") }, stdio: "inherit" });
    await s.page.waitForSelector("text=Integrity incidents", { timeout: 30000 });
    await sleep(800);
    await moveTo(s.page, s.page.getByText("Integrity incidents"));
    await sleep(2500);
    await shot(s.page, "19_ledger_tamper_detected");
    await slowScroll(s.page, 600, 2000);
    await sleep(1500);
    await shot(s.page, "20_ledger_blocks");
    await endScene(s);
  }

  await browser.close();
  fs.rmSync(RAW, { recursive: true, force: true });
  console.log("done");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
