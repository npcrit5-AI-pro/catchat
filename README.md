# CatChat 🐾

A tiny cat-themed chat room with coins, a shop, and cartoon-cat avatars.
Zero runtime dependencies — just Node.js + the built-in SQLite module
(`node:sqlite`). Live updates use Server-Sent Events; the whole database is
backed up to Supabase so it survives hosts with ephemeral filesystems.

Tabs: **Chat** (with `/pay`, `/buy`, `/give`, `/help` slash commands and
autocomplete), **Shop** (items, packs, cats — with sales), **Battle** (lead
cats, player duels with coin bets, wild cats to catch, NPC trainers, ability
shop), **Trade** (item/cat offers with accept/decline), **Wallet** (balance,
send coins, items, cats with XP/levels/evolution, equipped abilities,
leaderboard), **Settings** (avatar builder, theme, delete account),
**Admin** (shop items, cats, packs, wild cats, trainers, players, banned
username words, clear chat).

## Run locally

```bash
npm install
ADMIN_PASSWORD='pick-a-long-password' npm start
# open http://localhost:8080, health check at /healthz
```

The first run creates the root admin account using `ADMIN_NAME` (default
`meowmaster100`) and `ADMIN_PASSWORD`. If `ADMIN_PASSWORD` is unset, the
server generates an ephemeral one and prints it once (local dev only — set a
real one on Render).

Renaming the root later is safe: on boot the server creates/updates the
configured root and demotes the previous hardcoded `meowmaster100` account
to a normal player (its coins, items and messages are kept). Nobody else can
register the configured admin name.

## Tests

```bash
npm test          # API tests (node:test, no extra deps)
npm run e2e       # headless-Chrome smoke test + screenshots (needs Chrome)
```

## Game notes

- **Sales:** sellers can put their own listings on sale and admins any shop
  item (`item/sale` with a sale price below the current price and an
  optional end in hours). The shop strikes through the original price, shows
  the sale price with a SALE badge, and buying charges the sale price.
- **Slash commands:** `/pay name amount`, `/buy item [qty]` (uses the sale
  price), `/give player item [qty]`, `/help`. Names match exactly, then by
  prefix. Start typing `/` for autocomplete.
- **Cats & battles:** admins create cats (HP, types, rarity, evolution) and
  wild cats/trainers; players adopt cats, pick a lead, equip one ability per
  cat (everyone starts with a free Scratch), earn XP per battle, level up
  (40 XP/level) and auto-evolve. Duels, wild wins (catch + coins) and first
  trainer wins (full reward, 10% after) are announced in chat.
- **Trades & packs:** trade any owned items/cats with accept/decline/cancel
  (validated on accept); packs grant a weighted-random drop on purchase.
- **Banned username words:** admins add/remove words; signups containing
  one are rejected.
- Backups include all new tables; old backups restore cleanly (missing
  tables/columns fall back to defaults).

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `PORT` | No (defaults to `8080`) | Render sets this automatically; the server binds `0.0.0.0:$PORT`. |
| `ADMIN_PASSWORD` | **Yes** (production) | Password for the root admin account. Never commit it — set it under Render dashboard → service → Environment. Without it the server boots with a random ephemeral password. |
| `ADMIN_NAME` | No (defaults to `meowmaster100`) | Login name of the root admin account (2–16 letters, numbers, underscores; e.g. `sushi_catie`). Production is set to `sushi_catie` via `render.yaml`. |
| `SUPABASE_URL` | Recommended | Enables the database backup. Without it data lives only on local disk. |
| `SUPABASE_SERVICE_KEY` | Recommended | Service-role key for the backup (server-side only, never shipped to the browser). |
| `DATA_DIR` | No (defaults to `/tmp/catchat`) | Where the SQLite file lives. Only change if you attach a persistent disk. |

No secret values are committed to this repo.

## Deploy on Render (free plan)

The included `render.yaml` defines a free `web` service (`runtime: node`):

- **Build command:** `npm install --omit=dev --no-audit --no-fund`
- **Start command:** `npm start`
- **Health check path:** `/healthz`
- `ADMIN_PASSWORD` is created with `generateValue: true` — copy it somewhere safe after the first deploy.

Steps: push this repo → Render dashboard → New → Blueprint → select the repo.
Then set `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` in the service Environment
(see below) and deploy.

### Persistent storage (important on the free plan)

Render's free plan has an **ephemeral filesystem and no disks**, and free web
services spin down after ~15 minutes of inactivity. CatChat handles this by
copying the whole SQLite database to Supabase (one row) after changes and
loading it back on boot:

1. In Supabase, create a table (any schema/project):
   ```sql
   create table backup (id bigint primary key, data jsonb);
   ```
2. Set `SUPABASE_URL` (e.g. `https://xyz.supabase.co`) and
   `SUPABASE_SERVICE_KEY` (the service-role key) as Render env vars.
3. If the backup can't be read after retries, the server refuses to boot
   rather than overwriting it with an empty database.

### Real-time notes

Live updates use **Server-Sent Events** (`GET /events`), plain HTTP with
automatic browser reconnection — no WebSockets, no sticky sessions, works fine
on Render's free tier behind its proxy. Tradeoff: the free plan runs a single
instance, so horizontal scaling beyond one instance would need a shared store
for SSE/clients (currently in-memory); that's out of scope for the free tier.
