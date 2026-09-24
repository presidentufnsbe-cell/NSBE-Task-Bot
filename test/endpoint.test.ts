import { describe, expect, it } from "vitest";
import { POST } from "../api/interactions.js";

const hex = (b: ArrayBuffer) => Buffer.from(b).toString("hex");

describe("interactions endpoint", () => {
  it("answers Discord's PING only when the signature is valid", async () => {
    const keys = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    process.env.DISCORD_PUBLIC_KEY = hex(await crypto.subtle.exportKey("raw", keys.publicKey));
    const body = JSON.stringify({ type: 1 });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = hex(await crypto.subtle.sign("Ed25519", keys.privateKey, new TextEncoder().encode(ts + body)));
    const req = (s: string) =>
      new Request("http://x/api/interactions", {
        method: "POST", body, headers: { "x-signature-ed25519": s, "x-signature-timestamp": ts },
      });

    const good = await POST(req(sig));
    expect(good.status).toBe(200);
    expect(await good.json()).toEqual({ type: 1 });
    expect((await POST(req("00".repeat(64)))).status).toBe(401);
  });
});
