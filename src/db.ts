import { neon } from "@neondatabase/serverless";
import type { ISODate } from "./dates.js";

export type Query = (text: string, params?: unknown[]) => Promise<any[]>;

let query: Query | null = null;
let schemaReady: Promise<void> | null = null;

/** Tests swap in an in-process Postgres; production uses Neon over HTTP. */
export function setQuery(q: Query) {
  query = q;
  schemaReady = null;
}

function q(): Query {
  if (!query) {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
    const sql = neon(process.env.DATABASE_URL);
    query = (text, params) => sql.query(text, params ?? []) as Promise<any[]>;
  }
  return query;
}

/**
 * Creates the tables the first time the bot runs, and upgrades tables made by older
 * versions of the bot. Every statement is safe to run again.
 */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS tasks (
    id              SERIAL PRIMARY KEY,
    title           TEXT NOT NULL,
    details         TEXT,
    due_date        DATE NOT NULL,
    assignee_kind   TEXT NOT NULL,
    assignee_id     TEXT NOT NULL,
    assignee_label  TEXT NOT NULL,
    zones           TEXT NOT NULL DEFAULT '',
    created_by      TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    status          TEXT NOT NULL DEFAULT 'open',
    completed_by    TEXT,
    completed_at    TIMESTAMPTZ,
    last_reminder   INTEGER,
    overdue_sent    BOOLEAN NOT NULL DEFAULT false
  )`,
  // v2: several assignees per task, cancelling, daily overdue reminders.
  `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assignees JSONB`,
  `UPDATE tasks SET assignees = jsonb_build_array(jsonb_build_object(
     'kind', assignee_kind, 'id', assignee_id, 'label', assignee_label))
   WHERE assignees IS NULL`,
  `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS last_overdue DATE`,
  `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS cancelled_by TEXT`,
  `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ`,
  `ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check`,
  `ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_assignee_kind_check`,
  `CREATE INDEX IF NOT EXISTS tasks_open_due ON tasks (status, due_date)`,
  `CREATE TABLE IF NOT EXISTS task_events (
    id       SERIAL PRIMARY KEY,
    task_id  INTEGER NOT NULL,
    at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    actor    TEXT NOT NULL,
    action   TEXT NOT NULL,
    details  TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS task_events_task ON task_events (task_id, id)`,
];

async function db(): Promise<Query> {
  const run = q();
  schemaReady ??= (async () => {
    for (const stmt of SCHEMA) await run(stmt);
  })().catch((e) => {
    schemaReady = null;
    throw e;
  });
  await schemaReady;
  return run;
}

export interface Assignee {
  kind: "user" | "role";
  id: string;
  label: string;
}

export type Status = "open" | "done" | "cancelled";

export interface Task {
  id: number;
  title: string;
  details: string | null;
  due: ISODate;
  assignees: Assignee[];
  zones: string[];
  createdBy: string;
  status: Status;
  completedBy: string | null;
  cancelledBy: string | null;
  lastReminder: number | null;
  lastOverdue: ISODate | null;
}

const COLUMNS = `id, title, details, due_date::text AS due, assignees, zones, created_by, status,
  completed_by, cancelled_by, last_reminder, last_overdue::text AS last_overdue`;

function toTask(r: any): Task {
  const assignees = typeof r.assignees === "string" ? JSON.parse(r.assignees) : r.assignees;
  return {
    id: Number(r.id),
    title: r.title,
    details: r.details,
    due: r.due,
    assignees: assignees ?? [],
    zones: String(r.zones || "").split(",").filter(Boolean),
    createdBy: r.created_by,
    status: r.status,
    completedBy: r.completed_by,
    cancelledBy: r.cancelled_by,
    lastReminder: r.last_reminder === null ? null : Number(r.last_reminder),
    lastOverdue: r.last_overdue ?? null,
  };
}

/** Zones are stored as ",a,b," so a LIKE '%,a,%' filter is exact. */
const packZones = (zones: string[]) => (zones.length ? `,${[...new Set(zones)].join(",")},` : "");

/** The old single-assignee columns are still filled in (with the first assignee) for compatibility. */
const legacy = (a: Assignee[]) => [a[0].kind, a[0].id, a.map((x) => x.label).join(", ")];

export async function logEvent(taskId: number, actor: string, action: string, details: string | null = null) {
  const run = await db();
  await run(`INSERT INTO task_events (task_id, actor, action, details) VALUES ($1,$2,$3,$4)`, [taskId, actor, action, details]);
}

export interface TaskEvent {
  at: string;
  actor: string;
  action: string;
  details: string | null;
}

export async function getEvents(taskId: number): Promise<TaskEvent[]> {
  const run = await db();
  const rows = await run(
    `SELECT at, actor, action, details FROM task_events WHERE task_id = $1 ORDER BY id`,
    [taskId],
  );
  return rows.map((r) => ({ at: new Date(r.at).toISOString(), actor: r.actor, action: r.action, details: r.details }));
}

export interface NewTask {
  title: string;
  details: string | null;
  due: ISODate;
  assignees: Assignee[];
  zones: string[];
  createdBy: string;
  lastReminder: number | null;
}

export async function createTask(t: NewTask): Promise<Task> {
  const run = await db();
  const rows = await run(
    `INSERT INTO tasks (title, details, due_date, assignee_kind, assignee_id, assignee_label, assignees, zones, created_by, last_reminder)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10) RETURNING ${COLUMNS}`,
    [t.title, t.details, t.due, ...legacy(t.assignees), JSON.stringify(t.assignees), packZones(t.zones), t.createdBy, t.lastReminder],
  );
  const task = toTask(rows[0]);
  await logEvent(task.id, t.createdBy, "created", `assigned to ${t.assignees.map((a) => a.label).join(", ")}, due ${t.due}`);
  return task;
}

export async function getTask(id: number): Promise<Task | null> {
  const run = await db();
  const rows = await run(`SELECT ${COLUMNS} FROM tasks WHERE id = $1`, [id]);
  return rows[0] ? toTask(rows[0]) : null;
}

export interface TaskUpdate {
  title?: string;
  details?: string | null;
  due?: ISODate;
  assignees?: Assignee[];
  zones?: string[];
  lastReminder?: number | null;
  lastOverdue?: ISODate | null;
}

export async function updateTask(id: number, u: TaskUpdate): Promise<Task | null> {
  const run = await db();
  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (col: string, val: unknown, cast = "") => {
    params.push(val);
    sets.push(`${col} = $${params.length}${cast}`);
  };
  if (u.title !== undefined) set("title", u.title);
  if (u.details !== undefined) set("details", u.details);
  if (u.due !== undefined) set("due_date", u.due);
  if (u.assignees !== undefined) {
    const [kind, aid, label] = legacy(u.assignees);
    set("assignees", JSON.stringify(u.assignees), "::jsonb");
    set("assignee_kind", kind);
    set("assignee_id", aid);
    set("assignee_label", label);
  }
  if (u.zones !== undefined) set("zones", packZones(u.zones));
  if (u.lastReminder !== undefined) set("last_reminder", u.lastReminder);
  if (u.lastOverdue !== undefined) set("last_overdue", u.lastOverdue);
  if (!sets.length) return getTask(id);
  params.push(id);
  const rows = await run(`UPDATE tasks SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING ${COLUMNS}`, params);
  return rows[0] ? toTask(rows[0]) : null;
}

/** Marks a task done. Returns null if it wasn't open (so double-clicks are harmless). */
export async function completeTask(id: number, userId: string): Promise<Task | null> {
  const run = await db();
  const rows = await run(
    `UPDATE tasks SET status = 'done', completed_by = $2, completed_at = now()
     WHERE id = $1 AND status = 'open' RETURNING ${COLUMNS}`,
    [id, userId],
  );
  if (!rows[0]) return null;
  await logEvent(id, userId, "completed");
  return toTask(rows[0]);
}

/** Cancels a task: it stops reminding but stays in the history. */
export async function cancelTask(id: number, userId: string, reason: string | null): Promise<Task | null> {
  const run = await db();
  const rows = await run(
    `UPDATE tasks SET status = 'cancelled', cancelled_by = $2, cancelled_at = now()
     WHERE id = $1 AND status = 'open' RETURNING ${COLUMNS}`,
    [id, userId],
  );
  if (!rows[0]) return null;
  await logEvent(id, userId, "cancelled", reason);
  return toTask(rows[0]);
}

export interface TaskFilter {
  /** Tasks assigned to this user, or to any of these role IDs. */
  userId?: string;
  roleIds?: string[];
  zone?: string;
  createdBy?: string;
  /** Only tasks due before this date. */
  dueBefore?: ISODate;
  /** Free-text match on title or "#id" (used by autocomplete). */
  search?: string;
  limit?: number;
}

export async function listOpenTasks(f: TaskFilter = {}): Promise<Task[]> {
  const run = await db();
  const where = ["status = 'open'"];
  const params: unknown[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };

  if (f.userId !== undefined) {
    const ids = [f.userId, ...(f.roleIds ?? [])];
    where.push(`EXISTS (SELECT 1 FROM jsonb_array_elements(assignees) a WHERE a->>'id' = ANY(${p(ids)}::text[]))`);
  }
  if (f.zone) where.push(`zones LIKE ${p(`%,${f.zone},%`)}`);
  if (f.createdBy) where.push(`created_by = ${p(f.createdBy)}`);
  if (f.dueBefore) where.push(`due_date < ${p(f.dueBefore)}`);
  if (f.search?.trim()) {
    const s = f.search.trim().replace(/^#/, "");
    const byId = /^\d+$/.test(s) ? ` OR id = ${p(Number(s))}` : "";
    where.push(`(title ILIKE ${p(`%${s}%`)}${byId})`);
  }
  const rows = await run(
    `SELECT ${COLUMNS} FROM tasks WHERE ${where.join(" AND ")} ORDER BY due_date, id LIMIT ${p(f.limit ?? 100)}`,
    params,
  );
  return rows.map(toTask);
}

/** Open tasks due on or before a date: everything the daily reminder run needs to look at. */
export async function openTasksDueBy(date: ISODate): Promise<Task[]> {
  const run = await db();
  const rows = await run(
    `SELECT ${COLUMNS} FROM tasks WHERE status = 'open' AND due_date <= $1 ORDER BY due_date, id`,
    [date],
  );
  return rows.map(toTask);
}
