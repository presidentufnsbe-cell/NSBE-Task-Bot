/**
 * E-board structure and bot settings. This is the one file you are most likely to edit.
 *
 * Roles the bot uses (as they exist in the NSBE Discord):
 *   CEB   -> on the e-board (can use the bot and be assigned tasks)
 *   CEO   -> Chapter Executive Officer: can assign tasks to anyone
 *   Zone roles (Membership Zone, Program Zone, ...) -> which zone someone is in
 */

export const SETTINGS = {
  /** Every date is interpreted in this time zone. */
  timezone: process.env.TIMEZONE || "America/New_York",

  /** Remind this many days before the due date. 0 = the morning it is due. */
  reminderDaysBefore: [7, 3, 1, 0],

  /** Send one "this is overdue" nudge the day after a task was due and still isn't done. */
  overdueNudge: true,

  /**
   * Who can assign tasks to whom.
   *   Executive officers (EXEC_ROLES) can always assign to anyone on the e-board.
   *   Everyone else on the e-board:
   *     "self"   -> can only create tasks for themselves (default)
   *     "zone"   -> can assign to people in their own zone
   *     "anyone" -> can assign to anyone on the e-board
   */
  nonExecCanAssign: "self" as "self" | "zone" | "anyone",
};

/**
 * Who's who is read from Discord ROLE NAMES. Matching ignores capital letters, spaces,
 * punctuation and a trailing "s" ("Comm Zone" == "comm-zone" == "Comm Zones"), but otherwise
 * the names must match the roles in the server.
 */

/**
 * Chapter Executive Officers: President, 1st VP, 2nd VP, Treasurer, Secretary,
 * Programs Chair and Parliamentarian. They can assign tasks to anyone, and edit,
 * reassign, delete or close any task.
 */
export const EXEC_ROLES = ["CEO"];

/** Everyone on the e-board has this role. Only people with it (or a zone role, or CEO) can use the bot. */
export const EBOARD_ROLES = ["CEB"];

export interface Zone {
  key: string;
  /** Shown in /tasks. */
  name: string;
  /** The Discord role(s) for people in this zone. */
  roles: string[];
  /** Who leads it (for reference only; heads are recognised by the CEO role). */
  head: string;
}

export const ZONES: Zone[] = [
  { key: "membership", name: "Membership Zone", roles: ["Membership Zone"], head: "1st Vice President" },
  { key: "programs", name: "Program Zone", roles: ["Program Zone"], head: "Programs Chair" },
  { key: "finance", name: "Finance Zone", roles: ["Finance Zone"], head: "Treasurer" },
  { key: "communications", name: "Comm Zone", roles: ["Comm Zone"], head: "Secretary" },
  { key: "trailblazers", name: "Trailblazers Zone", roles: ["Trailblazer Zone Director"], head: "2nd Vice President" },
  { key: "senate", name: "Senate Zone", roles: ["Senate Zone"], head: "Parliamentarian" },
];
