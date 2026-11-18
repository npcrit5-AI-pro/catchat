# CatChat 🐾

A tiny cat-themed chat room with coins, a shop, and cartoon-cat avatars.
Zero runtime dependencies — just Node.js + the built-in SQLite module
(`node:sqlite`). Live updates use Server-Sent Events; the whole database is
backed up to Supabase so it survives hosts with ephemeral filesystems.

## Run locally

```bash
npm install
ADMIN_PASSWORD='pick-a-long-password' npm start
# open http://localhost:8080, health check at /healthz
```

The first run creates an admin account named `meowmaster100` using
`ADMIN_PASSWORD`. If `ADMIN_PASSWORD` is unset, the server generates an
ephemeral one and prints it once (local dev only — set a real one on Render).

## Tests

```bash
npm test          # API tests (node:test, no extra deps)
npm run e2e       # headless-Chrome smoke test + screenshots (needs Chrome)
```

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `PORT` | No (defaults to `8080`) | Render sets this automatically; the server binds `0.0.0.0:$PORT`. |
| `ADMIN_PASSWORD` | **Yes** (production) | Password for the `meowmaster100` admin account. Never commit it — set it under Render dashboard → service → Environment. Without it the server boots with a random ephemeral password. |
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
