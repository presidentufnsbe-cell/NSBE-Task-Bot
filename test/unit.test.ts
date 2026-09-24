import { describe, expect, it } from "vitest";
import { daysBetween, formatDate, parseDue, todayISO } from "../src/dates.js";
import { checkCanAssign, profileFromRoleNames, roleMatches } from "../src/permissions.js";
import { initialReminderMark, reminderFor } from "../src/reminders.js";

// Wed Sep 23 2026, 11pm in New York = Thu 03:00 UTC. "Today" must still be the 23rd.
const lateWed = new Date("2026-09-24T03:00:00Z");

describe("dates", () => {
  it("uses the club's time zone for 'today'", () => {
    expect(todayISO(lateWed)).toBe("2026-09-23");
  });
  it("parses the ways people write due dates", () => {
    expect(parseDue("friday", lateWed)).toBe("2026-09-25");
    expect(parseDue("tomorrow", lateWed)).toBe("2026-09-24");
    expect(parseDue("today", lateWed)).toBe("2026-09-23");
    expect(parseDue("10/3", lateWed)).toBe("2026-10-03");
    expect(parseDue("Oct 3", lateWed)).toBe("2026-10-03");
    expect(parseDue("next tuesday", lateWed)).toBe("2026-09-29");
    expect(parseDue("in 2 weeks", lateWed)).toBe("2026-10-07");
    expect(parseDue("2026-11-01", lateWed)).toBe("2026-11-01");
    expect(parseDue("2026-02-30", lateWed)).toBeNull();
    expect(parseDue("whenever", lateWed)).toBeNull();
  });
  it("formats and counts days", () => {
    expect(formatDate("2026-10-03", lateWed)).toBe("Sat, Oct 3");
    expect(formatDate("2027-01-05", lateWed)).toBe("Tue, Jan 5, 2027");
    expect(daysBetween("2026-09-23", "2026-10-03")).toBe(10);
    expect(daysBetween("2026-11-01", "2026-11-02")).toBe(1); // across DST change
  });
});

describe("roles and permissions", () => {
  it("matches Discord role names loosely but exactly", () => {
    expect(roleMatches("comm-zone", ["Comm Zone"])).toBe(true);
    expect(roleMatches("Program Zones", ["Program Zone"])).toBe(true);
    expect(roleMatches("CEB Alumni", ["CEB"])).toBe(false);
  });
  it("builds profiles from CEO, CEB and zone roles", () => {
    expect(profileFromRoleNames(["CEO", "CEB", "Membership Zone"])).toEqual({ zones: ["membership"], isExec: true, isEboard: true });
    expect(profileFromRoleNames(["CEB", "Trailblazer Zone Director"])).toEqual({ zones: ["trailblazers"], isExec: false, isEboard: true });
    expect(profileFromRoleNames(["CEB"]).isEboard).toBe(true);
    expect(profileFromRoleNames(["Member"]).isEboard).toBe(false);
  });
  it("lets CEOs assign to anyone and everyone else only to themselves", () => {
    const ceo = profileFromRoleNames(["CEO", "CEB"]);
    const chair = profileFromRoleNames(["CEB", "Comm Zone"]);
    const other = { kind: "user" as const, id: "b", profile: profileFromRoleNames(["CEB", "Finance Zone"]) };
    expect(checkCanAssign("p", ceo, other)).toBeNull();
    expect(checkCanAssign("a", chair, other)).toMatch(/Only CEOs/);
    expect(checkCanAssign("a", chair, { kind: "user", id: "a", profile: chair })).toBeNull();
    const outsider = { kind: "user" as const, id: "x", profile: profileFromRoleNames(["Member"]) };
    expect(checkCanAssign("p", ceo, outsider)).toMatch(/e-board role/);
    expect(checkCanAssign("p", ceo, { kind: "role", id: "r", name: "Finance Zone" })).toBeNull();
    expect(checkCanAssign("p", ceo, { kind: "role", id: "r", name: "CEB" })).toBeNull();
    expect(checkCanAssign("p", ceo, { kind: "role", id: "r", name: "Member" })).toMatch(/isn't an e-board role/);
  });
});

describe("reminder schedule", () => {
  /** Simulate a task created on `created` and the cron running every day; return the days a reminder went out. */
  function simulate(created: string, due: string, skip: string[] = []) {
    const task = { due, lastReminder: initialReminderMark(daysBetween(created, due)), overdueSent: false };
    const sent: string[] = [];
    for (let d = 1; d <= 30; d++) {
      const today = new Date(Date.parse(created + "T00:00:00Z") + d * 86_400_000).toISOString().slice(0, 10);
      if (skip.includes(today)) continue;
      const a = reminderFor(task, today);
      if (!a) continue;
      sent.push(`${today}:${a.kind === "before" ? a.days : "overdue"}`);
      if (a.kind === "before") task.lastReminder = a.slot;
      else task.overdueSent = true;
    }
    return sent;
  }

  it("sends 1 week, 3 days, 1 day, day-of, then one overdue nudge", () => {
    expect(simulate("2026-09-23", "2026-10-10")).toEqual([
      "2026-10-03:7", "2026-10-07:3", "2026-10-09:1", "2026-10-10:0", "2026-10-11:overdue",
    ]);
  });
  it("skips reminders already covered by the 'you've been assigned' message", () => {
    // Created 5 days out: the assignment message covers the 1-week slot.
    expect(simulate("2026-09-23", "2026-09-28")).toEqual(["2026-09-25:3", "2026-09-27:1", "2026-09-28:0", "2026-09-29:overdue"]);
    // Created the day before: only day-of and overdue.
    expect(simulate("2026-09-23", "2026-09-24")).toEqual(["2026-09-24:0", "2026-09-25:overdue"]);
  });
  it("catches up if a daily run was missed", () => {
    expect(simulate("2026-09-23", "2026-10-10", ["2026-10-07"])).toEqual([
      "2026-10-03:7", "2026-10-08:2", "2026-10-09:1", "2026-10-10:0", "2026-10-11:overdue",
    ]);
  });
});
