const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {spawn} = require("node:child_process");
const {DatabaseSync} = require("node:sqlite");

const ROOT = path.resolve(__dirname, "..");
const FIXTURE = path.join(__dirname, "fixtures", "legacy-main.db");
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
let portN = 24000 + (process.pid % 400) * 20;
const nextPort = () => portN++;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function req(port, method, pathname, {token, body, raw} = {}) {
  const data = raw != null ? raw : (body != null ? Buffer.from(JSON.stringify(body)) : null);
  return new Promise((resolve, reject) => {
    const r = http.request({
      hostname: "127.0.0.1", port, method, path: pathname,
      headers: {
        ...(data ? {"Content-Type": "application/json", "Content-Length": data.length} : {}),
        ...(token ? {Authorization: "Bearer " + token} : {})
      }
    }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({status: res.statusCode, headers: res.headers, text, json, buf: Buffer.concat(chunks)});
      });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

function onceState(port, token) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); fn(v); };
    const timer = setTimeout(() => { req.destroy(); finish(reject, new Error("sse timeout")); }, 6000);
    const req = http.get({hostname: "127.0.0.1", port, path: "/events?t=" + encodeURIComponent(token), headers: {Accept: "text/event-stream"}}, res => {
      if (res.statusCode !== 200) { finish(reject, new Error("sse " + res.statusCode)); res.resume(); return; }
      let buf = "";
      res.on("data", c => {
        buf += c.toString();
        const key = "event: state\ndata: ";
        const i = buf.indexOf(key);
        if (i < 0) return;
        const end = buf.indexOf("\n\n", i);
        if (end < 0) return;
        req.destroy();
        try { finish(resolve, JSON.parse(buf.slice(i + key.length, end))); }
        catch (e) { finish(reject, e); }
      });
    });
    req.on("error", e => { if (e.code !== "ECONNRESET") finish(reject, e); });
  });
}

async function start(env) {
  const child = spawn(process.execPath, ["--no-warnings", "server.js"], {
    cwd: ROOT,
    env: {...process.env, ADMIN_PASSWORD: "test-admin-pw", SUPABASE_URL: "", SUPABASE_SERVICE_KEY: "", ...env},
    stdio: ["ignore", "pipe", "pipe"]
  });
  let log = "";
  child.stdout.on("data", d => { log += d; });
  child.stderr.on("data", d => { log += d; });
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (log.includes("listening on")) return {child, log: () => log};
    if (child.exitCode != null) throw new Error("server exited " + child.exitCode + "\n" + log);
    await new Promise(r => setTimeout(r, 40));
  }
  child.kill("SIGKILL");
  throw new Error("server did not start\n" + log);
}

async function stop(child) {
  if (!child || child.exitCode != null) return;
  child.kill("SIGTERM");
  await new Promise(resolve => {
    const t = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 5000);
    child.once("exit", () => { clearTimeout(t); resolve(); });
  });
}

async function login(port, name, pw) {
  const r = await req(port, "POST", "/api/login", {body: {name, pw}});
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json;
}

test("legacy database from main still logs in and keeps messages", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catchat-legacy-"));
  fs.copyFileSync(FIXTURE, path.join(dir, "meow.db"));
  const port = nextPort();
  const srv = await start({PORT: String(port), DATA_DIR: dir});
  try {
    const mochi = await login(port, "Mochi", "mochi-pass");
    const pixel = await login(port, "Pixel", "pixel-pass");
    const bad = await req(port, "POST", "/api/login", {body: {name: "Mochi", pw: "wrong-password"}});
    assert.equal(bad.status, 400);
    const state = await onceState(port, mochi.token);
    const pix = await onceState(port, pixel.token);
    assert.equal(state.players.find(p => p.id === "mochi").coins, 85);
    assert.equal(state.players.find(p => p.id === "pixel").coins, 145);
    assert.ok(state.messages.some(m => m.text === "hello from mochi, the original cat" && !m.sys));
    assert.ok(state.messages.some(m => m.text === "pixel says the shop is empty"));
    assert.equal(state.items.find(i => i.name === "Yarn Ball").seller, "mochi");
    assert.equal(state.items.find(i => i.name === "Tuna Can").stock, 4);
    assert.deepEqual(pix.me.inv, {"2": 1});
    const sent = await req(port, "POST", "/api/send", {token: mochi.token, body: {text: "still here after upgrade"}});
    assert.equal(sent.status, 200);
    const again = await onceState(port, mochi.token);
    assert.ok(again.messages.some(m => m.text === "hello from mochi, the original cat"));
    assert.ok(again.messages.some(m => m.text === "still here after upgrade"));
    assert.equal(again.me.reports, undefined);
  } finally { await stop(srv.child); }
  const db = new DatabaseSync(path.join(dir, "meow.db"), {readOnly: true});
  const cols = db.prepare("PRAGMA table_info(messages)").all().map(c => c.name);
  for (const name of ["id", "name", "text", "ts", "sys", "reply", "edited", "deleted", "image"]) assert.ok(cols.includes(name), name);
  const row = db.prepare("SELECT text FROM messages WHERE id=1").get();
  assert.equal(row.text, "hello from mochi, the original cat");
  const playerCols = db.prepare("PRAGMA table_info(players)").all().map(c => c.name);
  for (const name of ["salt", "hash", "coins", "inv", "avatar", "photo"]) assert.ok(playerCols.includes(name));
  db.close();
});

test("chat actions: auth, mentions, edit, reactions, polls, reports, images, pins", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catchat-new-"));
  const port = nextPort();
  const srv = await start({PORT: String(port), DATA_DIR: dir});
  try {
    const health = await req(port, "GET", "/healthz");
    assert.equal(health.text, "ok");
    const noAuth = await req(port, "POST", "/api/send", {body: {text: "nope"}});
    assert.equal(noAuth.status, 401);
    const badName = await req(port, "POST", "/api/login", {body: {name: "x", pw: "secret1"}});
    assert.equal(badName.status, 400);
    const a = await login(port, "Nori", "nori-pass");
    const b = await login(port, "Katsu", "katsu-pass");
    const root = await login(port, "meowmaster100", "test-admin-pw");
    const wrong = await req(port, "POST", "/api/login", {body: {name: "meowmaster100", pw: "not-the-password"}});
    assert.equal(wrong.status, 400);

    assert.equal((await req(port, "POST", "/api/send", {token: a.token, body: {text: "  "}})).status, 400);
    assert.equal((await req(port, "POST", "/api/send", {token: a.token, body: {text: "Hello <script>alert(1)</script> @Katsu"}})).status, 200);
    let state = await onceState(port, b.token);
    const hello = state.messages.find(m => String(m.text).includes("Hello"));
    assert.ok(hello);
    assert.equal(hello.text.includes("<script>"), true);
    assert.ok(state.me.mentions.some(m => m.mid === hello.id && m.name === "Nori"));
    assert.equal(state.me.reports, undefined);

    assert.equal((await req(port, "POST", "/api/edit", {token: b.token, body: {id: hello.id, text: "hijack"}})).status, 400);
    assert.equal((await req(port, "POST", "/api/edit", {token: a.token, body: {id: hello.id, text: "Hello @Katsu, edited"}})).status, 200);
    assert.equal((await req(port, "POST", "/api/msg/delete", {token: b.token, body: {id: hello.id}})).status, 400);
    assert.equal((await req(port, "POST", "/api/send", {token: b.token, body: {text: "replying", reply: hello.id}})).status, 200);
    state = await onceState(port, a.token);
    const edited = state.messages.find(m => m.id === hello.id);
    assert.equal(edited.edited, 1);
    assert.match(edited.text, /edited/);
    const reply = state.messages.find(m => m.reply === hello.id);
    assert.equal(reply.replyName, "Nori");

    assert.equal((await req(port, "POST", "/api/react", {token: a.token, body: {id: hello.id, emoji: "🐱"}})).status, 200);
    assert.equal((await req(port, "POST", "/api/react", {token: a.token, body: {id: hello.id, emoji: "🐱"}})).status, 200);
    state = await onceState(port, a.token);
    assert.equal((state.messages.find(m => m.id === hello.id).reactions || []).length, 0);
    assert.equal((await req(port, "POST", "/api/react", {token: b.token, body: {id: hello.id, emoji: "❤️"}})).status, 200);
    state = await onceState(port, a.token);
    const heart = state.messages.find(m => m.id === hello.id).reactions.find(r => r.emoji === "❤️");
    assert.deepEqual(heart.users, ["katsu"]);

    assert.equal((await req(port, "POST", "/api/pin", {token: a.token, body: {id: hello.id}})).status, 400);
    assert.equal((await req(port, "POST", "/api/pin", {token: root.token, body: {id: hello.id}})).status, 200);
    state = await onceState(port, a.token);
    assert.equal(state.pins.length, 1);
    assert.equal(state.pins[0].id, hello.id);

    await sleep(520);
    const poll = await req(port, "POST", "/api/poll/create", {token: a.token, body: {question: "Fish <b>or</b> yarn?", options: ["Fish", "Yarn", "Fish"]}});
    assert.equal(poll.status, 400, JSON.stringify(poll.json));
    const pollOk = await req(port, "POST", "/api/poll/create", {token: a.token, body: {question: "Fish <b>or</b> yarn?", options: ["Fish", "Yarn"]}});
    assert.equal(pollOk.status, 200, JSON.stringify(pollOk.json));
    state = await onceState(port, b.token);
    const p = state.polls.find(x => x.question.includes("Fish"));
    assert.ok(p);
    assert.equal((await req(port, "POST", "/api/poll/vote", {token: a.token, body: {id: p.id, opt: 0}})).status, 200);
    assert.equal((await req(port, "POST", "/api/poll/vote", {token: b.token, body: {id: p.id, opt: 1}})).status, 200);
    assert.equal((await req(port, "POST", "/api/poll/vote", {token: a.token, body: {id: p.id, opt: 1}})).status, 200);
    state = await onceState(port, a.token);
    const votes = state.polls.find(x => x.id === p.id).votes;
    assert.equal(votes.length, 2);
    assert.ok(votes.every(v => v.opt === 1));

    await sleep(520);
    const imgBad = await req(port, "POST", "/api/image", {token: a.token, body: {data: "data:image/jpeg;base64,AAAA"}});
    assert.equal(imgBad.status, 400);
    assert.match(imgBad.json.error, /JPEG|PNG|GIF|WebP/);
    const html = await req(port, "POST", "/api/image", {token: a.token, body: {data: "data:text/html;base64,PHNjcmlwdD4="}});
    assert.equal(html.status, 400);
    const img = await req(port, "POST", "/api/image", {token: a.token, body: {data: "data:image/png;base64," + PNG}});
    assert.equal(img.status, 200, JSON.stringify(img.json));
    assert.match(img.json.id, /^[a-f0-9]{24}$/);
    const posted = await req(port, "POST", "/api/send", {token: a.token, body: {text: "a picture", image: img.json.id}});
    assert.equal(posted.status, 200);
    const fetched = await req(port, "GET", "/img/" + img.json.id);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.headers["content-type"], "image/png");
    assert.equal(fetched.headers["x-content-type-options"], "nosniff");
    assert.equal(fetched.buf[0], 0x89);
    assert.equal(fetched.buf[1], 0x50);

    const big = Buffer.alloc(160000, 0x61);
    const tooBigSend = await req(port, "POST", "/api/send", {token: a.token, raw: big});
    assert.equal(tooBigSend.status, 400);
    assert.match(tooBigSend.json.error, /too large/i);
    const biggerImageBody = await req(port, "POST", "/api/image", {token: a.token, raw: big});
    assert.equal(biggerImageBody.status, 400);
    assert.equal(biggerImageBody.json.error, "Bad request");
    await sleep(1100);
    const fat = Buffer.alloc(50 * 1024, 7);
    fat[0] = 0x89; fat[1] = 0x50; fat[2] = 0x4e; fat[3] = 0x47;
    const over = await req(port, "POST", "/api/image", {token: a.token, body: {data: "data:image/png;base64," + fat.toString("base64")}});
    assert.equal(over.status, 400);
    assert.match(over.json.error, /too big/i);

    for (let i = 0; i < 5; i++) {
      if (i) await sleep(520);
      assert.equal((await req(port, "POST", "/api/send", {token: b.token, body: {text: "report me " + i}})).status, 200);
    }
    state = await onceState(port, a.token);
    const targets = state.messages.filter(m => String(m.text).startsWith("report me"));
    assert.equal(targets.length, 5);
    for (const m of targets) assert.equal((await req(port, "POST", "/api/report", {token: a.token, body: {kind: "message", target: m.id, reason: "spam"}})).status, 200);
    const sixth = await req(port, "POST", "/api/report", {token: a.token, body: {kind: "user", target: "katsu", reason: "again"}});
    assert.equal(sixth.status, 400);
    assert.match(sixth.json.error, /too quickly/i);
    const adminState = await onceState(port, root.token);
    assert.ok(adminState.me.reports.filter(r => r.status === "open").length >= 5);
    const open = adminState.me.reports.find(r => r.status === "open" && r.kind === "message");
    assert.equal((await req(port, "POST", "/api/report/dismiss", {token: a.token, body: {id: open.id}})).status, 400);
    assert.equal((await req(port, "POST", "/api/report/dismiss", {token: root.token, body: {id: open.id}})).status, 200);

    const paid = await req(port, "POST", "/api/pay", {token: a.token, body: {to: "Katsu", amt: 5}});
    assert.equal(paid.status, 200);
    const daily = await req(port, "POST", "/api/daily", {token: a.token, body: {}});
    assert.equal(daily.status, 200);
    state = await onceState(port, a.token);
    assert.equal(state.players.find(p => p.id === "nori").coins, 145);
    assert.equal(state.players.find(p => p.id === "katsu").coins, 105);

    assert.equal((await req(port, "POST", "/api/admin/mute", {token: root.token, body: {to: "nori", hours: 1}})).status, 200);
    const muted = await req(port, "POST", "/api/send", {token: a.token, body: {text: "can I talk"}});
    assert.equal(muted.status, 400);
    assert.match(muted.json.error, /muted/i);
    assert.equal((await req(port, "POST", "/api/admin/mute", {token: root.token, body: {to: "nori"}})).status, 200);
    assert.equal((await req(port, "POST", "/api/send", {token: a.token, body: {text: "I can talk"}})).status, 200);

    const victim = await login(port, "Tmpcat", "tmpcat-pass");
    assert.equal((await req(port, "POST", "/api/admin/ban", {token: root.token, body: {to: "tmpcat"}})).status, 200);
    const banned = await req(port, "POST", "/api/login", {body: {name: "Tmpcat", pw: "tmpcat-pass"}});
    assert.equal(banned.status, 400);
    assert.match(banned.json.error, /banned/i);
    assert.equal((await req(port, "POST", "/api/admin/unban", {token: root.token, body: {to: "tmpcat"}})).status, 200);
    assert.equal((await req(port, "POST", "/api/me", {token: victim.token})).status, 401);
  } finally { await stop(srv.child); }
});

test("supabase backup keeps old row shape and restores onto an empty disk", async () => {
  const store = {rows: []};
  const mock = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      if (req.method === "GET") {
        res.writeHead(200, {"Content-Type": "application/json"});
        res.end(JSON.stringify(store.rows));
        return;
      }
      if (req.method === "POST") {
        store.rows = [JSON.parse(Buffer.concat(chunks).toString() || "{}")];
        res.writeHead(201, {"Content-Type": "application/json"});
        res.end("");
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise(r => mock.listen(0, "127.0.0.1", r));
  const mockPort = mock.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catchat-sb-"));
  const port = nextPort();
  const env = {
    PORT: String(port), DATA_DIR: dir,
    SUPABASE_URL: "http://127.0.0.1:" + mockPort,
    SUPABASE_SERVICE_KEY: "test-service-key"
  };
  let srv = await start(env);
  let imageId = "";
  try {
    const a = await login(port, "Miso", "miso-pass");
    assert.equal((await req(port, "POST", "/api/send", {token: a.token, body: {text: "survive the disk"}})).status, 200);
    const img = await req(port, "POST", "/api/image", {token: a.token, body: {data: "data:image/png;base64," + PNG}});
    imageId = img.json.id;
    await sleep(520);
    assert.equal((await req(port, "POST", "/api/send", {token: a.token, body: {text: "pic", image: imageId}})).status, 200);
    await sleep(520);
    assert.equal((await req(port, "POST", "/api/poll/create", {token: a.token, body: {question: "Nap?", options: ["Yes", "Also yes"]}})).status, 200);
    const state = await onceState(port, a.token);
    const poll = state.polls[0];
    assert.equal((await req(port, "POST", "/api/poll/vote", {token: a.token, body: {id: poll.id, opt: 0}})).status, 200);
    const msg = state.messages.find(m => m.text === "survive the disk");
    assert.equal((await req(port, "POST", "/api/react", {token: a.token, body: {id: msg.id, emoji: "🎉"}})).status, 200);
    assert.equal((await req(port, "POST", "/api/edit", {token: a.token, body: {id: msg.id, text: "survive the disk edited"}})).status, 200);
  } finally { await stop(srv.child); }

  assert.equal(store.rows.length, 1);
  const data = store.rows[0].data;
  const playerKeys = ["admin", "avatar", "banned", "coins", "daily", "hash", "id", "infinite", "inv", "name", "photo", "pv", "salt"];
  for (const p of data.players) assert.deepEqual(Object.keys(p).sort(), playerKeys);
  assert.equal(Object.hasOwn(data.players.find(p => p.id === "miso"), "muted"), false);
  const messageKeys = ["id", "name", "sys", "text", "ts"];
  for (const m of data.messages) assert.deepEqual(Object.keys(m).sort(), messageKeys);
  assert.ok(data.messages.some(m => m.text === "survive the disk edited"));
  assert.ok(Array.isArray(data.images) && data.images.some(i => i.id === imageId));
  assert.ok(data.polls.length === 1 && data.poll_votes.length === 1);
  assert.ok(data.reactions.some(r => r.emoji === "🎉"));
  assert.ok(data.message_meta.some(m => m.edited === 1));
  for (const key of ["players", "items", "messages", "sessions", "blocked", "images", "polls", "poll_votes", "reports", "mentions", "reactions", "pins", "message_meta", "player_flags"]) {
    assert.ok(Object.hasOwn(data, key), key);
  }

  fs.rmSync(dir, {recursive: true, force: true});
  fs.mkdirSync(dir);
  const port2 = nextPort();
  srv = await start({...env, PORT: String(port2)});
  try {
    const a = await login(port2, "Miso", "miso-pass");
    const state = await onceState(port2, a.token);
    assert.ok(state.messages.some(m => m.text === "survive the disk edited" && m.edited === 1));
    assert.equal(state.polls[0].question, "Nap?");
    assert.equal(state.polls[0].votes.length, 1);
    assert.ok(state.messages.some(m => m.image === "/img/" + imageId));
    const fetched = await req(port2, "GET", "/img/" + imageId);
    assert.equal(fetched.headers["content-type"], "image/png");
    assert.equal(fetched.headers["x-content-type-options"], "nosniff");
  } finally { await stop(srv.child); }

  const core = {players: data.players, items: data.items, messages: data.messages, sessions: data.sessions, blocked: data.blocked};
  store.rows = [{id: 1, data: core}];
  fs.rmSync(dir, {recursive: true, force: true});
  fs.mkdirSync(dir);
  const port3 = nextPort();
  srv = await start({...env, PORT: String(port3)});
  try {
    const a = await login(port3, "Miso", "miso-pass");
    const state = await onceState(port3, a.token);
    assert.ok(state.messages.some(m => m.text === "survive the disk edited"));
    assert.equal(state.polls.length, 0);
    assert.equal((await req(port3, "POST", "/api/send", {token: a.token, body: {text: "old backup still chats"}})).status, 200);
  } finally { await stop(srv.child); }
  await new Promise(r => mock.close(r));
});
