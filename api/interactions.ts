import { waitUntil } from "@vercel/functions";
import { verifyKey } from "discord-interactions";
import { handleInteraction } from "../src/handlers.js";

/** Discord sends every slash command, autocomplete and button press here. */
export async function POST(request: Request): Promise<Response> {
  const signature = request.headers.get("x-signature-ed25519");
  const timestamp = request.headers.get("x-signature-timestamp");
  const body = await request.text();

  const valid =
    !!signature &&
    !!timestamp &&
    (await verifyKey(body, signature, timestamp, process.env.DISCORD_PUBLIC_KEY ?? "").catch(() => false));
  if (!valid) return new Response("Bad request signature", { status: 401 });

  const interaction = JSON.parse(body);
  const response = await handleInteraction(interaction, (work) =>
    waitUntil(work.catch((err) => console.error("Background work failed", err))),
  );
  return Response.json(response);
}
