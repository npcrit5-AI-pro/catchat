import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pwPkg = [process.env.PLAYWRIGHT_PKG, "/tmp/pw/node_modules/playwright/package.json", path.join(ROOT, "node_modules/playwright/package.json")].find(p => p && fs.existsSync(p));
if (!pwPkg) throw new Error("Install playwright before running test/browser.mjs");
const { chromium } = createRequire(pwPkg)("playwright");
const OUT = process.env.SHOTS || path.join(os.tmpdir(), "catchat-shots");
fs.mkdirSync(OUT, {recursive: true});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < w; x++) {
      const o = row + 1 + x * 4;
      raw[o] = (x * 3) % 256; raw[o + 1] = (y * 4) % 256; raw[o + 2] = 180; raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))
  ]);
}

const picture = path.join(OUT, "sample.png");
fs.writeFileSync(picture, png(320, 180));
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 12000) {
  const start = Date.now(); let last = "";
  while (Date.now() - start < ms) {
    try { if (await fn()) return; } catch (e) { last = e.message || String(e); }
    await sleep(80);
  }
  throw new Error("timed out " + last);
}
async function shot(page, name) {
  await page.evaluate(() => { const t = document.querySelector("#toast"); if (t) t.style.display = "none"; });
  const file = path.join(OUT, name);
  await page.screenshot({path: file, fullPage: false});
  console.log("screenshot", file);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catchat-browser-"));
const port = 18940 + (process.pid % 200);
const child = spawn(process.execPath, ["--no-warnings", "server.js"], {
  cwd: ROOT,
  env: {...process.env, PORT: String(port), DATA_DIR: dir, ADMIN_PASSWORD: "test-admin-pw", SUPABASE_URL: "", SUPABASE_SERVICE_KEY: ""},
  stdio: ["ignore", "pipe", "pipe"]
});
let log = "";
child.stdout.on("data", d => { log += d; });
child.stderr.on("data", d => { log += d; });
const base = "http://127.0.0.1:" + port;
try {
  await waitFor(() => log.includes("listening on"));
  const browser = await chromium.launch({headless: true});
  const A = await browser.newContext({viewport: {width: 1280, height: 820}, colorScheme: "light"});
  const B = await browser.newContext({viewport: {width: 1280, height: 820}, colorScheme: "light"});
  const nori = await A.newPage();
  const katsu = await B.newPage();
  async function signup(page, name, pw) {
    await page.goto(base);
    await page.locator("#nm").fill(name);
    await page.locator("#pw").fill(pw);
    await page.locator("#lf button").click();
    await waitFor(async () => page.locator("#bal").isVisible() && (await page.locator("#bal").innerText()).includes("coins"));
  }
  await signup(nori, "Nori", "nori-pass");
  await signup(katsu, "Katsu", "katsu-pass");

  const system = await browser.newContext({viewport: {width: 1280, height: 820}, colorScheme: "dark"});
  const sysPage = await system.newPage();
  await sysPage.goto(base);
  const sysBg = (await sysPage.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg"))).trim();
  if (sysBg !== "#12141c") throw new Error("system dark default failed: " + sysBg);
  if (await sysPage.evaluate(() => document.documentElement.dataset.theme || "")) throw new Error("system mode should not set data-theme");

  await nori.locator("#msg").click();
  await nori.locator("#msg").pressSequentially("Hello from Nori", {delay: 15});
  await nori.locator("#msg").press("Enter");
  await waitFor(async () => (await katsu.locator("#log").innerText()).includes("Hello from Nori"));
  const bubble = katsu.locator(".mw", {hasText: "Hello from Nori"}).first();
  await bubble.locator("[data-menu]").click();
  await bubble.locator("[data-reply]").click();
  await katsu.locator("#msg").fill("I saw that");
  await katsu.locator("#sendbtn").click();
  await waitFor(async () => (await nori.locator("#log").innerText()).includes("I saw that"));
  const mine = nori.locator(".mw", {hasText: "Hello from Nori"}).first();
  await mine.locator("[data-menu]").click();
  await mine.locator("[data-reactopen]").click();
  await mine.locator('[data-e="3"]').click();
  await waitFor(async () => (await katsu.locator("#log").innerText()).includes("🐱"));

  await nori.locator("#msg").click();
  await nori.locator("#msg").fill("");
  await nori.locator("#msg").pressSequentially("@Kat", {delay: 40});
  await waitFor(async () => nori.locator("#ac").isVisible());
  await shot(nori, "light_mentions.png");
  await nori.locator("#ac button", {hasText: "Katsu"}).click();
  const mentioned = await nori.locator("#msg").inputValue();
  if (!mentioned.startsWith("@Katsu ")) throw new Error("autocomplete inserted " + mentioned);
  await nori.locator("#msg").pressSequentially("come here", {delay: 10});
  await sleep(520);
  await nori.locator("#sendbtn").click();
  await waitFor(async () => (await katsu.locator("#mcount").textContent()) !== "0");
  await waitFor(async () => (await katsu.locator(".mention.me").count()) > 0);

  const rootCtx = await browser.newContext({viewport: {width: 1280, height: 820}, colorScheme: "light"});
  const root = await rootCtx.newPage();
  await signup(root, "meowmaster100", "test-admin-pw");
  const pinMsg = root.locator(".mw", {hasText: "Hello from Nori"}).first();
  await pinMsg.locator("[data-menu]").click();
  await pinMsg.locator("[data-pin]").click();
  await waitFor(async () => (await nori.locator("#pins").innerText()).includes("Pinned"));
  await shot(nori, "light_chat.png");

  await katsu.locator("#msg").click();
  await katsu.locator("#msg").fill("typing now");
  await waitFor(async () => (await nori.locator("#typing").innerText()).includes("Katsu"));
  await shot(nori, "light_typing.png");
  await katsu.locator("#msg").fill("");

  async function stage(page, how) {
    const b64 = fs.readFileSync(picture).toString("base64");
    await page.evaluate(async ({b64, how}) => {
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const file = new File([arr], how + ".png", {type: "image/png"});
      const dt = new DataTransfer();
      dt.items.add(file);
      if (how === "drop") {
        const ev = new DragEvent("drop", {bubbles: true, cancelable: true});
        Object.defineProperty(ev, "dataTransfer", {value: dt});
        document.dispatchEvent(ev);
      } else {
        const ev = new ClipboardEvent("paste", {bubbles: true, cancelable: true});
        Object.defineProperty(ev, "clipboardData", {value: dt});
        document.dispatchEvent(ev);
      }
    }, {b64, how});
  }
  await stage(nori, "drop");
  await waitFor(async () => nori.locator("#pending").isVisible());
  await nori.locator("#cancel-pic").click();
  await stage(nori, "paste");
  await waitFor(async () => nori.locator("#pending").isVisible());
  await nori.locator("#cancel-pic").click();
  await nori.locator("#file").setInputFiles(picture);
  await waitFor(async () => nori.locator("#pending").isVisible());
  await nori.locator("#msg").fill("look at this");
  await sleep(520);
  await nori.locator("#sendbtn").click();
  await waitFor(async () => (await katsu.locator("#log img").count()) > 0);
  const natural = await katsu.locator("#log img").first().evaluate(img => img.naturalWidth);
  if (!(natural > 10)) throw new Error("inline image did not decode");
  await katsu.locator("[data-zoom]").first().click();
  await waitFor(async () => katsu.locator("#lightbox").isVisible());
  await shot(katsu, "light_lightbox.png");
  await katsu.keyboard.press("Escape");

  await sleep(600);
  await nori.locator("#pollbtn").click();
  await nori.locator("#pq").fill("Fish or yarn?");
  const opts = nori.locator("#popts input");
  await opts.nth(0).fill("Fish");
  await opts.nth(1).fill("Yarn");
  await nori.locator("#modal-ok").click();
  await waitFor(async () => (await katsu.locator("#polls").innerText()).includes("Fish or yarn?"));
  await katsu.locator(".poll-opt", {hasText: "Fish"}).click();
  await nori.locator(".poll-opt", {hasText: "Yarn"}).click();
  await waitFor(async () => (await nori.locator("#polls").innerText()).includes("2 votes"));
  await nori.locator(".poll-opt", {hasText: "Fish"}).click();
  await waitFor(async () => {
    const t = await katsu.locator(".poll-opt", {hasText: "Fish"}).innerText();
    return t.includes("2");
  });
  await shot(nori, "light_poll.png");

  await nori.locator("nav button", {hasText: "Shop"}).click();
  await nori.locator("#sf input[name=name]").fill("Bell");
  await nori.locator("#sf input[name=emoji]").fill("🔔");
  await nori.locator("#sf input[name=price]").fill("8");
  await nori.locator("#sf button").click();
  await waitFor(async () => (await nori.locator("#shoplist").innerText()).includes("Bell"));
  await shot(nori, "light_shop.png");
  await katsu.locator("nav button", {hasText: "Shop"}).click();
  await waitFor(async () => (await katsu.locator("#shoplist").innerText()).includes("Bell"));
  await katsu.locator("[data-buy]").click();
  await katsu.locator("nav button", {hasText: "Chat"}).click();
  await waitFor(async () => (await katsu.locator("#log").innerText()).includes("bought"));

  await nori.locator("nav button", {hasText: "Chat"}).click();
  const mine2 = nori.locator(".mw", {hasText: "Hello from Nori"}).first();
  await mine2.locator("[data-menu]").click();
  await mine2.locator("[data-edit]").click();
  await nori.locator("#msg").fill("Hello from Nori, edited");
  await nori.locator("#sendbtn").click();
  await waitFor(async () => (await katsu.locator("#log").innerText()).includes("edited"));
  const replyBubble = katsu.locator(".mw", {hasText: "I saw that"}).first();
  await replyBubble.locator("[data-menu]").click();
  await replyBubble.locator("[data-delown]").click();
  await katsu.locator("#modal-ok").click();
  await waitFor(async () => (await nori.locator("#log").innerText()).includes("Message deleted"));

  await katsu.locator("nav button", {hasText: "Chat"}).click();
  await katsu.locator(".mw", {hasText: "Hello from Nori"}).first().locator("[data-menu]").click();
  await katsu.locator("[data-report=message]").click();
  await katsu.locator("#reason").fill("This is a test report");
  await katsu.locator("#modal-ok").click();
  await root.locator("nav button", {hasText: "Admin"}).click();
  await waitFor(async () => (await root.locator("#p-admin").innerText()).includes("This is a test report"));

  await nori.locator("#theme").click();
  await waitFor(async () => (await nori.evaluate(() => document.documentElement.dataset.theme)) === "dark");
  const darkBg = (await nori.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg"))).trim();
  if (darkBg !== "#12141c") throw new Error("dark toggle failed " + darkBg);
  await nori.reload();
  await waitFor(async () => nori.locator("#log").isVisible());
  if ((await nori.evaluate(() => localStorage.getItem("meow-theme"))) !== "dark") throw new Error("theme was not saved");
  await shot(nori, "dark_chat.png");
  await root.locator("#theme").click();
  await waitFor(async () => (await root.evaluate(() => document.documentElement.dataset.theme)) === "dark");
  await shot(root, "dark_reports.png");
  await root.locator("[data-dismiss]").click();
  await waitFor(async () => (await root.locator("#p-admin").innerText()).includes("No open reports"));

  await nori.locator("#theme").click();
  await waitFor(async () => (await nori.evaluate(() => document.documentElement.dataset.theme)) === "light");
  const lightBg = (await nori.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg"))).trim();
  if (lightBg !== "#f4f0e8") throw new Error("light toggle failed " + lightBg);

  await nori.setViewportSize({width: 390, height: 844});
  await nori.locator("nav button", {hasText: "Chat"}).click();
  await shot(nori, "mobile_chat.png");

  await sleep(520);
  await nori.locator("#msg").fill("<img src=x onerror=alert(1)>");
  await nori.locator("#sendbtn").click();
  await waitFor(async () => (await nori.locator("#log").innerText()).includes("onerror"));
  if (await nori.locator("#log img[src='x']").count()) throw new Error("image markup was not escaped");
  if (await nori.locator("#log script").count()) throw new Error("script markup was not escaped");
  const xss = await nori.locator("#log").innerHTML();
  if (!xss.includes("&lt;img")) throw new Error("expected the picture tag to be escaped");
  await browser.close();
  console.log("browser checks passed");
} finally {
  child.kill("SIGTERM");
  await new Promise(r => { const t = setTimeout(() => { child.kill("SIGKILL"); r(); }, 4000); child.once("exit", () => { clearTimeout(t); r(); }); });
}
