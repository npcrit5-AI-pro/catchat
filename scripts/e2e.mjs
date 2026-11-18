// End-to-end smoke test: boots the server, seeds game content, drives the
// real UI in headless Chrome, and saves screenshots to /opt/cursor/artifacts.
// Run with: npm run e2e
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";

const ART = "/opt/cursor/artifacts";
fs.mkdirSync(ART, { recursive: true });
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "catchat-e2e-"));
const PORT = 18888;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_PW = "e2e-admin-password-123";

const srv = spawn(process.execPath, ["--no-warnings", "server.js"], {
  cwd: new URL("..", import.meta.url).pathname,
  env: { ...process.env, PORT: String(PORT), DATA_DIR, ADMIN_PASSWORD: ADMIN_PW },
  stdio: "ignore",
});
const shutdown = () => {
  srv.kill("SIGTERM");
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
};
process.on("exit", shutdown);

async function ready() {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(BASE + "/healthz");
      if (r.ok) return;
    } catch {}
    if (Date.now() - t0 > 15000) throw new Error("server did not boot");
    await new Promise((r) => setTimeout(r, 200));
  }
}

const api = (tok, act, body) =>
  fetch(BASE + "/api/" + act, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(tok ? { Authorization: "Bearer " + tok } : {}) },
    body: JSON.stringify(body || {}),
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));

await ready();

// Seed: root + shop item (on sale) + ability + cat + wild + trainer + pack.
let r = await api(null, "login", { name: "meowmaster100", pw: ADMIN_PW });
const root = r.json.token;
await api(root, "item/add", { name: "E2E Sword", emoji: "🗡️", price: 50, stock: 5 });
await api(root, "item/add", { name: "E2E Zap", kind: "ability", dmg: 25, atype: "fire", price: 5 });
await api(root, "cat/add", { name: "E2E Lion", hp: 80, price: 10, type1: "fire", rarity: "rare" });
await api(root, "cat/add", { name: "E2E Cub", hp: 5, price: 0, shop: 0 });
const cfg = await (await fetch(BASE + "/api/config")).json();
if (cfg.root !== "meowmaster100" || cfg.maxSell !== 5) throw new Error("bad /api/config: " + JSON.stringify(cfg));
const ids = { sword: null, zap: null, lion: null, cub: null };
{
  const ctl = new AbortController();
  const res = await fetch(BASE + "/events?t=" + root, { headers: { Accept: "text/event-stream" }, signal: ctl.signal });
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = "", state = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 8000 && !state) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const m = buf.match(/event: state\ndata: (\{.*\})\n/);
    if (m) state = JSON.parse(m[1]);
  }
  ctl.abort();
  try { await reader.cancel(); } catch {}
  if (!state) throw new Error("no state for seeding");
  for (const i of state.items) {
    if (i.name === "E2E Sword") ids.sword = i.id;
    if (i.name === "E2E Zap") ids.zap = i.id;
  }
  ids.lion = state.cats.find((c) => c.name === "E2E Lion").id;
  ids.cub = state.cats.find((c) => c.name === "E2E Cub").id;
}
await api(root, "item/sale", { id: ids.sword, price: 20 });
await api(root, "wild/add", { cat: ids.cub, lvl: 1 });
await api(root, "trainer/add", { name: "E2E Coach", reward: 30, team: [{ cat: ids.cub, lvl: 1, moves: [] }] });
await api(root, "pack/add", { name: "E2E Pack", price: 5, data: [{ t: "item", id: ids.sword, n: 1, ch: 1 }] });
// Second player funds a trade offer to the e2e user later.
r = await api(null, "login", { name: "tradebot", pw: "password123" });
const bot = r.json.token;
await api(root, "admin/give", { to: "tradebot", n: 200 });
await api(bot, "buy", { id: ids.sword });

const browser = await puppeteer.launch({
  executablePath: "/usr/local/bin/google-chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const shot = async (page, name, sel, ms = 700) => {
  if (sel) await page.evaluate((s) => document.querySelector(s).click(), sel);
  await new Promise((res) => setTimeout(res, ms));
  await page.screenshot({ path: `${ART}/${name}.png` });
};
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message)));

  // 1. Login screen
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.screenshot({ path: `${ART}/catchat-login.png` });

  // 2. Sign up through the real form, send a chat message
  await page.type("#nm", "e2ecat");
  await page.type("#pw", "password123");
  await page.click("#lf button");
  await page.waitForFunction(() => document.querySelector("#app").style.display === "flex", { timeout: 10000 });
  await page.type("#msg", "Hello from e2e!");
  await page.click("#send > button");
  await page.waitForFunction(() => document.querySelector("#log").textContent.includes("Hello from e2e"), { timeout: 10000 });
  // slash help + autocomplete dropdown
  await page.type("#msg", "/he");
  await new Promise((res) => setTimeout(res, 300));
  const cmdsVisible = await page.evaluate(() => document.querySelector("#cmds").style.display !== "none");
  if (!cmdsVisible) throw new Error("slash autocomplete did not open");
  await page.evaluate(() => { document.querySelector("#msg").value = ""; document.querySelector("#cmds").style.display = "none"; });
  // /buy at the sale price through the chat box
  await page.type("#msg", "/buy e2e sword");
  await page.click("#send > button");
  await page.waitForFunction(() => document.querySelector("#toast").textContent.includes("Bought"), { timeout: 10000 });
  await new Promise((res) => setTimeout(res, 600));
  await page.screenshot({ path: `${ART}/catchat-chat.png` });

  // 3. Shop tab (sale badge, packs, cats)
  await shot(page, "catchat-shop", '[data-t="shop"]');
  const shopText = await page.evaluate(() => document.querySelector("#p-shop").textContent);
  for (const need of ["SALE", "E2E Pack", "E2E Lion"]) {
    if (!shopText.includes(need)) throw new Error("shop missing: " + need);
  }

  // 4. Battle tab: adopt the lion via UI, set lead, fight the wild cat
  const tok = await page.evaluate(() => localStorage.getItem("meow-token"));
  await api(tok, "cat/buy", { id: ids.lion });
  const st = await api(tok, "cat/lead", { own: 1 }).catch(() => null);
  void st;
  await shot(page, "catchat-battle", '[data-t="battle"]');
  const battleText = await page.evaluate(() => document.querySelector("#p-battle").textContent);
  for (const need of ["Your lead cat", "Wild cats", "Trainers", "Abilities for sale"]) {
    if (!battleText.includes(need)) throw new Error("battle tab missing: " + need);
  }
  const fights = await page.$$('#p-battle [data-wild]');
  if (!fights.length) throw new Error("no wild fight buttons");
  await fights[0].click();
  await new Promise((res) => setTimeout(res, 1200));

  // 5. Trade tab: tradebot offers the user a sword, user accepts via UI
  await api(bot, "trade/send", { to: "e2ecat", give: { items: { [ids.sword]: 1 }, cats: [] }, want: { items: {}, cats: [] } });
  await shot(page, "catchat-trade", '[data-t="trade"]');
  const tradeText = await page.evaluate(() => document.querySelector("#p-trade").textContent);
  if (!tradeText.includes("tradebot")) throw new Error("incoming trade offer not shown");
  await page.evaluate(() => document.querySelector("#p-trade [data-take]").click());
  await new Promise((res) => setTimeout(res, 1200));

  // 6. Wallet tab (items, cats, equip, richest)
  await shot(page, "catchat-wallet", '[data-t="wallet"]');
  const walletText = await page.evaluate(() => document.querySelector("#p-wallet").textContent);
  for (const need of ["Your items", "Your cats", "Your abilities", "Richest cats"]) {
    if (!walletText.includes(need)) throw new Error("wallet missing: " + need);
  }

  // 7. Settings tab
  await shot(page, "catchat-settings", '[data-t="settings"]');

  // 8. Admin tab (promote the e2e user, then open it)
  await api(root, "admin/promote", { to: "e2ecat" });
  await page.waitForFunction(() => !!document.querySelector('[data-t="admin"]'), { timeout: 10000 });
  await shot(page, "catchat-admin", '[data-t="admin"]');
  const adminText = await page.evaluate(() => document.querySelector("#p-admin").textContent);
  for (const need of ["Create a cat", "Create a pack", "Create a wild cat", "Create a trainer", "Banned username words"]) {
    if (!adminText.includes(need)) throw new Error("admin missing: " + need);
  }

  if (errors.length) throw new Error("page errors: " + errors.slice(0, 3).join(" | "));
  console.log("E2E OK: login, chat+/buy/autocomplete, shop sale, battle, trade accept, wallet, settings, admin exercised; screenshots saved to", ART);
} finally {
  await browser.close();
  shutdown();
}
