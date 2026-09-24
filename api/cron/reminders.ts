import { runReminders } from "../../src/reminders.js";

/** Vercel Cron calls this once a day (see vercel.json). */
export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  const summary = await runReminders();
  console.log("Reminder run", JSON.stringify(summary));
  return Response.json(summary);
}
