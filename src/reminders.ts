import { SETTINGS } from "./config.js";
import { daysBetween, todayISO, type ISODate } from "./dates.js";
import { openTasksDueBy, updateTask, type Task } from "./db.js";
import { membersWithRole, sendChannelMessage, sendDM } from "./discord.js";
import { reminderMessage } from "./messages.js";

const offsets = () => [...SETTINGS.reminderDaysBefore].sort((a, b) => a - b);

/** The reminder slot that covers `days` left: the smallest configured offset >= days. */
function slotFor(days: number): number | null {
  return offsets().find((o) => o >= days) ?? null;
}

/**
 * When a task is created (or its date changes) the assignee is notified right away,
 * which counts as the reminder for the current slot. Created 5 days out -> the
 * "1 week" slot is used up, the next reminder is the 3-day one.
 */
export function initialReminderMark(days: number): number | null {
  return days < 0 ? null : slotFor(days);
}

export type ReminderAction = { kind: "before"; slot: number; days: number } | { kind: "overdue"; days: number } | null;

/**
 * What (if anything) to send for a task today. Missed days catch up: if the cron
 * skipped the 3-day run, the next run sends a reminder with the real days left.
 */
export function reminderFor(task: Pick<Task, "due" | "lastReminder" | "overdueSent">, today: ISODate): ReminderAction {
  const days = daysBetween(today, task.due);
  if (days >= 0) {
    const slot = slotFor(days);
    if (slot === null) return null;
    if (task.lastReminder !== null && slot >= task.lastReminder) return null;
    return { kind: "before", slot, days };
  }
  // Overdue: one nudge, and don't dig up tasks that went stale long ago.
  if (SETTINGS.overdueNudge && !task.overdueSent && days >= -3) return { kind: "overdue", days };
  return null;
}

/** Channel post + DM(s) for one task. */
export async function notifyTask(task: Task, payload: Parameters<typeof sendChannelMessage>[1]) {
  const channelId = process.env.TASK_ALERTS_CHANNEL_ID;
  if (channelId) await sendChannelMessage(channelId, payload);

  const dmPayload = { ...payload, allowed_mentions: { parse: [] } };
  const recipients = task.assigneeKind === "user" ? [task.assigneeId] : ((await membersWithRole(task.assigneeId)) ?? []);
  for (const userId of recipients) {
    try {
      await sendDM(userId, dmPayload);
    } catch (err) {
      console.error(`DM to ${userId} failed`, err);
    }
  }
}

export interface RunSummary {
  today: ISODate;
  checked: number;
  sent: { id: number; kind: string; days: number }[];
  failed: { id: number; error: string }[];
}

/** Called once a day by Vercel Cron. */
export async function runReminders(now = new Date()): Promise<RunSummary> {
  const today = todayISO(now);
  const horizon = new Date(Date.parse(today + "T00:00:00Z") + Math.max(...offsets()) * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const tasks = await openTasksDueBy(horizon);
  const summary: RunSummary = { today, checked: tasks.length, sent: [], failed: [] };

  for (const task of tasks) {
    const action = reminderFor(task, today);
    if (!action) continue;
    try {
      await notifyTask(task, reminderMessage(task, action.days, now));
      await updateTask(task.id, action.kind === "before" ? { lastReminder: action.slot } : { overdueSent: true });
      summary.sent.push({ id: task.id, kind: action.kind, days: action.days });
    } catch (err) {
      console.error(`Reminder for task ${task.id} failed`, err);
      summary.failed.push({ id: task.id, error: String(err) });
    }
  }
  return summary;
}
