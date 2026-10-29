import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiClient } from "../server/pi/remote";

test("question capability upgrade never interrupts an active older worker or sends a prompt", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ob-question-upgrade-"));
  const socket = join(directory, "worker.sock");
  const paths: string[] = [];
  const server = Bun.serve({ unix: socket, fetch(req) {
    const path = new URL(req.url).pathname; paths.push(path);
    if (path === "/health") return Response.json({ pid: process.pid, protocol: 1, features: ["codex", "idle-retire"] });
    if (path === "/retire") return Response.json({ error: "Worker busy", code: "busy" }, { status: 409 });
    return new Response(null, { status: 404 });
  } });
  const client = new PiClient(directory, socket);
  try {
    await expect(client.startRun({ threadId: "question-upgrade", runtime: "codex", cwd: directory, model: "codex/test", effort: "off", message: "hello", prior: 0, stream: { id: "reply-question-upgrade-0123456789abcdef" } })).rejects.toThrow("enable runtime-questions");
    expect(paths).toContain("/retire");
    expect(paths.every(path => ["/health", "/retire"].includes(path))).toBe(true);
  } finally { client.close(); server.stop(true); rmSync(directory, { recursive: true, force: true }); }
});

test("new runtimes never signal an older worker using a racy client-side idle check", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ob-upgrade-"));
  const socket = join(directory, "worker.sock");
  const paths: string[] = [];
  const server = Bun.serve({ unix: socket, fetch(req) {
    const path = new URL(req.url).pathname;
    paths.push(path);
    // This process must never be signalled just because /records looks idle.
    if (path === "/health") return Response.json({ pid: process.pid, protocol: 1, features: [] });
    if (path === "/records") return Response.json([]);
    return new Response(null, { status: 404 });
  } });
  const client = new PiClient(directory, socket);
  try {
    await expect(client.startRun({ threadId: "upgrade-thread", runtime: "codex", cwd: directory, model: "codex/test", effort: "off", message: "hello", prior: 0, stream: { id: "reply-upgrade-0123456789abcdef" } })).rejects.toThrow("cannot safely upgrade automatically");
    await expect(client.startRun({ threadId: "upgrade-cursor-thread", runtime: "cursor", cwd: directory, model: "cursor/test", effort: "off", message: "hello", prior: 0, stream: { id: "reply-upgrade-cursor-0123456789abcdef" } })).rejects.toThrow("cannot safely upgrade automatically");
    await expect(client.startRun({ threadId: "upgrade-opencode-thread", runtime: "opencode", cwd: directory, model: "opencode/test/model", effort: "off", message: "hello", prior: 0, stream: { id: "reply-upgrade-opencode-0123456789abcdef" } })).rejects.toThrow("cannot safely upgrade automatically");
    try {
      await client.startRun({ threadId: "upgrade-message-thread", runtime: "opencode", cwd: directory, model: "opencode/test/model", effort: "off", message: "hello", prior: 0, stream: { id: "reply-upgrade-message-0123456789abcdef" } });
      throw new Error("Expected worker upgrade refusal");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("worker_upgrade");
    }
    expect(paths.every(path => path === "/health")).toBe(true);
  } finally {
    client.close();
    server.stop(true);
    rmSync(directory, { recursive: true, force: true });
  }
});
