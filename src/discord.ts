/** Minimal Discord REST client (the bot never opens a gateway connection, so it fits serverless). */

const API = "https://discord.com/api/v10";

export class DiscordError extends Error {
  constructor(public status: number, public code: number | undefined, message: string) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function discord<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(API + path, {
      method,
      headers: {
        Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": "DiscordBot (nsbe-task-bot, 1.0)",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 429 && attempt < 4) {
      const data: any = await res.json().catch(() => ({}));
      await sleep(Math.ceil((data.retry_after ?? 1) * 1000) + 50);
      continue;
    }
    if (res.status === 204) return undefined as T;
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new DiscordError(res.status, data.code, `${method} ${path} -> ${res.status} ${data.message ?? ""}`);
    return data as T;
  }
}

export interface MessagePayload {
  content?: string;
  embeds?: unknown[];
  components?: unknown[];
  allowed_mentions?: { parse?: string[]; users?: string[]; roles?: string[] };
  flags?: number;
}

export function sendChannelMessage(channelId: string, payload: MessagePayload) {
  return discord("POST", `/channels/${channelId}/messages`, payload);
}

/** DM a user. Returns false (instead of throwing) if they have DMs from server members turned off. */
export async function sendDM(userId: string, payload: MessagePayload): Promise<boolean> {
  try {
    const channel = await discord<{ id: string }>("POST", "/users/@me/channels", { recipient_id: userId });
    await sendChannelMessage(channel.id, payload);
    return true;
  } catch (err) {
    if (err instanceof DiscordError && (err.code === 50007 || err.status === 403)) return false;
    throw err;
  }
}

export interface GuildRole {
  id: string;
  name: string;
}

let rolesCache: { at: number; roles: GuildRole[] } | null = null;

/** Server roles, cached for 5 minutes per warm function instance. */
export async function getGuildRoles(): Promise<GuildRole[]> {
  if (rolesCache && Date.now() - rolesCache.at < 5 * 60_000) return rolesCache.roles;
  const roles = await discord<GuildRole[]>("GET", `/guilds/${process.env.DISCORD_GUILD_ID}/roles`);
  rolesCache = { at: Date.now(), roles };
  return roles;
}

export async function roleNames(roleIds: string[]): Promise<string[]> {
  const roles = await getGuildRoles();
  return roleIds.map((id) => roles.find((r) => r.id === id)?.name).filter((n): n is string => !!n);
}

export interface GuildMember {
  user: { id: string; username: string; global_name?: string | null; bot?: boolean };
  nick?: string | null;
  roles: string[];
}

export function getMember(userId: string) {
  return discord<GuildMember>("GET", `/guilds/${process.env.DISCORD_GUILD_ID}/members/${userId}`);
}

/**
 * Everyone in the server (bots excluded). Needs the "Server Members Intent" switched on in
 * the Developer Portal; returns null if it isn't, and callers fall back to a channel ping only.
 * Cached for a minute so a reminder run lists the server once, not once per task.
 */
let membersCache: { at: number; members: GuildMember[] } | null = null;

export async function listMembers(): Promise<GuildMember[] | null> {
  if (membersCache && Date.now() - membersCache.at < 60_000) return membersCache.members;
  const all: GuildMember[] = [];
  let after = "0";
  try {
    for (;;) {
      const page = await discord<GuildMember[]>(
        "GET",
        `/guilds/${process.env.DISCORD_GUILD_ID}/members?limit=1000&after=${after}`,
      );
      all.push(...page.filter((m) => !m.user.bot));
      if (page.length < 1000) break;
      after = page[page.length - 1].user.id;
    }
    membersCache = { at: Date.now(), members: all };
    return all;
  } catch (err) {
    console.warn("Could not list members (is the Server Members Intent on?)", err);
    return null;
  }
}

/** IDs of everyone with a role (and, if given, also another role). */
export async function membersWithRole(roleId: string, alsoRoleId?: string): Promise<string[] | null> {
  const members = await listMembers();
  if (!members) return null;
  return members
    .filter((m) => m.roles.includes(roleId) && (!alsoRoleId || m.roles.includes(alsoRoleId)))
    .map((m) => m.user.id);
}

export function displayName(user: { username: string; global_name?: string | null }, nick?: string | null) {
  return nick || user.global_name || user.username;
}
