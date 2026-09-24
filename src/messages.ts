import { ZONES } from "./config.js";
import type { Task, TaskEvent } from "./db.js";
import { daysBetween, formatDate, relativeDue, todayISO } from "./dates.js";
import type { MessagePayload } from "./discord.js";

export const EPHEMERAL = 64;

const COLOR = { open: 0x3b82f6, soon: 0xf59e0b, overdue: 0xdc2626, done: 0x16a34a, cancelled: 0x6b7280 };

/** A zone task is one assigned to a whole role (as opposed to named people). */
export const isZoneTask = (task: Pick<Task, "assignees">) => task.assignees.some((a) => a.kind === "role");

export function mentions(task: Pick<Task, "assignees">): string {
  return task.assignees.map((a) => (a.kind === "role" ? `<@&${a.id}>` : `<@${a.id}>`)).join(", ");
}

/** Only ping the assignees, never @everyone or anyone quoted in a title. */
export function allowedMentions(task: Pick<Task, "assignees">) {
  return {
    users: task.assignees.filter((a) => a.kind === "user").map((a) => a.id),
    roles: task.assignees.filter((a) => a.kind === "role").map((a) => a.id),
  };
}

export const assigneeLabels = (task: Pick<Task, "assignees">) => task.assignees.map((a) => a.label).join(", ");

function zoneNames(task: Task) {
  return task.zones.map((k) => ZONES.find((z) => z.key === k)?.name ?? k).join(", ");
}

export function taskEmbed(task: Task, now = new Date()) {
  const days = daysBetween(todayISO(now), task.due);
  const color =
    task.status === "done" ? COLOR.done
    : task.status === "cancelled" ? COLOR.cancelled
    : days < 0 ? COLOR.overdue
    : days <= 1 ? COLOR.soon
    : COLOR.open;
  const dueText = task.status === "open" ? `${formatDate(task.due, now)} (${relativeDue(days)})` : formatDate(task.due, now);
  const fields = [
    { name: "📅 Due", value: dueText, inline: true },
    { name: "Assigned to", value: mentions(task), inline: true },
    { name: "Assigned by", value: `<@${task.createdBy}>`, inline: true },
  ];
  if (task.zones.length) fields.push({ name: "🏢 Zone", value: zoneNames(task), inline: true });
  if (task.status === "done" && task.completedBy) fields.push({ name: "Completed by", value: `<@${task.completedBy}>`, inline: true });
  if (task.status === "cancelled" && task.cancelledBy) fields.push({ name: "Cancelled by", value: `<@${task.cancelledBy}>`, inline: true });
  const prefix = task.status === "done" ? "✅ " : task.status === "cancelled" ? "🚫 " : "";
  return {
    title: `${prefix}${task.title}`.slice(0, 256),
    description: task.details ?? undefined,
    color,
    fields,
  };
}

export function doneButton(taskId: number) {
  return [
    {
      type: 1,
      components: [{ type: 2, style: 3, label: "Mark Complete", emoji: { name: "✅" }, custom_id: `done:${taskId}` }],
    },
  ];
}

const ZONE_NOTE = "This is a zone task: your zone head (or any CEO) marks it complete.";

/**
 * Announcement when a task is created, reassigned or re-dated.
 * `withButton` is false for zone-task DMs to zone members, who can't complete zone tasks.
 */
export function assignedMessage(
  task: Task,
  verb: "assigned" | "reassigned" | "updated",
  now = new Date(),
  withButton = true,
): MessagePayload {
  const lead =
    verb === "updated" ? `📌 ${mentions(task)}, this task's due date changed.`
    : verb === "reassigned" ? `📌 ${mentions(task)}, this task has been reassigned to you.`
    : `📌 ${mentions(task)}, you've been given a new task.`;
  return {
    content: isZoneTask(task) && !withButton ? `${lead}\n${ZONE_NOTE}` : lead,
    embeds: [taskEmbed(task, now)],
    components: withButton ? doneButton(task.id) : [],
    allowed_mentions: allowedMentions(task),
  };
}

export function reminderMessage(task: Task, days: number, now = new Date(), withButton = true): MessagePayload {
  const lead =
    days < 0 ? `⚠️ ${mentions(task)}, this task is **${relativeDue(days)}**.`
    : days === 0 ? `⏰ ${mentions(task)}, this task is **due today**.`
    : `🔔 ${mentions(task)}, this task is due **${relativeDue(days)}**.`;
  const tail = withButton ? " Hit **Mark Complete** when it's finished." : `\n${ZONE_NOTE}`;
  return {
    content: lead + tail,
    embeds: [taskEmbed(task, now)],
    components: withButton ? doneButton(task.id) : [],
    allowed_mentions: allowedMentions(task),
  };
}

/** Button labels max out at 80 characters; keep them short enough to scan. */
const shortTitle = (title: string) => (title.length > 30 ? title.slice(0, 29) + "…" : title);

/** One daily #task-alerts post listing every overdue task, with a complete button for each (max 25). */
export function overdueDigest(tasks: Task[], now = new Date()): MessagePayload {
  const today = todayISO(now);
  const lines = tasks.map(
    (t) => `• **${t.title}** · ${mentions(t)} · ${relativeDue(daysBetween(today, t.due))}`,
  );
  let content = `⚠️ **Overdue tasks (${tasks.length})**\n`;
  for (const [n, line] of lines.entries()) {
    if (content.length + line.length > 1900) {
      content += `…and ${lines.length - n} more. Use \`/tasks overdue:True\` to see all.`;
      break;
    }
    content += line + "\n";
  }
  const buttons = tasks.slice(0, 25).map((t) => ({
    type: 2, style: 2, label: shortTitle(t.title), emoji: { name: "✅" }, custom_id: `done:${t.id}:digest`,
  }));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 5) rows.push({ type: 1, components: buttons.slice(i, i + 5) });
  const users = [...new Set(tasks.flatMap((t) => allowedMentions(t).users))];
  const roles = [...new Set(tasks.flatMap((t) => allowedMentions(t).roles))];
  return { content, components: rows, allowed_mentions: { users, roles } };
}

export function completedNotice(task: Task, byUserId: string): MessagePayload {
  return { content: `✅ <@${byUserId}> completed **${task.title}**.`, allowed_mentions: { parse: [] } };
}

/** One line per task, for /tasks. */
export function taskLine(task: Task, now = new Date()): string {
  const days = daysBetween(todayISO(now), task.due);
  const flag = days < 0 ? "🔴" : days <= 1 ? "🟠" : "🔵";
  return `${flag} **${task.title}** · ${mentions(task)} · ${formatDate(task.due, now)} (${relativeDue(days)}) · #${task.id}`;
}

/** Short label for autocomplete menus (max 100 chars). */
export function taskChoiceName(task: Task, now = new Date()): string {
  const label = `#${task.id} · ${task.title} · ${assigneeLabels(task)} · due ${formatDate(task.due, now)}`;
  return label.length > 100 ? label.slice(0, 99) + "…" : label;
}

const ACTION_WORD: Record<string, string> = {
  created: "created it",
  edited: "edited it",
  completed: "marked it complete",
  cancelled: "cancelled it",
};

/** Task history for /view-task. */
export function historyText(events: TaskEvent[]): string {
  if (!events.length) return "No history recorded.";
  const lines = events.map((e) => {
    const when = `<t:${Math.floor(Date.parse(e.at) / 1000)}:f>`;
    const what = ACTION_WORD[e.action] ?? e.action;
    return `• ${when} <@${e.actor}> ${what}${e.details ? `: ${e.details}` : ""}`;
  });
  let out = "";
  for (const line of lines.slice(-15)) out += line.slice(0, 200) + "\n";
  return (lines.length > 15 ? `…${lines.length - 15} earlier entries\n` : "") + out;
}
