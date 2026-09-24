import * as chrono from "chrono-node";
import { SETTINGS } from "./config.js";

/** A calendar date as "YYYY-MM-DD". Due dates are whole days, not instants. */
export type ISODate = string;

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Wall-clock parts of `now` in the given time zone. */
function wallClock(now: Date, tz: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get("year"), m: get("month"), d: get("day"), h: get("hour"), min: get("minute"), s: get("second") };
}

const pad = (n: number) => String(n).padStart(2, "0");
const toISO = (y: number, m: number, d: number): ISODate => `${y}-${pad(m)}-${pad(d)}`;

/** Today's date in the club's time zone. */
export function todayISO(now = new Date(), tz = SETTINGS.timezone): ISODate {
  const { y, m, d } = wallClock(now, tz);
  return toISO(y, m, d);
}

function isRealDate(iso: string): boolean {
  const m = ISO_RE.exec(iso);
  if (!m) return false;
  const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return dt.getUTCFullYear() === +m[1] && dt.getUTCMonth() === +m[2] - 1 && dt.getUTCDate() === +m[3];
}

/** Whole days from `from` to `to` (negative if `to` is earlier). */
export function daysBetween(from: ISODate, to: ISODate): number {
  const a = Date.parse(from + "T00:00:00Z");
  const b = Date.parse(to + "T00:00:00Z");
  return Math.round((b - a) / 86_400_000);
}

/**
 * Turn what someone typed ("friday", "10/3", "next tuesday", "in 2 weeks", "2026-10-03")
 * into a calendar date, relative to today in the club's time zone.
 * Returns null if it can't be read.
 */
export function parseDue(input: string, now = new Date(), tz = SETTINGS.timezone): ISODate | null {
  const text = input.trim();
  if (!text) return null;
  if (ISO_RE.test(text)) return isRealDate(text) ? text : null;

  const lower = text.toLowerCase();
  if (lower === "today" || lower === "tonight" || lower === "eod") return todayISO(now, tz);

  // Build a reference Date whose *local* fields equal the club's wall clock, so chrono's
  // "friday" means Friday in the club's time zone no matter where the server runs.
  const w = wallClock(now, tz);
  const ref = new Date(w.y, w.m - 1, w.d, w.h, w.min, w.s);
  const result = chrono.parseDate(text, ref, { forwardDate: true });
  if (!result) return null;
  return toISO(result.getFullYear(), result.getMonth() + 1, result.getDate());
}

/** "Fri, Oct 3" (adds the year if it isn't this year). */
export function formatDate(iso: ISODate, now = new Date()): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const sameYear = y === Number(todayISO(now).slice(0, 4));
  return dt.toLocaleDateString("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** "today", "tomorrow", "in 3 days", "1 week", "2 days overdue". */
export function relativeDue(days: number): string {
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === 7) return "in 1 week";
  if (days > 1) return `in ${days} days`;
  if (days === -1) return "1 day overdue";
  return `${-days} days overdue`;
}
