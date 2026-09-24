import { SETTINGS, ZONES } from "./config.js";
import { daysBetween, formatDate, parseDue, relativeDue, todayISO } from "./dates.js";
import * as db from "./db.js";
import type { Assignee, Task } from "./db.js";
import { displayName, getMember, roleNames, sendChannelMessage } from "./discord.js";
import {
  assignedMessage,
  assigneeLabels,
  completedNotice,
  EPHEMERAL,
  historyText,
  isZoneTask,
  taskChoiceName,
  taskEmbed,
  taskLine,
} from "./messages.js";
import { checkCanAssign, profileFromRoleNames, zonesForTarget, type Profile, type Target } from "./permissions.js";
import { deliver, initialReminderMark } from "./reminders.js";

// Discord interaction + response type numbers.
const PING = 1,
  COMMAND = 2,
  COMPONENT = 3,
  AUTOCOMPLETE = 4;
const R_PONG = 1,
  R_MESSAGE = 4,
  R_UPDATE = 7,
  R_CHOICES = 8;

/** Work to finish before/after the reply (sending notifications). */
export type Defer = (work: Promise<unknown>) => void;

const reply = (content: string, extra: object = {}) => ({
  type: R_MESSAGE,
  data: { content, flags: EPHEMERAL, allowed_mentions: { parse: [] }, ...extra },
});

interface Actor {
  id: string;
  roleIds: string[];
  profile: Profile;
}

async function getActor(i: any): Promise<Actor> {
  const id: string = i.member?.user?.id ?? i.user?.id;
  let roleIds: string[] = i.member?.roles;
  if (!roleIds) {
    // Button pressed in a DM: there's no member info, so look it up.
    roleIds = await getMember(id).then((m) => m.roles, () => []);
  }
  return { id, roleIds, profile: profileFromRoleNames(await roleNames(roleIds)) };
}

function options(i: any): Record<string, any> {
  const out: Record<string, any> = {};
  for (const o of i.data?.options ?? []) out[o.name] = o;
  return out;
}

const WHO_OPTIONS = ["who", ...Array.from({ length: SETTINGS.maxAssignees - 1 }, (_, n) => `who-${n + 2}`)];

async function resolveTarget(i: any, id: string): Promise<{ target: Target; assignee: Assignee } | { error: string }> {
  const role = i.data?.resolved?.roles?.[id];
  if (role) return { target: { kind: "role", id, name: role.name }, assignee: { kind: "role", id, label: `@${role.name}` } };

  const user = i.data?.resolved?.users?.[id];
  const member = i.data?.resolved?.members?.[id];
  if (!user) return { error: "I couldn't find that person." };
  if (user.bot) return { error: "Bots can't be assigned tasks." };
  if (!member) return { error: `<@${id}> isn't in this server.` };
  const profile = profileFromRoleNames(await roleNames(member.roles ?? []));
  return { target: { kind: "user", id, profile }, assignee: { kind: "user", id, label: displayName(user, member.nick) } };
}

/** Reads who / who-2 / who-3, checks each one, and returns the assignee list. */
async function readAssignees(
  i: any,
  actor: Actor,
): Promise<{ assignees: Assignee[]; zones: string[] } | { error: string } | null> {
  const o = options(i);
  const ids = [...new Set(WHO_OPTIONS.map((n) => o[n]?.value).filter(Boolean) as string[])];
  if (!ids.length) return null;
  const assignees: Assignee[] = [];
  const zones: string[] = [];
  for (const id of ids) {
    const r = await resolveTarget(i, id);
    if ("error" in r) return r;
    const denied = checkCanAssign(actor.id, actor.profile, r.target);
    if (denied) return { error: ids.length > 1 ? `**${r.assignee.label}:** ${denied}` : denied };
    assignees.push(r.assignee);
    zones.push(...zonesForTarget(r.target));
  }
  return { assignees, zones };
}

/** CEOs, and whoever created the task, can edit or cancel it. */
function canManage(actor: Actor, task: Task) {
  return actor.profile.isExec || task.createdBy === actor.id;
}

/**
 * Completing: any CEO, or a person the task is assigned to by name.
 * Zone tasks (assigned to a whole zone role) are completed by the zone head, who is a CEO.
 */
function closeDenied(actor: Actor, task: Task): string | null {
  if (actor.profile.isExec) return null;
  if (task.assignees.some((a) => a.kind === "user" && a.id === actor.id)) return null;
  if (task.assignees.some((a) => a.kind === "role" && actor.roleIds.includes(a.id)))
    return `**${task.title}** is a zone task, so your zone head (or any CEO) marks it complete.`;
  return `Only the people assigned to **${task.title}**, or a CEO, can mark it complete.`;
}

const DATE_HELP = "Try something like `friday`, `10/3`, `next tuesday`, `in 2 weeks`, or `2026-10-03`.";

function readDue(raw: string, now: Date): { due: string } | { error: string } {
  const due = parseDue(raw, now);
  if (!due) return { error: `I couldn't read the due date "${raw}". ${DATE_HELP}` };
  if (due < todayISO(now)) return { error: `${formatDate(due, now)} is in the past. ${DATE_HELP}` };
  return { due };
}

const alertsChannel = () => process.env.TASK_ALERTS_CHANNEL_ID;

function notified(task: Task) {
  return isZoneTask(task) ? `They've been notified by DM and in <#${alertsChannel()}>.` : "They've been notified by DM.";
}

// ---------------------------------------------------------------- commands

async function assign(i: any, actor: Actor, defer: Defer, now: Date) {
  const o = options(i);
  const due = readDue(o.due.value, now);
  if ("error" in due) return reply(due.error);

  const who = await readAssignees(i, actor);
  if (!who) return reply("Pick who the task is for.");
  if ("error" in who) return reply(who.error);

  const days = daysBetween(todayISO(now), due.due);
  const task = await db.createTask({
    title: o.task.value.trim(),
    details: o.details?.value?.trim() || null,
    due: due.due,
    assignees: who.assignees,
    zones: who.zones,
    createdBy: actor.id,
    lastReminder: initialReminderMark(days),
  });
  // Individual tasks: DM only. Zone tasks are "zone activity", so they also go to #task-alerts.
  defer(deliver(task, (b) => assignedMessage(task, "assigned", now, b), { channel: isZoneTask(task) }));

  return reply(
    `Created **${task.title}** for **${assigneeLabels(task)}**, due **${formatDate(task.due, now)}** (${relativeDue(days)}). ${notified(task)}`,
  );
}

async function listTasks(i: any, actor: Actor, now: Date) {
  const o = options(i);
  const overdue = !!o.overdue?.value;
  const dueBefore = overdue ? todayISO(now) : undefined;
  let tasks: Task[];
  let heading: string;

  if (o.zone) {
    const zone = ZONES.find((z) => z.key === o.zone.value);
    tasks = await db.listOpenTasks({ zone: zone?.key, dueBefore });
    heading = zone ? `${overdue ? "Overdue" : "Open"} tasks in the ${zone.name}` : `All ${overdue ? "overdue" : "open"} e-board tasks`;
  } else if (o.person) {
    const member = i.data.resolved?.members?.[o.person.value];
    tasks = await db.listOpenTasks({ userId: o.person.value, roleIds: member?.roles ?? [], dueBefore });
    heading = `${overdue ? "Overdue" : "Open"} tasks for <@${o.person.value}>`;
  } else if (overdue) {
    tasks = await db.listOpenTasks({ dueBefore });
    heading = "All overdue e-board tasks";
  } else {
    tasks = await db.listOpenTasks({ userId: actor.id, roleIds: actor.roleIds });
    heading = "Your open tasks";
  }

  if (!tasks.length) return reply(`**${heading}:** nothing ${overdue ? "overdue" : "open"}. 🎉`);

  let out = `**${heading}** (${tasks.length})\n`;
  let shown = 0;
  for (const t of tasks) {
    const line = taskLine(t, now) + "\n";
    if (out.length + line.length > 1850) break;
    out += line;
    shown++;
  }
  if (shown < tasks.length) out += `…and ${tasks.length - shown} more.\n`;
  out += "\n`/view-task` for details · `/done` or **Mark Complete** when finished.";
  return reply(out);
}

async function viewTask(i: any, now: Date) {
  const task = await db.getTask(options(i).task.value);
  if (!task) return reply("That task doesn't exist.");
  const events = await db.getEvents(task.id);
  return reply(`**History of #${task.id} · ${task.title}**\n${historyText(events)}`.slice(0, 2000), { embeds: [taskEmbed(task, now)] });
}

async function finish(actor: Actor, task: Task | null) {
  if (!task) return { error: "That task doesn't exist." };
  if (task.status === "cancelled") return { error: `**${task.title}** was cancelled.` };
  if (task.status === "done") return { already: task };
  const denied = closeDenied(actor, task);
  if (denied) return { error: denied };
  const done = await db.completeTask(task.id, actor.id);
  if (!done) return { already: (await db.getTask(task.id)) ?? task };
  return { done };
}

/** Zone-task completions are announced in #task-alerts (unless the click happened there). */
function announceCompletion(task: Task, actorId: string, defer: Defer, fromChannel: string | undefined, force = false) {
  const channel = alertsChannel();
  if (!channel) return;
  if (force || (isZoneTask(task) && fromChannel !== channel)) defer(sendChannelMessage(channel, completedNotice(task, actorId)));
}

async function doneCommand(i: any, actor: Actor, defer: Defer) {
  const r = await finish(actor, await db.getTask(options(i).task.value));
  if ("error" in r) return reply(r.error!);
  if ("already" in r) return reply(`**${r.already!.title}** was already marked complete.`);
  announceCompletion(r.done!, actor.id, defer, i.channel_id);
  return reply(`✅ Marked **${r.done!.title}** complete. Nice work!`);
}

async function editTask(i: any, actor: Actor, defer: Defer, now: Date) {
  const o = options(i);
  const task = await db.getTask(o.task.value);
  if (!task || task.status !== "open") return reply("That task doesn't exist or is already closed.");
  if (!canManage(actor, task)) return reply("Only whoever assigned this task, or a CEO, can edit it.");

  const update: db.TaskUpdate = {};
  const changes: string[] = [];
  if (o["task-name"]) {
    update.title = o["task-name"].value.trim();
    changes.push(`title "${task.title}" → "${update.title}"`);
  }
  if (o.details) {
    update.details = o.details.value.trim() === "-" ? null : o.details.value.trim();
    changes.push(update.details ? "details changed" : "details cleared");
  }

  let dueChanged = false;
  if (o.due) {
    const due = readDue(o.due.value, now);
    if ("error" in due) return reply(due.error);
    if (due.due !== task.due) {
      update.due = due.due;
      update.lastReminder = initialReminderMark(daysBetween(todayISO(now), due.due));
      update.lastOverdue = null;
      changes.push(`due ${task.due} → ${due.due}`);
      dueChanged = true;
    }
  }

  let reassigned = false;
  const who = await readAssignees(i, actor);
  if (who && "error" in who) return reply(who.error);
  if (who) {
    const before = task.assignees.map((a) => a.id).sort().join();
    const after = who.assignees.map((a) => a.id).sort().join();
    if (before !== after) {
      update.assignees = who.assignees;
      update.zones = who.zones;
      changes.push(`assigned to ${assigneeLabels(task)} → ${who.assignees.map((a) => a.label).join(", ")}`);
      reassigned = true;
    }
  }

  if (!changes.length) return reply("Nothing to change. Pick at least one field to edit.");
  const updated = (await db.updateTask(task.id, update))!;
  await db.logEvent(task.id, actor.id, "edited", changes.join("; "));

  if (reassigned || dueChanged) {
    defer(
      deliver(updated, (b) => assignedMessage(updated, reassigned ? "reassigned" : "updated", now, b), {
        channel: isZoneTask(updated),
      }),
    );
  }
  const note = reassigned ? " The new assignees have been notified." : dueChanged ? " The assignees have been told about the new date." : "";
  return reply(`Updated **${updated.title}**.${note}`, { embeds: [taskEmbed(updated, now)] });
}

async function cancelTask(i: any, actor: Actor) {
  const o = options(i);
  const task = await db.getTask(o.task.value);
  if (!task) return reply("That task doesn't exist.");
  if (task.status !== "open") return reply(`**${task.title}** is already ${task.status === "done" ? "complete" : "cancelled"}.`);
  if (!canManage(actor, task)) return reply("Only whoever assigned this task, or a CEO, can cancel it.");
  await db.cancelTask(task.id, actor.id, o.reason?.value?.trim() || null);
  return reply(`🚫 Cancelled **${task.title}**. It won't send any more reminders, and it stays in the history.`);
}

// ---------------------------------------------------------------- autocomplete

function dueChoices(value: string, now: Date) {
  const text = value.trim();
  const suggestions = text ? [text] : ["tomorrow", "friday", "next monday", "in 1 week", "in 2 weeks"];
  const choices = [];
  for (const s of suggestions) {
    const due = parseDue(s, now);
    if (!due || due < todayISO(now)) continue;
    const days = daysBetween(todayISO(now), due);
    choices.push({ name: `${formatDate(due, now)} (${relativeDue(days)})`, value: due });
  }
  if (!choices.length && text) choices.push({ name: `Can't read "${text.slice(0, 40)}" yet. Try friday, 10/3, next tue`, value: text.slice(0, 100) });
  return choices;
}

async function taskChoices(i: any, actor: Actor, search: string, now: Date) {
  const lists: Task[][] = [];
  const cmd = i.data.name;
  const all = { search, limit: 25 };
  if (cmd === "view-task") lists.push(await db.listOpenTasks(all));
  else {
    if (cmd === "done") lists.push(await db.listOpenTasks({ userId: actor.id, roleIds: actor.roleIds, ...all }));
    lists.push(await db.listOpenTasks(actor.profile.isExec ? all : { createdBy: actor.id, ...all }));
  }

  const seen = new Set<number>();
  const choices = [];
  for (const t of lists.flat()) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    choices.push({ name: taskChoiceName(t, now), value: t.id });
  }
  return choices.slice(0, 25);
}

async function autocomplete(i: any, now: Date) {
  const focused = (i.data.options ?? []).find((o: any) => o.focused);
  let choices: { name: string; value: string | number }[] = [];
  if (focused?.name === "due") choices = dueChoices(String(focused.value ?? ""), now);
  else if (focused?.name === "task") choices = await taskChoices(i, await getActor(i), String(focused.value ?? ""), now);
  return { type: R_CHOICES, data: { choices } };
}

// ---------------------------------------------------------------- buttons

async function button(i: any, defer: Defer, now: Date) {
  const [action, rawId, source] = String(i.data.custom_id).split(":");
  if (action !== "done") return reply("Unknown button.");
  const actor = await getActor(i);
  const r = await finish(actor, await db.getTask(Number(rawId)));
  if ("error" in r) return reply(r.error!);

  // Buttons on the daily overdue summary: keep the summary as is, confirm privately, tell the channel.
  if (source === "digest") {
    if ("already" in r) return reply(`**${r.already!.title}** was already marked complete.`);
    announceCompletion(r.done!, actor.id, defer, i.channel_id, true);
    return reply(`✅ Marked **${r.done!.title}** complete.`);
  }

  const task = "done" in r ? r.done! : r.already!;
  if ("done" in r) announceCompletion(task, actor.id, defer, i.channel_id);
  return {
    type: R_UPDATE,
    data: {
      content: `✅ Completed${task.completedBy ? ` by <@${task.completedBy}>` : ""}.`,
      embeds: [taskEmbed(task, now)],
      components: [],
      allowed_mentions: { parse: [] },
    },
  };
}

// ---------------------------------------------------------------- entry point

export async function handleInteraction(i: any, defer: Defer, now = new Date()): Promise<object> {
  try {
    if (i.type === PING) return { type: R_PONG };
    if (i.type === AUTOCOMPLETE) return await autocomplete(i, now);
    if (i.type === COMPONENT) return await button(i, defer, now);
    if (i.type !== COMMAND) return reply("Unsupported interaction.");

    if (process.env.DISCORD_GUILD_ID && i.guild_id !== process.env.DISCORD_GUILD_ID)
      return reply("This bot only works in the NSBE server.");

    const actor = await getActor(i);
    if (!actor.profile.isEboard) return reply("The task bot is for e-board members only (for now).");

    switch (i.data.name) {
      case "assign":
        return await assign(i, actor, defer, now);
      case "tasks":
        return await listTasks(i, actor, now);
      case "view-task":
        return await viewTask(i, now);
      case "done":
        return await doneCommand(i, actor, defer);
      case "edit-task":
        return await editTask(i, actor, defer, now);
      case "cancel-task":
        return await cancelTask(i, actor);
      default:
        return reply("That command was removed. Try `/cancel-task` or `/tasks`.");
    }
  } catch (err) {
    console.error("Interaction failed", err);
    if (i.type === AUTOCOMPLETE) return { type: R_CHOICES, data: { choices: [] } };
    return reply("Something went wrong on my end. Try again in a moment, and tell the webmaster if it keeps happening.");
  }
}
