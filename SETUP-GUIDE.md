# CatChat Upgrade: Download and Setup Guide

This is the upgraded CatChat. Everyone's accounts, passwords, messages, coins and shop items keep working. Data stays in your Supabase `backup` row, and no Supabase changes are needed.

## What's new
- **Pictures:** paste, drag and drop, or use the attach button. Pictures are shrunk automatically, and you can click one to see it bigger.
- **@mentions:** type `@` to pick a name. The person gets a highlight and a badge.
- **Reporting:** report a message or a player with a reason. Admins review reports in the Admin tab.
- **Polls:** ask a question with 2 to 10 choices. Everyone gets one vote they can change, and the results update live.
- **Light and dark mode:** pick Light, Dark or System in Settings.
- **Emoji reactions** on messages.
- **Reply / quote** a message.
- **Edit and delete** your own messages.
- **Typing indicator:** shows "someone is typing…".
- **Pinned messages** at the top of the chat.
- A cleaner look that also works on phones.

## What's in the zip
- `server.js`: the server
- `index.html`: the app people see
- `Dockerfile`: how Render builds it
- `MIGRATION.md`: technical details on how data is kept safe
- `test/`: automatic tests (not needed to run the app)
- `SETUP-GUIDE.md`: this guide

---

## Option A: Update your GitHub repo by uploading the files (easiest)
1. Download and unzip `catchat-upgrade.zip`.
2. Go to your repo, `github.com/meowmaster10021/catchat`.
3. Click **Add file**, then **Upload files**.
4. Drag in `server.js`, `index.html`, `Dockerfile`, `MIGRATION.md` and the `test` folder from the unzipped folder.
5. Type a message like "CatChat upgrade" and click **Commit changes**. This replaces the old `server.js` and `index.html`.
6. If Render has auto-deploy on, it redeploys by itself in a minute or two. If not, open your service on Render and click **Manual Deploy**, then **Deploy latest commit**.

## Option B: Point Render at the upgrade branch (no uploading)
1. Open your CatChat service on [Render](https://dashboard.render.com).
2. Go to **Settings**, then **Build & Deploy**.
3. Change the repository to `https://github.com/npcrit5-AI-pro/catchat`, and set the branch to `upgrade`.
4. Save, then click **Manual Deploy**, then **Deploy latest commit**.

Option A keeps everything in your own repo, so it's the better choice long term.

---

## What the admin has to do (important)

### 1. Check that Supabase is still connected
On Render, open your service, then **Environment**. These must still be set:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY`

If they're missing, the app only saves to a temporary file that gets wiped on every redeploy. Don't add any tables in Supabase; the upgrade doesn't need any.

### 2. Set your own admin password
Right now a default admin password is written in `server.js`, and anyone who can see the repo can read it.
1. On Render, open **Environment** and click **Add Environment Variable**.
2. Set the key to `ADMIN_PASSWORD` and the value to a new password of at least 6 characters.
3. Save. Render restarts the app.

**Heads-up:** every time the app starts, it sets the password of the main account `meowmaster100` to `ADMIN_PASSWORD`. After you change it, log in as `meowmaster100` with the new password.

### 3. Test it after the deploy
1. Open your CatChat site and log in as normal. Your coins and messages should all be there.
2. Paste a picture, make a poll, and try light and dark mode in Settings.
3. Log in as `meowmaster100` and open the **Admin** tab to check that you can see the **Reports** list.

---

## Admin powers
**Any admin** (shown with an "admin" tag) can:
- review reports and dismiss them, delete the message, or mute the player
- delete any message
- mute a player for 1 day, or unmute them
- make someone an admin, or remove their admin
- clear all messages (you have to click twice to confirm, and **it can't be undone**)

**Only `meowmaster100`** can:
- ban or unban players
- give coins, or take them away with a minus number

Nobody can mute, ban or delete `meowmaster100`.

## Limits on pictures
To keep the Supabase backup small:
- Each picture is shrunk to 800px and must end up under 40KB.
- Each person can have up to 8 pictures, with 24 for the whole chat.
- When the limit is reached, the oldest pictures are removed.
- Only JPEG, PNG, GIF and WebP are allowed.

## If something goes wrong
- **The app won't start and says "Set ADMIN_PASSWORD":** the password is shorter than 6 characters. Make it longer.
- **The app stops right after it starts:** it couldn't read the Supabase backup, so it stops on purpose instead of overwriting your data with an empty one. Check `SUPABASE_URL` and `SUPABASE_SERVICE_KEY`.
- **You want the old version back:** in Render, switch back to your old branch or commit and redeploy. Old data still works, though the new extras (polls, pictures and so on) won't show.

## Running it on your own computer (optional)
1. Install [Node.js 22](https://nodejs.org) or newer.
2. In the unzipped folder, run `node server.js`.
3. Open `http://localhost:8080`.

Without the Supabase settings, this local copy is only for testing.
