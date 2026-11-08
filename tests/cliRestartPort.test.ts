import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chooseStartPort } from "../bin/startPort";

const root = resolve(import.meta.dir, "..");

test("CLI persists an alternative through noninteractive restart and honors an explicit override", async () => {
  const data = mkdtempSync(join(tmpdir(), "openbuild-restart-port-"));
  const original = Bun.serve({ hostname: "0.0.0.0", port: 0, fetch: () => new Response("unmanaged") });
  const env: NodeJS.ProcessEnv = {
    ...process.env, OPENCHAT_DATA_DIR: data, OPENCHAT_SECRETS: "file",
    OPENCHAT_SECRETS_FILE: join(data, "secrets.json"), PI_CODING_AGENT_DIR: join(data, "pi"),
    OPENBUILD_SYSTEMD: "0", CI: "1",
  };
  delete env.PORT;
  const cli = async (args: string[], port?: number) => {
    const child = Bun.spawn([process.execPath, join(root, "bin/openbuild.ts"), ...args], {
      env: { ...env, ...(port === undefined ? {} : { PORT: String(port) }) },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, stdout + stderr).toBe(0);
    return stdout + stderr;
  };
  const state = () => JSON.parse(readFileSync(join(data, "server.json"), "utf8")) as { pid: number; port: number; urls: string[] };
  const survives = async () => expect(await (await fetch(`http://127.0.0.1:${original.port}`)).text()).toBe("unmanaged");
  try {
    const alternative = await chooseStartPort(original.port!, { explicit: false, interactive: true, confirm: async () => true });
    expect(await cli(["start", "local"], alternative)).toContain(`http://localhost:${alternative}`);
    const first = state();
    expect(first.port).toBe(alternative);
    await survives();
    expect(await cli(["restart"])).toContain(`http://localhost:${alternative}`);
    expect(state().port).toBe(alternative);
    expect(state().pid).not.toBe(first.pid);
    expect(state().urls).toEqual([`http://localhost:${alternative}`]);
    expect(await cli(["status"])).toContain(`http://localhost:${alternative}`);
    await survives();
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const override = probe.port!;
    await probe.stop(true);
    expect(await cli(["restart"], override)).toContain(`http://localhost:${override}`);
    expect(state().port).toBe(override);
    expect(state().urls).toEqual([`http://localhost:${override}`]);
    await survives();
    expect(await cli(["stop"])).toContain("OpenBuild stopped");
    await survives();
  } finally {
    await cli(["stop"]);
    await original.stop(true);
    // Retain fixture files for inspection; no workers or user services are touched.
  }
}, 60_000);
