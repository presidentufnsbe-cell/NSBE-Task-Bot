import { ZONES } from "./config.js";
import { daysBetween, formatDate, parseDue, relativeDue, todayISO } from "./dates.js";
import * as db from "./db.js";
import type { Task } from "./db.js";
import { displayName, getMember, roleNames, sendChannelMessage } from "./discord.js";
import { assignedMessage, completedNotice, EPHEMERAL, taskChoiceName, taskEmbed, taskLine } from "./messages.js";
import { checkCanAssign, profileFromRoleNames, zonesForTarget, type Profile, type Target } from "./permissions.js";
import { initialReminderMark, notifyTask } from "./reminders.js";

// Discord interaction + response type numbers.
const PING = 1,
  COMMAND = 2,
  COMPONENT = 3,
  AUTOCOMPLETE = 4;
const R_PONG = 1,
  R_MESSAGE = 4,
  R_UPDATE = 7,
  R_CHOICES = 8;

/** Run work after the response has been sent (Discord needs an answer within 3 seconds). */
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

async function resolveTarget(i: any, id: string): Promise<{ target: Target; label: string } | { error: string }> {
  const role = i.data?.resolved?.roles?.[id];
  if (role) return { target: { kind: "role", id, name: role.name }, label: `@${role.name}` };

  const user = i.data?.resolved?.users?.[id];
  const member = i.data?.resolved?.members?.[id];
  if (!user) return { error: "I couldn't find that person." };
  if (user.bot) return { error: "Bots can't be assigned tasks." };
  if (!member) return { error: "That person isn't in this server." };
  const profile = profileFromRoleNames(await roleNames(member.roles ?? []));
  return { target: { kind: "user", id, profile }, label: displayName(user, member.nick) };
}

function canManage(actor: Actor, task: Task) {
  return actor.profile.isExec || task.createdBy === actor.id;
}

function canClose(actor: Actor, task: Task) {
  const isAssignee =
    task.assigneeKind === "user" ? task.assigneeId === actor.id : actor.roleIds.includes(task.assigneeId);
  return isAssignee || canManage(actor, task);
}

const DATE_HELP = "Try something like `friday`, `10/3`, `next tuesday`, `in 2 weeks`, or `2026-10-03`.";

function readDue(raw: string, now: Date): { due: string } | { error: string } {
  const due = parseDue(raw, now);
  if (!due) return { error: `I couldn't read the due date "${raw}". ${DATE_HELP}` };
  if (due < todayISO(now)) return { error: `${formatDate(due, now)} is in the past. ${DATE_HELP}` };
  return { due };
}

const alertsChannel = () => process.env.TASK_ALERTS_CHANNEL_ID;

// ---------------------------------------------------------------- commands

async function assign(i: any, actor: Actor, defer: Defer, now: Date) {
  const o = options(i);
  const due = readDue(o.due.value, now);
  if ("error" in due) return reply(due.error);

  const resolved = await resolveTarget(i, o.who.value);
  if ("error" in resolved) return reply(resolved.error);
  const denied = checkCanAssign(actor.id, actor.profile, resolved.target);
  if (denied) return reply(denied);

  const days = daysBetween(todayISO(now), due.due);
  const task = await db.createTask({
    title: o.task.value.trim(),
    details: o.details?.value?.trim() || null,
    due: due.due,
    assigneeKind: resolved.target.kind,
    assigneeId: resolved.target.id,
    assigneeLabel: resolved.label,
    zones: zonesForTarget(resolved.target),
    createdBy: actor.id,
    lastReminder: initialReminderMark(days),
  });
  defer(notifyTask(task, assignedMessage(task, "assigned", now)));

  return reply(
    `Created **#${task.id}** for **${resolved.label}**, due **${formatDate(task.due, now)}** (${relativeDue(days)}). ` +
      `They've been notified${alertsChannel() ? ` in <#${alertsChannel()}>` : ""} and by DM.`,
  );
}

async function listTasks(i: any, actor: Actor, now: Date) {
  const o = options(i);
  let tasks: Task[];
  let heading: string;

  if (o.zone) {
    const zone = ZONES.find((z) => z.key === o.zone.value);
    tasks = await db.listOpenTasks({ zone: zone?.key });
    heading = zone ? `Open tasks in the ${zone.name}` : "All open e-board tasks";
  } else if (o.person) {
    const member = i.data.resolved?.members?.[o.person.value];
    tasks = await db.listOpenTasks({ userId: o.person.value, roleIds: member?.roles ?? [] });
    heading = `Open tasks for <@${o.person.value}>`;
  } else {
    tasks = await db.listOpenTasks({ userId: actor.id, roleIds: actor.roleIds });
    heading = "Your open tasks";
  }

  if (!tasks.length) return reply(`**${heading}:** nothing open. 🎉`);

  let out = `**${heading}** (${tasks.length})\n`;
  let shown = 0;
  for (const t of tasks) {
    const line = taskLine(t, now) + "\n";
    if (out.length + line.length > 1850) break;
    out += line;
    shown++;
  }
  if (shown < tasks.length) out += `…and ${tasks.length - shown} more.\n`;
  out += "\nFinished one? Use `/done` or hit **Mark done** on its reminder.";
  return reply(out);
}

async function finish(actor: Actor, task: Task | null, defer: Defer, fromChannel: string | undefined) {
  if (!task) return { error: "That task doesn't exist (it may have been deleted)." };
  if (task.status === "done") return { already: task };
  if (!canClose(actor, task))
    return { error: `Only the person assigned to **#${task.id}**, whoever assigned it, or a CEO can close it.` };
  const done = await db.completeTask(task.id, actor.id);
  if (!done) return { already: (await db.getTask(task.id)) ?? task };
  const channel = alertsChannel();
  if (channel && fromChannel !== channel) defer(sendChannelMessage(channel, completedNotice(done, actor.id)));
  return { done };
}

async function doneCommand(i: any, actor: Actor, defer: Defer) {
  const task = await db.getTask(options(i).task.value);
  const r = await finish(actor, task, defer, undefined);
  if ("error" in r) return reply(r.error!);
  if ("already" in r) return reply(`**#${r.already!.id}** was already marked done.`);
  return reply(`✅ Marked **#${r.done!.id} · ${r.done!.title}** as done. Nice work!`);
}

async function editTask(i: any, actor: Actor, defer: Defer, now: Date) {
  const o = options(i);
  const task = await db.getTask(o.task.value);
  if (!task || task.status !== "open") return reply("That task doesn't exist or is already done.");
  if (!canManage(actor, task)) return reply("Only whoever assigned this task, or a CEO, can edit it.");

  const update: db.TaskUpdate = {};
  if (o["task-name"]) update.title = o["task-name"].value.trim();
  if (o.details) update.details = o.details.value.trim() === "-" ? null : o.details.value.trim();

  let dueChanged = false;
  if (o.due) {
    const due = readDue(o.due.value, now);
    if ("error" in due) return reply(due.error);
    if (due.due !== task.due) {
      update.due = due.due;
      update.lastReminder = initialReminderMark(daysBetween(todayISO(now), due.due));
      update.overdueSent = false;
      dueChanged = true;
    }
  }

  let reassigned = false;
  if (o.who) {
    const resolved = await resolveTarget(i, o.who.value);
    if ("error" in resolved) return reply(resolved.error);
    const denied = checkCanAssign(actor.id, actor.profile, resolved.target);
    if (denied) return reply(denied);
    if (resolved.target.id !== task.assigneeId) {
      Object.assign(update, {
        assigneeKind: resolved.target.kind,
        assigneeId: resolved.target.id,
        assigneeLabel: resolved.label,
        zones: zonesForTarget(resolved.target),
      });
      reassigned = true;
    }
  }

  if (!Object.keys(update).length) return reply("Nothing to change. Pick at least one field to edit.");
  const updated = (await db.updateTask(task.id, update))!;

  if (reassigned || dueChanged) defer(notifyTask(updated, assignedMessage(updated, reassigned ? "reassigned" : "updated", now)));
  const note = reassigned ? " The new assignee has been notified." : dueChanged ? " The assignee has been told about the new date." : "";
  return reply(`Updated **#${updated.id}**.${note}`, { embeds: [taskEmbed(updated, now)] });
}

async function deleteTask(i: any, actor: Actor) {
  const task = await db.getTask(options(i).task.value);
  if (!task) return reply("That task doesn't exist.");
  if (!canManage(actor, task)) return reply("Only whoever assigned this task, or a CEO, can delete it.");
  await db.deleteTask(task.id);
  return reply(`🗑️ Deleted **#${task.id} · ${task.title}**.`);
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
  if (i.data.name === "done") lists.push(await db.listOpenTasks({ userId: actor.id, roleIds: actor.roleIds, search, limit: 25 }));
  lists.push(await db.listOpenTasks(actor.profile.isExec ? { search, limit: 25 } : { createdBy: actor.id, search, limit: 25 }));

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
  const [action, rawId] = String(i.data.custom_id).split(":");
  if (action !== "done") return reply("Unknown button.");
  const actor = await getActor(i);
  const r = await finish(actor, await db.getTask(Number(rawId)), defer, i.channel_id);
  if ("error" in r) return reply(r.error!);
  const task = "done" in r ? r.done! : r.already!;
  return {
    type: R_UPDATE,
    data: {
      content: `✅ Done${task.completedBy ? `, completed by <@${task.completedBy}>` : ""}.`,
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
      case "done":
        return await doneCommand(i, actor, defer);
      case "edit-task":
        return await editTask(i, actor, defer, now);
      case "delete-task":
        return await deleteTask(i, actor);
      default:
        return reply("Unknown command.");
    }
  } catch (err) {
    console.error("Interaction failed", err);
    if (i.type === AUTOCOMPLETE) return { type: R_CHOICES, data: { choices: [] } };
    return reply("Something went wrong on my end. Try again in a moment, and tell the webmaster if it keeps happening.");
  }
}
