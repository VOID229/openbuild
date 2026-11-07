import { afterAll, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";

// probeDevice tries each saved address of a paired device. An answer from another OpenBuild, of
// any status, is never the device's own; the device's real refusal still means revoked.
const data = process.env.OPENCHAT_DATA_DIR;
if (!data || !realpathSync(data).startsWith(realpathSync(tmpdir()))) throw new Error("deviceIdentity tests need a temporary OPENCHAT_DATA_DIR");
const devices = await import("../server/devices");

const HOST = "paired-host-id";
/** A server at one saved address: its status, and which server it says it is (none: an older OpenBuild). */
const serve = (status: number, server?: string) =>
  Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => Response.json(status === 200 ? { running: true, keeper: true } : { error: "no" }, { status, headers: server ? { [devices.SERVER_HEADER]: server } : {} }),
  });
const servers = {
  revoked: serve(401, HOST),
  online: serve(200, HOST),
  otherRefusing: serve(401, "someone-else"),
  otherMissing: serve(404, "someone-else"),
  otherForbidden: serve(403, "someone-else"),
  otherOnline: serve(200, "someone-else"),
  legacyOnline: serve(200),
  legacyRevoked: serve(401),
};
afterAll(() => {
  for (const server of Object.values(servers)) server.stop(true);
});

const status = async (...at: (keyof typeof servers)[]) =>
  (
    await devices.probeDevice({
      id: HOST,
      serverId: HOST,
      name: "host",
      mode: "tailscale",
      pairedAt: 0,
      token: "a".repeat(64),
      urls: at.map((name) => `http://127.0.0.1:${servers[name].port}`),
    })
  ).status;

test("the device's own refusal is a revocation, even when another server answers after it", async () => {
  expect(await status("revoked")).toBe("revoked");
  expect(await status("revoked", "otherMissing")).toBe("revoked");
  expect(await status("revoked", "otherForbidden")).toBe("revoked");
  expect(await status("revoked", "otherOnline")).toBe("revoked");
  expect(await status("otherOnline", "revoked")).toBe("revoked");
});

test("another server's answer, of any status, gives way to the device's success", async () => {
  expect(await status("otherMissing", "online")).toBe("online");
  expect(await status("otherForbidden", "online")).toBe("online");
  expect(await status("otherRefusing", "online")).toBe("online");
  expect(await status("otherOnline", "online")).toBe("online");
  // A success still beats the device's own refusal at another address.
  expect(await status("revoked", "online")).toBe("online");
});

test("only other servers answering is unreachable, never online or revoked", async () => {
  expect(await status("otherOnline")).toBe("offline");
  expect(await status("otherMissing", "otherRefusing", "otherForbidden")).toBe("offline");
});

test("an older OpenBuild that names no server is still taken as the device", async () => {
  expect(await status("legacyOnline")).toBe("online");
  expect(await status("legacyRevoked")).toBe("revoked");
  expect(await status("otherMissing", "legacyOnline")).toBe("online");
});
