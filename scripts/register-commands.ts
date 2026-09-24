/**
 * Registers the slash commands in your server. Run once after setup, and again
 * whenever you change src/commands.ts or the zone list in src/config.ts:
 *
 *   npm run register
 *
 * Reads DISCORD_APPLICATION_ID, DISCORD_BOT_TOKEN and DISCORD_GUILD_ID from .env
 */
import { COMMANDS } from "../src/commands.js";

try {
  process.loadEnvFile?.(".env");
} catch {
  // no .env file; fall back to real environment variables
}

const { DISCORD_APPLICATION_ID: app, DISCORD_BOT_TOKEN: token, DISCORD_GUILD_ID: guild } = process.env;
if (!app || !token || !guild) {
  console.error("Set DISCORD_APPLICATION_ID, DISCORD_BOT_TOKEN and DISCORD_GUILD_ID in .env first.");
  process.exit(1);
}

const res = await fetch(`https://discord.com/api/v10/applications/${app}/guilds/${guild}/commands`, {
  method: "PUT",
  headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify(COMMANDS),
});
const data: any = await res.json();
if (!res.ok) {
  console.error("Discord rejected the commands:", JSON.stringify(data, null, 2));
  process.exit(1);
}
console.log(`Registered ${data.length} commands: ${data.map((c: any) => "/" + c.name).join(", ")}`);
