import { EBOARD_ROLES, EXEC_ROLES, SETTINGS, ZONES } from "./config.js";

/** Lowercase, "&" -> "and", drop punctuation/spaces, drop a trailing plural "s". */
export function normalize(name: string): string {
  let n = name.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]/g, "");
  if (n.length > 3 && n.endsWith("s")) n = n.slice(0, -1);
  return n;
}

/** Does a Discord role name match one of the configured names? */
export function roleMatches(roleName: string, configured: string[]): boolean {
  const r = normalize(roleName);
  return configured.some((c) => normalize(c) === r);
}

export interface Profile {
  /** Zone keys this person is in. */
  zones: string[];
  isExec: boolean;
  isEboard: boolean;
}

/** Work out someone's e-board standing from the names of their Discord roles. */
export function profileFromRoleNames(roleNames: string[]): Profile {
  const zones = ZONES.filter((z) => roleNames.some((r) => roleMatches(r, z.roles))).map((z) => z.key);
  const isExec = roleNames.some((r) => roleMatches(r, EXEC_ROLES));
  const inEboard = roleNames.some((r) => roleMatches(r, EBOARD_ROLES));
  return { zones, isExec, isEboard: isExec || inEboard || zones.length > 0 };
}

export type Target =
  | { kind: "user"; id: string; profile: Profile }
  | { kind: "role"; id: string; name: string };

/** Can a whole Discord role be assigned a task? (A zone role, CEO, or CEB.) */
export function isEboardRole(roleName: string): boolean {
  return profileFromRoleNames([roleName]).isEboard;
}

/** Returns null if allowed, otherwise a human-readable reason. */
export function checkCanAssign(assignerId: string, assigner: Profile, target: Target): string | null {
  if (!assigner.isEboard) return "Only e-board members can use the task bot.";

  if (target.kind === "user") {
    if (!target.profile.isEboard)
      return "That person doesn't have an e-board role (CEB or a zone role), so they can't be assigned tasks.";
  } else if (!isEboardRole(target.name)) {
    return `**@${target.name}** isn't an e-board role. You can assign to a person, a zone role, @CEO or @CEB.`;
  }

  if (assigner.isExec) return null;
  if (target.kind === "user" && target.id === assignerId) return null;

  switch (SETTINGS.nonExecCanAssign) {
    case "anyone":
      return null;
    case "zone": {
      const targetZones = zonesForTarget(target);
      if (targetZones.length && targetZones.every((z) => assigner.zones.includes(z))) return null;
      return "You can only assign tasks to people in your own zone. Ask a CEO for anything else.";
    }
    default:
      return "Only CEOs can assign tasks to other people. You can still create tasks for yourself.";
  }
}

/** Zone keys to file a task under, based on who it's assigned to. */
export function zonesForTarget(target: Target): string[] {
  return target.kind === "user" ? target.profile.zones : profileFromRoleNames([target.name]).zones;
}
