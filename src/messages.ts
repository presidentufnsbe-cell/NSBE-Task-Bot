import type { Task } from "./db.js";
import { daysBetween, formatDate, relativeDue, todayISO } from "./dates.js";
import type { MessagePayload } from "./discord.js";

export const EPHEMERAL = 64;

const COLOR = { open: 0x3b82f6, soon: 0xf59e0b, overdue: 0xdc2626, done: 0x16a34a };

export function mention(task: Pick<Task, "assigneeKind" | "assigneeId">): string {
  return task.assigneeKind === "role" ? `<@&${task.assigneeId}>` : `<@${task.assigneeId}>`;
}

/** Only ping the assignee, never @everyone or anyone quoted in a title. */
export function allowedMentions(task: Pick<Task, "assigneeKind" | "assigneeId">) {
  return task.assigneeKind === "role" ? { roles: [task.assigneeId] } : { users: [task.assigneeId] };
}

export function taskEmbed(task: Task, now = new Date()) {
  const days = daysBetween(todayISO(now), task.due);
  const color =
    task.status === "done" ? COLOR.done : days < 0 ? COLOR.overdue : days <= 1 ? COLOR.soon : COLOR.open;
  const dueText = task.status === "done" ? formatDate(task.due, now) : `${formatDate(task.due, now)} (${relativeDue(days)})`;
  const fields = [
    { name: "Due", value: dueText, inline: true },
    { name: "Assigned to", value: mention(task), inline: true },
    { name: "Assigned by", value: `<@${task.createdBy}>`, inline: true },
  ];
  if (task.status === "done" && task.completedBy) fields.push({ name: "Completed by", value: `<@${task.completedBy}>`, inline: true });
  return {
    title: `${task.status === "done" ? "✅ " : ""}#${task.id} · ${task.title}`.slice(0, 256),
    description: task.details ?? undefined,
    color,
    fields,
  };
}

export function doneButton(taskId: number) {
  return [
    {
      type: 1,
      components: [{ type: 2, style: 3, label: "Mark done", emoji: { name: "✅" }, custom_id: `done:${taskId}` }],
    },
  ];
}

/** Announcement when a task is created or reassigned. */
export function assignedMessage(task: Task, verb: "assigned" | "reassigned" | "updated", now = new Date()): MessagePayload {
  return {
    content: `📌 ${mention(task)}, you've been ${verb === "updated" ? "sent an updated" : "given a"} task${verb === "reassigned" ? " (reassigned)" : ""}.`,
    embeds: [taskEmbed(task, now)],
    components: doneButton(task.id),
    allowed_mentions: allowedMentions(task),
  };
}

export function reminderMessage(task: Task, days: number, now = new Date()): MessagePayload {
  const lead =
    days < 0 ? `⚠️ ${mention(task)}, this task is **${relativeDue(days)}**.` : days === 0
      ? `⏰ ${mention(task)}, this task is **due today**.`
      : `⏰ ${mention(task)}, reminder: this task is due **${relativeDue(days)}**.`;
  return {
    content: `${lead} Hit **Mark done** when it's finished.`,
    embeds: [taskEmbed(task, now)],
    components: doneButton(task.id),
    allowed_mentions: allowedMentions(task),
  };
}

export function completedNotice(task: Task, byUserId: string): MessagePayload {
  return {
    content: `✅ <@${byUserId}> completed **#${task.id} · ${task.title}**.`,
    allowed_mentions: { parse: [] },
  };
}

/** One line per task, for /tasks. */
export function taskLine(task: Task, now = new Date()): string {
  const days = daysBetween(todayISO(now), task.due);
  const flag = days < 0 ? "🔴" : days <= 1 ? "🟠" : "🔵";
  return `${flag} **#${task.id}** ${task.title} · ${mention(task)} · ${formatDate(task.due, now)} (${relativeDue(days)})`;
}

/** Short label for autocomplete menus (max 100 chars). */
export function taskChoiceName(task: Task, now = new Date()): string {
  const label = `#${task.id} · ${task.title} · ${task.assigneeLabel} · due ${formatDate(task.due, now)}`;
  return label.length > 100 ? label.slice(0, 99) + "…" : label;
}
