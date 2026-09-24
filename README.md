# NSBE Task Bot

A Discord bot for the e-board. Officers assign tasks with a slash command, the bot reminds
people **1 week, 3 days, 1 day before, and the morning a task is due** (in `#task-alerts`
and by DM), and people close tasks with one **✅ Mark done** button on the reminder.
Nobody has to open another website.

It runs free on Vercel (Hobby plan) with a free Neon Postgres database.

---

## What it looks like for the e-board

| Command | What it does |
|---|---|
| `/assign who task due [details]` | Give someone a task. `who` can be a person **or** a zone role like `@Finance Zone` (also `@CEO` or `@CEB`). `due` understands `friday`, `10/3`, `next tuesday`, `in 2 weeks`, and shows how it read your date before you hit enter. |
| `/tasks` | Your open tasks. Add `person:` for someone else's, or `zone:` for a whole zone / the whole board. |
| `/done task` | Mark something finished (start typing and pick it from the list). |
| `/edit-task task …` | Change the title, due date, notes, or reassign it. Changing the date restarts the reminders. |
| `/delete-task task` | Remove a task that's no longer needed. |

Every reminder and assignment message has a **✅ Mark done** button, in the channel and in DMs.

**Who can do what** (change it in `src/config.ts`):
- **CEOs** (anyone with the `CEO` role: President, both VPs, Secretary, Treasurer, Programs Chair, Parliamentarian) can assign to anyone on the e-board, and edit, reassign, delete or close any task.
- **Everyone else on the e-board** can create tasks for themselves, and edit or delete tasks they created.
- A task can be closed by the person it's assigned to (or anyone holding the role, for role tasks), by whoever assigned it, or by a CEO.
- Only people with `CEB`, `CEO` or a zone role can use the bot or be assigned tasks.

**Reminder details**
- If a task is created less than a week out, the "you've been assigned" message counts as the first reminder, so people don't get double-pinged. Example: a task due in 5 days gets the 3-day, 1-day and day-of reminders.
- One "⚠️ overdue" nudge goes out the day after a task was due if it's still open (turn off with `overdueNudge: false`).
- Reminders go out once a day, **between 9 and 10am Eastern** (8 to 9am in winter). The free Vercel plan only runs scheduled jobs once a day, at some point within the hour you choose.

---

## Setup (about 30 minutes, one time)

You need: a GitHub account, a free Vercel account, Node.js 22 on your computer, and
**Manage Server** permission in the NSBE Discord.

### 1. Check the Discord roles

The bot works out who's who from three kinds of Discord roles, set in `src/config.ts`:

| Role | Meaning |
|---|---|
| `CEB` | On the e-board: can use the bot and be assigned tasks |
| `CEO` | Chapter Executive Officer: can assign tasks to anyone |
| `Membership Zone`, `Program Zone`, `Finance Zone`, `Comm Zone`, `Trailblazer Zone Director`, `Senate Zone` | Which zone someone is in (used for `/tasks zone:` and zone-wide tasks) |

Make sure everyone on the board has `CEB` plus their zone role, and the seven elected officers have `CEO`.
If you rename a role in Discord, change it in `config.ts` too.

### 2. Create the Discord application
1. Go to <https://discord.com/developers/applications> → **New Application** → name it e.g. "NSBE Task Bot".
2. On **General Information**, copy the **Application ID** and **Public Key**.
3. **Bot** tab → **Reset Token** → copy the token (keep it secret; it's the bot's password).
   On the same page, turn on **Server Members Intent**. It lets the bot DM everyone in a role when you assign a task to a whole zone.
4. Invite the bot. Open this link with your Application ID filled in:
   `https://discord.com/oauth2/authorize?client_id=YOUR_APPLICATION_ID&scope=bot+applications.commands&permissions=149504`
   (permissions = View Channels, Send Messages, Embed Links, Mention Roles).
5. In Discord: **User Settings → Advanced → Developer Mode** on. Right-click the server → **Copy Server ID**. Right-click `#task-alerts` → **Copy Channel ID**.
   If `#task-alerts` is private, add the bot's role to it.

### 3. Deploy to Vercel
1. Put this folder in a **private** GitHub repo.
2. In Vercel: **Add New → Project** → import the repo. Framework preset: **Other**. Don't change the build settings.
3. In the project, open the **Storage** tab → **Create Database** → **Neon** (free) → connect it to the project. This adds `DATABASE_URL` for you. The bot creates its table on its own the first time it runs.
4. **Settings → Environment Variables**, add:

   | Name | Value |
   |---|---|
   | `DISCORD_APPLICATION_ID` | from step 2.2 |
   | `DISCORD_PUBLIC_KEY` | from step 2.2 |
   | `DISCORD_BOT_TOKEN` | from step 2.3 |
   | `DISCORD_GUILD_ID` | Server ID |
   | `TASK_ALERTS_CHANNEL_ID` | `#task-alerts` channel ID |
   | `CRON_SECRET` | any long random string (e.g. mash the keyboard for 40 characters) |

5. **Deployments** → redeploy so the variables take effect. Note your URL, e.g. `https://nsbe-task-bot.vercel.app`.

### 4. Connect Discord to Vercel
1. Back in the Developer Portal → **General Information** → **Interactions Endpoint URL**:
   `https://YOUR-PROJECT.vercel.app/api/interactions` → **Save**.
   Discord tests the URL when you save. If it refuses, the Public Key in Vercel is wrong or you didn't redeploy.
2. On your computer, in this folder:
   ```bash
   npm install
   cp .env.example .env      # fill in DISCORD_APPLICATION_ID, DISCORD_BOT_TOKEN, DISCORD_GUILD_ID
   npm run register
   ```
   You should see `Registered 5 commands`. Run it again any time you change the commands or zones.

### 5. Try it
In Discord, type `/assign`, pick yourself, and set the due date to `today`. You should get a
confirmation, a post in `#task-alerts`, and a DM. Hit **Mark done**.

To test the daily reminders without waiting: Vercel → project → **Settings → Cron Jobs** → **Run**.

---

## Changing things

Everything you're likely to change is in **`src/config.ts`**:
- `reminderDaysBefore`: when reminders go out (`[7, 3, 1, 0]`)
- `overdueNudge`: the day-after nudge on/off
- `nonExecCanAssign`: `"self"` (default), `"zone"` (chairs can assign within their zone) or `"anyone"`
- `EXEC_ROLES`, `EBOARD_ROLES`, `ZONES`: which Discord roles mean what

Reminder time of day: the `schedule` in `vercel.json`, in **UTC**. `0 13 * * *` = 9am EDT / 8am EST.

Push to GitHub and Vercel redeploys on its own. If you changed zones or commands, also run `npm run register`.

## If something's off

- **"The application did not respond"** in Discord: check Vercel → **Logs**. Usually a missing environment variable.
- **Someone "doesn't have an e-board role"**: they're missing the `CEB` role (or a zone role) in Discord.
- **No DMs for someone**: they have "Allow direct messages from server members" off. They'll still be pinged in `#task-alerts`.
- **Role pings don't notify**: the bot needs the "Mention @everyone, @here, and All Roles" permission (included in the invite link), or make the role mentionable.

## For whoever maintains this next

TypeScript on Vercel Functions, no framework. Discord talks to the bot over HTTP (the
interactions endpoint), so there's no always-on process. That is also why "done" is a button, not
a ✅ reaction: reactions only reach bots holding a live gateway connection, and serverless can't.

```
api/interactions.ts      Discord → slash commands, autocomplete, buttons (signature-verified)
api/cron/reminders.ts    Vercel Cron → daily reminder run (protected by CRON_SECRET)
src/config.ts            e-board structure + settings
src/handlers.ts          command logic
src/reminders.ts         reminder schedule
src/permissions.ts       role matching + who-can-assign rules
src/db.ts                Postgres (Neon) queries; table auto-created
src/dates.ts             "friday" → 2026-09-25, in Eastern time
scripts/register-commands.ts
test/                    npm test: runs everything against a fake Discord + in-memory Postgres
```

`npm test` runs 19 tests covering date parsing, permissions, the reminder schedule, and full
assign → remind → done flows. `npm run typecheck` checks types.
