// End-to-end smoke test: boots the server, drives the real UI in headless
// Chrome (system install), and saves screenshots to /opt/cursor/artifacts.
// Run with: node scripts/e2e.mjs
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

await ready();
const browser = await puppeteer.launch({
  executablePath: "/usr/local/bin/google-chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on("pageerror", (e) => console.error("page error:", e.message));

  // 1. Login screen
  await page.goto(BASE, { waitUntil: "networkidle0" });
  await page.screenshot({ path: `${ART}/catchat-login.png` });

  // 2. Sign up a fresh user through the real form
  const name = "e2ecat";
  await page.type("#nm", name);
  await page.type("#pw", "password123");
  await page.click("#lf button");
  await page.waitForFunction(() => document.querySelector("#app").style.display === "flex", {
    timeout: 10000,
  });

  // 3. Send a chat message through the real form
  await page.type("#msg", "Hello from e2e! /pay test (this slash text stays a message)");
  await page.click("#send button");
  await page.waitForFunction(() => document.querySelector("#log").textContent.includes("Hello from e2e"), {
    timeout: 10000,
  });
  await new Promise((r) => setTimeout(r, 500));
  await page.screenshot({ path: `${ART}/catchat-chat.png` });

  // 4. Shop tab
  await page.evaluate(() => document.querySelector('[data-t="shop"]').click());
  await new Promise((r) => setTimeout(r, 500));
  await page.screenshot({ path: `${ART}/catchat-shop.png` });

  // 5. Wallet tab
  await page.evaluate(() => document.querySelector('[data-t="wallet"]').click());
  await new Promise((r) => setTimeout(r, 500));
  await page.screenshot({ path: `${ART}/catchat-wallet.png` });

  // 6. Settings tab
  await page.evaluate(() => document.querySelector('[data-t="settings"]').click());
  await new Promise((r) => setTimeout(r, 500));
  await page.screenshot({ path: `${ART}/catchat-settings.png` });

  // 7. API-level assertions through the same session
  const token = await page.evaluate(() => localStorage.getItem("meow-token"));
  if (!token) throw new Error("no auth token in localStorage");
  const api = (act, body) =>
    fetch(BASE + "/api/" + act, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify(body || {}),
    }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));
  const daily = await api("daily");
  if (daily.status !== 200) throw new Error("daily bonus failed: " + JSON.stringify(daily));
  const bad = await api("send", { text: "" });
  if (bad.status !== 400) throw new Error("empty message should be rejected");

  console.log("E2E OK: login, chat, shop, wallet, settings exercised; screenshots saved to", ART);
} finally {
  await browser.close();
  shutdown();
}
