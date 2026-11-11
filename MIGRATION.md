# CatChat upgrade — data migration

No Supabase SQL is required. Do not create new tables or columns in the Supabase dashboard for this release.

## Where data lives

CatChat still stores a local SQLite file at `$DATA_DIR/meow.db` (default `/tmp/catchat/meow.db`) and mirrors the whole database to Supabase. That mirror is the source of truth on Render: a new instance with an empty disk loads it on startup, and every change is written back.

The Supabase object is unchanged: table `backup`, one row with `id = 1`, column `data`. `data` is a JSON object. This upgrade does not add Supabase tables or columns, and it does not change the fields of the original keys.

Those keys keep exactly these fields:

| Key | Fields |
| --- | --- |
| `players` | `id`, `name`, `salt`, `hash`, `coins`, `admin`, `banned`, `inv`, `daily`, `avatar`, `photo`, `pv`, `infinite` |
| `items` | `id`, `name`, `emoji`, `descr`, `price`, `stock`, `kind`, `seller` |
| `messages` | `id`, `name`, `text`, `ts`, `sys` |
| `sessions` | `token`, `pid`, `ts` |
| `blocked` | `id` |

New features are extra keys on the same JSON value. A backup from before this upgrade has no such keys; they load as empty and accounts, messages, coins, and the shop keep working. If one of the new keys is missing or malformed, that part is skipped and the rest still loads.

| New key | What it holds |
| --- | --- |
| `message_meta` | Reply target, edited flag, deleted flag, and picture id for messages that use them |
| `player_flags` | Mute flag and expiry, only for people who are muted |
| `images` | Compressed pictures |
| `polls`, `poll_votes` | Poll questions, choices, and votes |
| `reports` | Message and user reports |
| `mentions` | Unread and read @mentions |
| `reactions` | Emoji reactions |
| `pins` | Pinned messages |

Nothing here deletes or rewrites an existing Supabase row's columns. The app still upserts `{id: 1, data: {...}}` into `backup`.

## Pictures

Pictures are stored inside that same `images` array, not in Supabase Storage and not in a new table. They come back with the rest of the backup on a fresh disk, and no bucket or SQL has to be created.

Limits, so the single backup document stays small:

- The browser scales the long side to at most 800px and compresses to JPEG.
- The server accepts only JPEG, PNG, GIF, and WebP, checks the bytes match the declared type, and refuses anything over 40KB.
- Caps: 8 pictures per person, 24 in the whole chat, about 700KB of picture bytes in total.
- If a backup would still exceed the cap, the oldest pictures are removed so the save can finish. Deleting a picture message removes its bytes.

## Local SQLite

Local changes are additive: new tables (see the keys above), plus new columns `players.muted`, `players.muted_until`, `messages.reply`, `messages.edited`, `messages.deleted`, and `messages.image`. Old columns are not renamed or dropped. Those new columns are not written into the original `players` or `messages` objects in Supabase; mute and message extras travel in `player_flags` and `message_meta`.

## If Supabase is not configured

Same as before. Without both `SUPABASE_URL` and `SUPABASE_SERVICE_KEY`, the process logs a warning and only the local file is kept. If the backup cannot be read on startup, the process exits so an empty database cannot overwrite it.
