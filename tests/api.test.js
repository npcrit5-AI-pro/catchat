// Core API tests for CatChat. Run with: npm test
// Spins up the real server (fresh temp DATA_DIR) and exercises auth, chat,
// coins, shop, avatars, and admin flows over HTTP.
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ADMIN_PW = "test-admin-password-123";
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "catchat-test-"));
const PORT = 18080 + (process.pid % 1000);
const BASE = `http://127.0.0.1:${PORT}`;

let srv;
async function waitForHealth() {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(BASE + "/healthz");
      if (r.ok && (await r.text()) === "ok") return;
    } catch {}
    if (Date.now() - t0 > 15000) throw new Error("server did not boot");
    await new Promise((r) => setTimeout(r, 200));
  }
}

before(async () => {
  srv = spawn(process.execPath, ["--no-warnings", "server.js"], {
    cwd: __dirname + "/..",
    env: { ...process.env, PORT: String(PORT), DATA_DIR, ADMIN_PASSWORD: ADMIN_PW },
    stdio: ["ignore", "pipe", "pipe"],
  });
  srv.stdout.on("data", () => {});
  srv.stderr.on("data", () => {});
  await waitForHealth();
});

after(() => {
  if (srv && !srv.killed) srv.kill("SIGTERM");
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

const post = (act, body, token) =>
  fetch(BASE + "/api/" + act, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    body: JSON.stringify(body || {}),
  });

async function signup(name, pw = "password123") {
  const r = await post("login", { name, pw });
  assert.equal(r.status, 200, `signup ${name}: ${r.status}`);
  const j = await r.json();
  assert.ok(j.token && j.id === name.toLowerCase());
  return j;
}

test("health check and index page", async () => {
  const h = await fetch(BASE + "/healthz");
  assert.equal(h.status, 200);
  assert.equal(await h.text(), "ok");
  const idx = await fetch(BASE + "/");
  assert.equal(idx.status, 200);
  assert.match(idx.headers.get("content-type"), /text\/html/);
  assert.ok(idx.headers.get("content-security-policy")?.includes("frame-ancestors"));
  assert.equal(idx.headers.get("x-frame-options"), "DENY");
  const html = await idx.text();
  assert.ok(html.includes("CatChat"));
});

test("signup validation", async () => {
  let r = await post("login", { name: "x", pw: "password123" });
  assert.equal(r.status, 400);
  r = await post("login", { name: "validname", pw: "short" });
  assert.equal(r.status, 400);
  r = await post("login", { name: "meowmaster100", pw: "password123" });
  assert.equal(r.status, 400); // reserved root name
});

test("auth is required for actions", async () => {
  const r = await post("send", { text: "hi" });
  assert.equal(r.status, 401);
});

test("chat send + player-to-player pay", async () => {
  const a = await signup("alice");
  const b = await signup("bob");
  let r = await post("send", { text: "hello cats" }, a.token);
  assert.equal(r.status, 200);
  r = await post("pay", { to: "bob", amt: 25 }, a.token);
  assert.equal(r.status, 200);
  // overdraft is rejected
  r = await post("pay", { to: "bob", amt: 1000000 }, a.token);
  assert.equal(r.status, 400);
  // self-pay and unknown users rejected
  assert.equal((await post("pay", { to: "alice", amt: 1 }, a.token)).status, 400);
  assert.equal((await post("pay", { to: "nobodyhere", amt: 1 }, a.token)).status, 400);
  void b;
});

test("daily bonus once per day", async () => {
  const u = await signup("dailyfan");
  assert.equal((await post("daily", {}, u.token)).status, 200);
  assert.equal((await post("daily", {}, u.token)).status, 400);
});

test("shop: admin adds item, user buys, sells back", async () => {
  const root = await signup("meowmaster100", ADMIN_PW);
  const u = await signup("shopper");
  let r = await post(
    "item/add",
    { name: "Test Hat", emoji: "🎩", desc: "a fancy hat", price: 10, stock: 5 },
    root.token
  );
  assert.equal(r.status, 200);
  r = await post("buy", { id: 1 }, u.token);
  assert.equal(r.status, 200);
  // buying own listing is rejected; sell-back pays 70%
  r = await post("item/sell", { name: "Ball", price: 20 }, u.token);
  assert.equal(r.status, 200);
  r = await post("buy", { id: 2 }, u.token);
  assert.equal(r.status, 400); // can't buy your own item
  r = await post("item/cancel", { id: 2 }, u.token);
  assert.equal(r.status, 200);
  // non-admin cannot add shop items
  assert.equal((await post("item/add", { name: "Nope", price: 1 }, u.token)).status, 400);
});

test("player listings cap at 5 for non-admins", async () => {
  const u = await signup("seller");
  for (let i = 0; i < 5; i++) {
    const r = await post("item/sell", { name: "Item" + i, price: 5 }, u.token);
    assert.equal(r.status, 200);
  }
  assert.equal((await post("item/sell", { name: "TooMany", price: 5 }, u.token)).status, 400);
});

test("avatar update accepts cat config, rejects bad photo", async () => {
  const u = await signup("avacat");
  let r = await post("avatar", { mode: "cat", fur: 3, eyes: 1, pat: 2, acc: 4 }, u.token);
  assert.equal(r.status, 200);
  r = await post("avatar", { photo: "not-a-data-url" }, u.token);
  assert.equal(r.status, 200); // ignored, stays a cat
});

test("admin ban wipes the account and unban frees the name", async () => {
  const root = await signup("meowmaster100", ADMIN_PW);
  const v = await signup("victim");
  void v;
  let r = await post("admin/ban", { to: "victim" }, root.token);
  assert.equal(r.status, 200);
  // banned session no longer authenticates
  r = await post("send", { text: "am i here" }, v.token);
  assert.equal(r.status, 401);
  // banned name cannot re-register until unbanned
  r = await post("login", { name: "victim", pw: "password123" });
  assert.equal(r.status, 400);
  r = await post("admin/unban", { to: "victim" }, root.token);
  assert.equal(r.status, 200);
  const again = await signup("victim");
  assert.ok(again.token);
});

test("wrong password is rejected", async () => {
  await signup("securecat");
  const r = await post("login", { name: "securecat", pw: "wrongpassword" });
  assert.equal(r.status, 400);
});

test("live state stream emits a state event", async () => {
  const u = await signup("streamfan");
  const ctl = new AbortController();
  const r = await fetch(BASE + "/events?t=" + encodeURIComponent(u.token), {
    headers: { Accept: "text/event-stream" },
    signal: ctl.signal,
  });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/event-stream/);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const t0 = Date.now();
  while (Date.now() - t0 < 8000 && !buf.includes("event: state")) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
  }
  ctl.abort();
  try { await reader.cancel(); } catch {}
  assert.ok(buf.includes("event: state"), "expected a state event from /events");
});

test("config endpoint reports the root admin name", async () => {
  const r = await fetch(BASE + "/api/config");
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { root: "meowmaster100", maxSell: 5 });
});

// Boots throwaway servers sharing one DATA_DIR to prove the ADMIN_NAME
// migration: old hardcoded root is demoted (data kept), the configured
// underscore name becomes root, and nobody else can claim it.
test("ADMIN_NAME with underscores migrates the old root safely", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catchat-admname-"));
  const servers = [];
  const boot = async (port, extraEnv) => {
    const s = spawn(process.execPath, ["--no-warnings", "server.js"], {
      cwd: __dirname + "/..",
      env: { ...process.env, PORT: String(port), DATA_DIR: dir, ...extraEnv },
      stdio: "ignore",
    });
    servers.push(s);
    const base = `http://127.0.0.1:${port}`;
    const t0 = Date.now();
    for (;;) {
      try {
        const r = await fetch(base + "/healthz");
        if (r.ok) break;
      } catch {}
      if (Date.now() - t0 > 15000) throw new Error("server did not boot");
      await new Promise((r) => setTimeout(r, 200));
    }
    return base;
  };
  const stop = (s) => new Promise((res) => { s.on("exit", res); s.kill("SIGTERM"); setTimeout(res, 3000); });
  t.after(async () => { for (const s of servers) if (!s.killed) s.kill("SIGTERM"); fs.rmSync(dir, { recursive: true, force: true }); });
  const lp = (base, act, body, token) =>
    fetch(base + "/api/" + act, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
      body: JSON.stringify(body || {}),
    });

  const P1 = PORT + 11, P2 = PORT + 12;
  // Phase 1: legacy default root owns the database and holds coins.
  const a = await boot(P1, { ADMIN_PASSWORD: "legacy-admin-pw" });
  let r = await lp(a, "login", { name: "meowmaster100", pw: "legacy-admin-pw" });
  assert.equal(r.status, 200);
  const legacy = await r.json();
  r = await lp(a, "admin/give", { to: "meowmaster100", n: 777 }, legacy.token);
  assert.equal(r.status, 200);
  await stop(servers.pop());

  // Phase 2: same database, ADMIN_NAME=sushi_catie.
  const b = await boot(P2, { ADMIN_PASSWORD: "new-admin-pw-1", ADMIN_NAME: "sushi_catie" });
  assert.deepEqual(await (await fetch(b + "/api/config")).json(), { root: "sushi_catie", maxSell: 5 });
  // New underscore root is created and can log in (case-insensitively).
  r = await lp(b, "login", { name: "sushi_catie", pw: "new-admin-pw-1" });
  assert.equal(r.status, 200);
  const root = await r.json();
  assert.equal(root.id, "sushi_catie");
  r = await lp(b, "login", { name: "SUSHI_CATIE", pw: "new-admin-pw-1" });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).id, "sushi_catie");
  // Nobody else can register the admin name.
  r = await lp(b, "login", { name: "sushi_catie", pw: "someone-else-pw" });
  assert.equal(r.status, 400);
  // Old root kept its data but lost root powers.
  r = await lp(b, "login", { name: "meowmaster100", pw: "legacy-admin-pw" });
  assert.equal(r.status, 200, "old root account data must survive migration");
  const demoted = await r.json();
  r = await lp(b, "admin/give", { to: "sushi_catie", n: 1 }, demoted.token);
  assert.equal(r.status, 400, "demoted account must no longer have root powers");
  // The new root still rules: it can give coins and ban.
  r = await lp(b, "admin/give", { to: "meowmaster100", n: 10 }, root.token);
  assert.equal(r.status, 200);
  await stop(servers.pop());
});
