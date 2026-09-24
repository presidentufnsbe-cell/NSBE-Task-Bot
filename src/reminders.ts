import { EXEC_ROLES, SETTINGS } from "./config.js";
import { daysBetween, todayISO, type ISODate } from "./dates.js";
import { openTasksDueBy, updateTask, type Task } from "./db.js";
import { getGuildRoles, membersWithRole, sendChannelMessage, sendDM, type MessagePayload } from "./discord.js";
import { overdueDigest, reminderMessage } from "./messages.js";
import { roleMatches } from "./permissions.js";

const offsets = () => [...SETTINGS.reminderDaysBefore].sort((a, b) => a - b);

/** The reminder slot that covers `days` left: the smallest configured offset >= days. */
function slotFor(days: number): number | null {
  return offsets().find((o) => o >= days) ?? null;
}

/**
 * When a task is created (or its date changes) the assignees are notified right away,
 * which counts as the reminder for the current slot. Created 2 days out -> the
 * "3 days" slot is used up, the next reminder is the 1-day one.
 */
export function initialReminderMark(days: number): number | null {
  return days < 0 ? null : slotFor(days);
}

export type ReminderAction =
  | { kind: "before"; slot: number; days: number; channel: boolean }
  | { kind: "overdue"; days: number }
  | null;

/**
 * What (if anything) to send for a task today. Missed days catch up: if the cron
 * skipped the 3-day run, the next run sends a reminder with the real days left.
 */
export function reminderFor(task: Pick<Task, "due" | "lastReminder" | "lastOverdue">, today: ISODate): ReminderAction {
  const days = daysBetween(today, task.due);
  if (days >= 0) {
    const slot = slotFor(days);
    if (slot === null) return null;
    if (task.lastReminder !== null && slot >= task.lastReminder) return null;
    return { kind: "before", slot, days, channel: SETTINGS.channelDaysBefore.includes(slot) };
  }
  if (SETTINGS.overdueDaily && task.lastOverdue !== today) return { kind: "overdue", days };
  return null;
}

let ceoRoleId: string | null | undefined;
async function getCeoRoleId(): Promise<string | null> {
  if (ceoRoleId === undefined) {
    const roles = await getGuildRoles().catch(() => []);
    ceoRoleId = roles.find((r) => roleMatches(r.name, EXEC_ROLES))?.id ?? null;
  }
  return ceoRoleId;
}

interface Recipient {
  userId: string;
  /** Named assignees get the Mark Complete button; zone members don't (only heads can complete zone tasks). */
  button: boolean;
}

/**
 * Who gets a DM for this task. `headsOnly` narrows zone tasks to the zone head(s):
 * people with both the zone role and the CEO role (falls back to the whole zone if none).
 */
async function recipientsFor(task: Task, headsOnly = false): Promise<Recipient[]> {
  const out = new Map<string, Recipient>();
  for (const a of task.assignees) {
    if (a.kind === "user") {
      out.set(a.id, { userId: a.id, button: true });
      continue;
    }
    const ceo = await getCeoRoleId();
    let ids = headsOnly && ceo ? await membersWithRole(a.id, ceo) : null;
    if (!ids?.length) ids = await membersWithRole(a.id);
    const heads = ceo ? new Set((await membersWithRole(a.id, ceo)) ?? []) : new Set<string>();
    for (const id of ids ?? []) if (!out.has(id)) out.set(id, { userId: id, button: heads.has(id) });
  }
  return [...out.values()];
}

export interface DeliveryOptions {
  /** Post in #task-alerts too. */
  channel: boolean;
  /** For zone tasks, DM only the zone head(s). */
  headsOnly?: boolean;
}

/**
 * DM everyone involved and (optionally) post in #task-alerts. The two are independent:
 * one failing never stops the other. If a named assignee can't be DM'd, the message goes
 * to #task-alerts instead so they still see it.
 */
export async function deliver(task: Task, build: (withButton: boolean) => MessagePayload, opts: DeliveryOptions) {
  let delivered = 0;
  let missedAssignee = false;

  for (const r of await recipientsFor(task, opts.headsOnly)) {
    try {
      const ok = await sendDM(r.userId, { ...build(r.button), allowed_mentions: { parse: [] } });
      if (ok) delivered++;
      else {
        console.warn(`User ${r.userId} has DMs from server members turned off`);
        if (r.button) missedAssignee = true;
      }
    } catch (err) {
      console.error(`DM to ${r.userId} failed`, err);
      if (r.button) missedAssignee = true;
    }
  }

  let channelError: unknown = null;
  // Fall back to the channel if a named assignee missed their DM or nobody could be DM'd at all.
  if (opts.channel || missedAssignee || delivered === 0) {
    const channelId = process.env.TASK_ALERTS_CHANNEL_ID;
    if (!channelId) {
      console.error("TASK_ALERTS_CHANNEL_ID is not set, so nothing is posted to #task-alerts");
    } else {
      try {
        await sendChannelMessage(channelId, build(true));
        delivered++;
      } catch (err) {
        channelError = err;
        console.error(`Posting to #task-alerts (channel ${channelId}) failed`, err);
      }
    }
  }

  // Nothing reached anyone: surface it (the daily run then retries tomorrow).
  if (delivered === 0) throw channelError ?? new Error(`Task #${task.id}: no one could be notified`);
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
  const overdue: Task[] = [];

  for (const task of tasks) {
    const action = reminderFor(task, today);
    if (!action) continue;
    try {
      if (action.kind === "before") {
        await deliver(task, (b) => reminderMessage(task, action.days, now, b), { channel: action.channel });
        await updateTask(task.id, { lastReminder: action.slot });
      } else {
        // Overdue: DM daily (zone tasks: the zone head); the channel gets one summary below.
        await deliver(task, (b) => reminderMessage(task, action.days, now, b), { channel: false, headsOnly: true });
        await updateTask(task.id, { lastOverdue: today });
        overdue.push(task);
      }
      summary.sent.push({ id: task.id, kind: action.kind, days: action.days });
    } catch (err) {
      console.error(`Reminder for task ${task.id} failed`, err);
      summary.failed.push({ id: task.id, error: String(err) });
      if (action.kind === "overdue") overdue.push(task);
    }
  }

  const channelId = process.env.TASK_ALERTS_CHANNEL_ID;
  if (overdue.length && channelId) {
    try {
      await sendChannelMessage(channelId, overdueDigest(overdue, now));
    } catch (err) {
      console.error("Posting the overdue summary failed", err);
      summary.failed.push({ id: 0, error: `overdue summary: ${err}` });
    }
  }
  return summary;
}
