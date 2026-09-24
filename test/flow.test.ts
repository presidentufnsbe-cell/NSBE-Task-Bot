import { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setQuery } from "../src/db.js";
import { handleInteraction } from "../src/handlers.js";
import { runReminders } from "../src/reminders.js";

// ---- fake Discord server --------------------------------------------------
const GUILD = "g1", ALERTS = "alerts";
const ROLES = [
  { id: "r-ceo", name: "CEO" },
  { id: "r-ceb", name: "CEB" },
  { id: "r-social", name: "Membership Zone" },
  { id: "r-web", name: "Comm Zone" },
  { id: "r-member", name: "Member" },
];
const MEMBERS: Record<string, string[]> = {
  pres: ["r-ceo", "r-ceb"], maria: ["r-ceb", "r-social"], dev: ["r-ceb", "r-social"], web: ["r-ceb", "r-web"], rando: ["r-member"],
};
let posts: { channel: string; body: any }[] = [];
let dmBlocked = new Set<string>();

function fakeFetch(url: string, init: any = {}) {
  const path = url.replace("https://discord.com/api/v10", "");
  const method = init.method ?? "GET";
  const body = init.body ? JSON.parse(init.body) : undefined;
  const ok = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });
  if (method === "GET" && path === `/guilds/${GUILD}/roles`) return ok(ROLES);
  if (method === "GET" && path.startsWith(`/guilds/${GUILD}/members?`))
    return ok(Object.entries(MEMBERS).map(([id, roles]) => ({ user: { id, username: id }, roles })));
  let m = /^\/guilds\/g1\/members\/(\w+)$/.exec(path);
  if (method === "GET" && m) return ok({ user: { id: m[1], username: m[1] }, roles: MEMBERS[m[1]] ?? [] });
  if (method === "POST" && path === "/users/@me/channels") return ok({ id: `dm-${body.recipient_id}` });
  m = /^\/channels\/([\w-]+)\/messages$/.exec(path);
  if (method === "POST" && m) {
    if (dmBlocked.has(m[1].replace("dm-", "")))
      return new Response(JSON.stringify({ code: 50007, message: "Cannot send messages to this user" }), { status: 403 });
    posts.push({ channel: m[1], body });
    return ok({ id: "msg" });
  }
  return new Response(JSON.stringify({ message: `unhandled ${method} ${path}` }), { status: 404 });
}

// ---- interaction builders ---------------------------------------------------
const opt = (name: string, value: unknown, extra = {}) => ({ name, value, ...extra });
function command(userId: string, name: string, options: any[], resolved: any = {}) {
  return {
    type: 2, guild_id: GUILD, channel_id: "general",
    member: { user: { id: userId, username: userId }, roles: MEMBERS[userId] },
    data: { name, options, resolved },
  };
}
const resolveUser = (id: string) => ({
  users: { [id]: { id, username: id, global_name: id[0].toUpperCase() + id.slice(1) } },
  members: { [id]: { roles: MEMBERS[id], nick: null } },
});
const resolveRole = (id: string) => ({ roles: { [id]: ROLES.find((r) => r.id === id) } });

// Wed Sep 23 2026, 10am New York
const NOW = new Date("2026-09-23T14:00:00Z");
let deferred: Promise<unknown>[] = [];
const defer = (p: Promise<unknown>) => deferred.push(p);
async function run(i: any, now = NOW) {
  const res: any = await handleInteraction(i, defer, now);
  await Promise.all(deferred);
  deferred = [];
  return res;
}

beforeAll(async () => {
  process.env.DISCORD_GUILD_ID = GUILD;
  process.env.TASK_ALERTS_CHANNEL_ID = ALERTS;
  process.env.DISCORD_BOT_TOKEN = "test";
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
});
const pg = new PGlite();
beforeEach(async () => {
  setQuery(async (text, params) => (await pg.query(text, params as any[])).rows as any[]);
  await pg.exec("DROP TABLE IF EXISTS tasks");
  posts = [];
  dmBlocked = new Set();
});

describe("end-to-end flow", () => {
  it("president assigns a task: confirmation, #task-alerts post, DM", async () => {
    const res = await run(command("pres", "assign",
      [opt("who", "maria"), opt("task", "Book the room for the social"), opt("due", "friday")], resolveUser("maria")));
    expect(res.type).toBe(4);
    expect(res.data.flags).toBe(64);
    expect(res.data.content).toContain("Created **#1** for **Maria**, due **Fri, Sep 25** (in 2 days)");
    expect(posts.map((p) => p.channel)).toEqual([ALERTS, "dm-maria"]);
    expect(posts[0].body.content).toContain("<@maria>");
    expect(posts[0].body.allowed_mentions).toEqual({ users: ["maria"] });
    expect(posts[0].body.components[0].components[0].custom_id).toBe("done:1");
    expect(posts[1].body.allowed_mentions).toEqual({ parse: [] });
  });

  it("chairs can make tasks for themselves but not for others; non-e-board is turned away", async () => {
    let res = await run(command("maria", "assign", [opt("who", "web"), opt("task", "x"), opt("due", "friday")], resolveUser("web")));
    expect(res.data.content).toMatch(/Only CEOs/);
    res = await run(command("maria", "assign", [opt("who", "maria"), opt("task", "Mine"), opt("due", "10/1")], resolveUser("maria")));
    expect(res.data.content).toContain("Created **#1**");
    res = await run(command("rando", "tasks", []));
    expect(res.data.content).toMatch(/e-board members only/);
    res = await run(command("pres", "assign", [opt("who", "rando"), opt("task", "x"), opt("due", "friday")], resolveUser("rando")));
    expect(res.data.content).toMatch(/doesn't have an e-board role/);
  });

  it("rejects unreadable and past dates", async () => {
    let res = await run(command("pres", "assign", [opt("who", "maria"), opt("task", "x"), opt("due", "whenever")], resolveUser("maria")));
    expect(res.data.content).toMatch(/couldn't read the due date/);
    res = await run(command("pres", "assign", [opt("who", "maria"), opt("task", "x"), opt("due", "2026-09-01")], resolveUser("maria")));
    expect(res.data.content).toMatch(/in the past/);
  });

  it("assigning to a zone role pings the role and DMs everyone in it", async () => {
    await run(command("pres", "assign", [opt("who", "r-social"), opt("task", "Plan the retreat"), opt("due", "in 2 weeks")], resolveRole("r-social")));
    expect(posts.map((p) => p.channel)).toEqual([ALERTS, "dm-maria", "dm-dev"]);
    expect(posts[0].body.content).toContain("<@&r-social>");
    // either Social Chair can close it
    const res = await run({ type: 3, channel_id: "dm-dev", user: { id: "dev" }, data: { custom_id: "done:1" } });
    expect(res.type).toBe(7);
  });

  it("autocomplete shows how the date was read, and lists tasks", async () => {
    let res = await run({ type: 4, guild_id: GUILD, member: { user: { id: "pres" }, roles: MEMBERS.pres },
      data: { name: "assign", options: [{ name: "due", value: "next tue", focused: true }] } });
    expect(res.data.choices[0]).toEqual({ name: "Tue, Sep 29 (in 6 days)", value: "2026-09-29" });

    await run(command("pres", "assign", [opt("who", "maria"), opt("task", "Book the room"), opt("due", "friday")], resolveUser("maria")));
    res = await run({ type: 4, guild_id: GUILD, member: { user: { id: "maria" }, roles: MEMBERS.maria },
      data: { name: "done", options: [{ name: "task", value: "book", focused: true }] } });
    expect(res.data.choices).toEqual([{ name: "#1 · Book the room · Maria · due Fri, Sep 25", value: 1 }]);
  });

  it("/tasks lists open work", async () => {
    await run(command("pres", "assign", [opt("who", "maria"), opt("task", "Book the room"), opt("due", "friday")], resolveUser("maria")));
    let res = await run(command("maria", "tasks", []));
    expect(res.data.content).toContain("Your open tasks");
    expect(res.data.content).toContain("#1");
    res = await run(command("web", "tasks", [opt("zone", "membership")]));
    expect(res.data.content).toContain("Book the room");
    res = await run(command("web", "tasks", [opt("zone", "finance")]));
    expect(res.data.content).toContain("nothing open");
  });

  it("Mark done button from a DM closes the task and tells #task-alerts", async () => {
    await run(command("pres", "assign", [opt("who", "maria"), opt("task", "Book the room"), opt("due", "friday")], resolveUser("maria")));
    posts = [];
    // someone else can't close it
    let res = await run({ type: 3, channel_id: "dm-web", user: { id: "web" }, data: { custom_id: "done:1" } });
    expect(res.data.content).toMatch(/Only the person assigned/);
    res = await run({ type: 3, channel_id: "dm-maria", user: { id: "maria" }, data: { custom_id: "done:1" } });
    expect(res.type).toBe(7);
    expect(res.data.components).toEqual([]);
    expect(res.data.embeds[0].title).toBe("✅ #1 · Book the room");
    expect(posts).toHaveLength(1);
    expect(posts[0].channel).toBe(ALERTS);
    expect(posts[0].body.content).toContain("completed **#1 · Book the room**");
    // double click is harmless
    res = await run({ type: 3, channel_id: "dm-maria", user: { id: "maria" }, data: { custom_id: "done:1" } });
    expect(res.type).toBe(7);
    expect(posts).toHaveLength(1);
  });

  it("daily cron sends reminders on schedule and stops once done", async () => {
    await run(command("pres", "assign", [opt("who", "maria"), opt("task", "Submit budget"), opt("due", "10/10")], resolveUser("maria")));
    dmBlocked.add("maria"); // DMs off: channel reminder must still go out
    posts = [];
    const reminderDays: string[] = [];
    for (let d = 24; d <= 42; d++) {
      const day = new Date(Date.UTC(2026, 8, d, 13, 30));
      const summary = await runReminders(day);
      expect(summary.failed).toEqual([]);
      if (summary.sent.length) reminderDays.push(`${summary.today}:${summary.sent[0].kind}:${summary.sent[0].days}`);
    }
    expect(reminderDays).toEqual([
      "2026-10-03:before:7", "2026-10-07:before:3", "2026-10-09:before:1", "2026-10-10:before:0", "2026-10-11:overdue:-1",
    ]);
    expect(posts.every((p) => p.channel === ALERTS)).toBe(true);
    expect(posts[3].body.content).toContain("due today");
    expect(posts[4].body.content).toContain("1 day overdue");
  });

  it("editing the due date resets reminders and notifies; only creator/exec may edit", async () => {
    await run(command("pres", "assign", [opt("who", "maria"), opt("task", "Flyer"), opt("due", "tomorrow")], resolveUser("maria")));
    let res = await run(command("maria", "edit-task", [opt("task", 1), opt("due", "10/20")]));
    expect(res.data.content).toMatch(/Only whoever assigned/);
    posts = [];
    res = await run(command("pres", "edit-task", [opt("task", 1), opt("due", "10/20"), opt("who", "dev")], resolveUser("dev")));
    expect(res.data.content).toContain("new assignee has been notified");
    expect(posts.map((p) => p.channel)).toEqual([ALERTS, "dm-dev"]);
    const summary = await runReminders(new Date("2026-10-13T13:30:00Z"));
    expect(summary.sent).toEqual([{ id: 1, kind: "before", days: 7 }]);
    res = await run(command("pres", "delete-task", [opt("task", 1)]));
    expect(res.data.content).toContain("Deleted");
  });
});
