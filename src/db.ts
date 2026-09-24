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

/** Creates the table the first time the bot runs, so there's no separate migration step. */
async function db(): Promise<Query> {
  const run = q();
  schemaReady ??= (async () => {
    await run(`CREATE TABLE IF NOT EXISTS tasks (
      id              SERIAL PRIMARY KEY,
      title           TEXT NOT NULL,
      details         TEXT,
      due_date        DATE NOT NULL,
      assignee_kind   TEXT NOT NULL CHECK (assignee_kind IN ('user','role')),
      assignee_id     TEXT NOT NULL,
      assignee_label  TEXT NOT NULL,
      zones           TEXT NOT NULL DEFAULT '',
      created_by      TEXT NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
      completed_by    TEXT,
      completed_at    TIMESTAMPTZ,
      last_reminder   INTEGER,
      overdue_sent    BOOLEAN NOT NULL DEFAULT false
    )`);
    await run(`CREATE INDEX IF NOT EXISTS tasks_open_due ON tasks (status, due_date)`);
  })().catch((e) => {
    schemaReady = null;
    throw e;
  });
  await schemaReady;
  return run;
}

export interface Task {
  id: number;
  title: string;
  details: string | null;
  due: ISODate;
  assigneeKind: "user" | "role";
  assigneeId: string;
  assigneeLabel: string;
  zones: string[];
  createdBy: string;
  status: "open" | "done";
  completedBy: string | null;
  lastReminder: number | null;
  overdueSent: boolean;
}

const COLUMNS = `id, title, details, due_date::text AS due, assignee_kind, assignee_id, assignee_label, zones,
  created_by, status, completed_by, last_reminder, overdue_sent`;

function toTask(r: any): Task {
  return {
    id: Number(r.id),
    title: r.title,
    details: r.details,
    due: r.due,
    assigneeKind: r.assignee_kind,
    assigneeId: r.assignee_id,
    assigneeLabel: r.assignee_label,
    zones: String(r.zones || "").split(",").filter(Boolean),
    createdBy: r.created_by,
    status: r.status,
    completedBy: r.completed_by,
    lastReminder: r.last_reminder === null ? null : Number(r.last_reminder),
    overdueSent: !!r.overdue_sent,
  };
}

/** Zones are stored as ",a,b," so a LIKE '%,a,%' filter is exact. */
const packZones = (zones: string[]) => (zones.length ? `,${zones.join(",")},` : "");

export interface NewTask {
  title: string;
  details: string | null;
  due: ISODate;
  assigneeKind: "user" | "role";
  assigneeId: string;
  assigneeLabel: string;
  zones: string[];
  createdBy: string;
  lastReminder: number | null;
}

export async function createTask(t: NewTask): Promise<Task> {
  const run = await db();
  const rows = await run(
    `INSERT INTO tasks (title, details, due_date, assignee_kind, assignee_id, assignee_label, zones, created_by, last_reminder)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${COLUMNS}`,
    [t.title, t.details, t.due, t.assigneeKind, t.assigneeId, t.assigneeLabel, packZones(t.zones), t.createdBy, t.lastReminder],
  );
  return toTask(rows[0]);
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
  assigneeKind?: "user" | "role";
  assigneeId?: string;
  assigneeLabel?: string;
  zones?: string[];
  lastReminder?: number | null;
  overdueSent?: boolean;
}

export async function updateTask(id: number, u: TaskUpdate): Promise<Task | null> {
  const run = await db();
  const map: Record<string, [string, unknown]> = {
    title: ["title", u.title],
    details: ["details", u.details],
    due: ["due_date", u.due],
    assigneeKind: ["assignee_kind", u.assigneeKind],
    assigneeId: ["assignee_id", u.assigneeId],
    assigneeLabel: ["assignee_label", u.assigneeLabel],
    zones: ["zones", u.zones === undefined ? undefined : packZones(u.zones)],
    lastReminder: ["last_reminder", u.lastReminder],
    overdueSent: ["overdue_sent", u.overdueSent],
  };
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const key of Object.keys(u) as (keyof TaskUpdate)[]) {
    if (u[key] === undefined) continue;
    const [col, val] = map[key];
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  }
  if (!sets.length) return getTask(id);
  params.push(id);
  const rows = await run(`UPDATE tasks SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING ${COLUMNS}`, params);
  return rows[0] ? toTask(rows[0]) : null;
}

/** Marks a task done. Returns null if it was already done (so double-clicks are harmless). */
export async function completeTask(id: number, userId: string): Promise<Task | null> {
  const run = await db();
  const rows = await run(
    `UPDATE tasks SET status = 'done', completed_by = $2, completed_at = now()
     WHERE id = $1 AND status = 'open' RETURNING ${COLUMNS}`,
    [id, userId],
  );
  return rows[0] ? toTask(rows[0]) : null;
}

export async function deleteTask(id: number): Promise<boolean> {
  const run = await db();
  const rows = await run(`DELETE FROM tasks WHERE id = $1 RETURNING id`, [id]);
  return rows.length > 0;
}

export interface TaskFilter {
  /** Tasks assigned to this user, or to any of these role IDs. */
  userId?: string;
  roleIds?: string[];
  zone?: string;
  createdBy?: string;
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
    const who = [`(assignee_kind = 'user' AND assignee_id = ${p(f.userId)})`];
    if (f.roleIds?.length) who.push(`(assignee_kind = 'role' AND assignee_id = ANY(${p(f.roleIds)}))`);
    where.push(`(${who.join(" OR ")})`);
  }
  if (f.zone) where.push(`zones LIKE ${p(`%,${f.zone},%`)}`);
  if (f.createdBy) where.push(`created_by = ${p(f.createdBy)}`);
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
