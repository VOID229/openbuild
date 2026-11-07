// One way into a computer, wherever it is. `dispatch` runs an operation on a computer on this
// machine; /api/computers/:id/:op exposes the same operations to the server this device is paired
// with (so a bot on that server can have its computer here); `computerApi(device)` is what the bots
// service uses: direct calls for "local", HTTP to the paired device otherwise.
//
// A paired server only gets what this machine allowed it (Settings → Devices → Using this device):
// files, terminal and browser are separate grants, all off after pairing, and so is running
// unisolated instead of in a container. Its computers live apart from this machine's own bots', so
// it can only reach the ones its own bots made. Every answer names this server, and the caller
// refuses one from any other: a tool never runs on a machine the bot wasn't pointed at.
import { createHash } from "node:crypto";
import type { ComputerCapabilities, ComputerTarget } from "../../shared/bots";
import type { BotToolGrants } from "../../shared/types";
import * as devices from "../devices";
import type { StoredDevice } from "../devices";
import { bad, readJson } from "../handlers";
import { capabilities, computer } from "./index";

/** The header every /api/computers answer carries: the server id of the machine that ran it. */
export const SERVER_HEADER = "x-openbuild-server";

type Tool = "files" | "terminal" | "browser";
const TOOL_LABEL: Record<Tool, string> = { files: "files", terminal: "the terminal", browser: "the browser" };

/** The grant an operation needs. Undefined for looking after the computer itself, which any grant allows. */
function needs(op: string): Tool | undefined {
  if (op === "fs") return "files";
  if (op === "exec" || op === "proc") return "terminal";
  if (op === "browser") return "browser";
  return undefined;
}

/** A paired server's computer, apart from this machine's bots' and other paired servers'. */
export const guestComputerId = (clientId: string, id: string) => "g" + createHash("sha256").update(`${clientId}\n${id}`).digest("hex").slice(0, 40);

/** Why a paired server can't run `op` here, or undefined when it may. */
function refusal(who: { name: string; botTools: BotToolGrants }, op: string, kind: "container" | "host"): string | undefined {
  const here = devices.deviceName();
  const g = who.botTools;
  const tool = needs(op);
  if (tool && !g[tool]) return `${here} hasn't allowed ${TOOL_LABEL[tool]} for bots from ${who.name}. Allow it on ${here}: Settings → Devices → Using this device.`;
  if (!g.files && !g.terminal && !g.browser) return `${here} hasn't allowed bots from ${who.name} to use it. Allow them on ${here}: Settings → Devices → Using this device.`;
  if (kind === "host" && !g.unisolated) return `${here} only allows bots from ${who.name} a container, not unisolated access. Choose Container in the bot's settings, or allow unisolated access on ${here}.`;
  return undefined;
}

type Body = Record<string, any>;

const b64 = (d: Buffer) => d.toString("base64");

/** Run one operation on a computer here. `exec` streams output through `onData`. */
export async function dispatch(id: string, op: string, body: Body, signal?: AbortSignal, onData?: (chunk: Buffer) => void): Promise<unknown> {
  const c = computer(id, body.kind === "container" || body.kind === "host" ? body.kind : undefined);
  switch (op) {
    case "ensure":
      if (body.kind === "container" || body.kind === "host") await c.setKind(body.kind);
      await c.ensure();
      return c.info();
    case "info":
      return c.info();
    case "stop":
      await c.stop();
      return c.info();
    case "destroy":
      await c.destroy();
      return { ok: true };
    case "exec":
      return c.exec(String(body.command ?? ""), { cwd: body.cwd, timeout: Number(body.timeout) || undefined, env: body.env, onData, signal });
    case "fs": {
      const path = String(body.path ?? ".");
      switch (body.op) {
        case "read":
          return { data: b64(await c.readFile(path)) };
        case "write":
          await c.writeFile(path, Buffer.from(String(body.data ?? ""), "base64"));
          return { ok: true };
        case "mkdir":
          await c.mkdir(path);
          return { ok: true };
        case "access":
          await c.access(path);
          return { ok: true };
        case "stat":
          return c.stat(path);
        case "readdir":
          return { names: await c.readdir(path) };
        case "list":
          return c.list(path);
      }
      throw Object.assign(new Error(`Unknown file operation ${body.op}`), { status: 400 });
    }
    case "browser": {
      await c.ensure();
      const br = c.browser();
      switch (body.action) {
        case "open":
          return br.open(String(body.url ?? ""), !!body.newTab);
        case "history":
          return br.history(body.direction === "forward" ? "forward" : body.direction === "reload" ? "reload" : "back");
        case "snapshot":
          return br.snapshot(Number(body.max) || undefined);
        case "click":
          return br.click(String(body.ref ?? ""));
        case "type":
          return br.type(String(body.ref ?? ""), String(body.text ?? ""), { submit: !!body.submit, replace: body.replace !== false });
        case "press":
          return br.press(String(body.key ?? ""));
        case "scroll":
          return br.scroll(body.direction === "up" ? "up" : "down", Number(body.amount) || undefined);
        case "screenshot":
          return br.screenshot(!!body.fullPage);
        case "eval":
          return { value: await br.evaluateScript(String(body.script ?? "")) };
        case "tabs":
          return { tabs: await br.listTabs() };
        case "switch":
          return br.switchTab(Number(body.index));
        case "close":
          await br.closeTab(Number(body.index));
          return { tabs: await br.listTabs() };
        case "quit":
          br.close();
          return { ok: true };
      }
      throw Object.assign(new Error(`Unknown browser action ${body.action}`), { status: 400 });
    }
    case "proc":
      switch (body.op) {
        case "start":
          return c.startProc(String(body.command ?? ""), body.name, !!body.notify);
        case "read":
          return c.readProc(String(body.id ?? ""), { input: typeof body.input === "string" ? body.input : undefined, all: !!body.all });
        case "stop":
          return c.stopProc(String(body.id ?? ""));
        case "list":
          return { procs: c.listProcs() };
      }
      throw Object.assign(new Error(`Unknown process operation ${body.op}`), { status: 400 });
  }
  throw Object.assign(new Error(`Unknown computer operation ${op}`), { status: 404 });
}

type Api = <R extends Request, A extends unknown[]>(handler: (req: R, ...rest: A) => Response | Promise<Response>) => (req: R, ...rest: A) => Response | Promise<Response>;

const stamp = (res: Response) => {
  res.headers.set(SERVER_HEADER, devices.serverId());
  return res;
};

/** /api/computers: for this server's bots service, and for the server this device is paired with. */
export function computerRoutes(api: Api) {
  return {
    "/api/computers/capabilities": {
      GET: api(async (req: Request) => {
        const who = devices.authenticateDevice(req);
        // A paired server also learns what it's allowed here, so its settings can say so before a bot tries.
        return stamp(Response.json({ ...(await capabilities()), serverId: devices.serverId(), machine: devices.deviceName(), ...(who && { grants: who.botTools }) } satisfies ComputerCapabilities));
      }),
    },
    "/api/computers/:id/:op": {
      POST: api(async (req: Bun.BunRequest<"/api/computers/:id/:op">, server: Bun.Server<unknown>) => {
        server.timeout(req, 0);
        let body = ((await readJson(req)) ?? {}) as Body;
        let { id } = req.params;
        const { op } = req.params;
        const who = devices.authenticateDevice(req);
        if (who) {
          try {
            id = guestComputerId(who.id, id);
            // A new guest computer is a container unless it asks otherwise; an existing one keeps its kind.
            const asked = body.kind === "host" || body.kind === "container" ? body.kind : undefined;
            const c = computer(id, asked ?? "container");
            const why = refusal(who, op, op === "ensure" && asked ? asked : c.config.kind);
            if (why) return stamp(bad(why, 403));
            body = { ...body, kind: asked ?? c.config.kind };
          } catch (err) {
            const e = err as Error & { status?: number };
            return stamp(bad(e.message, e.status ?? 500));
          }
        }
        if (op === "exec") {
          const enc = new TextEncoder();
          const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
              const send = (o: unknown) => controller.enqueue(enc.encode(JSON.stringify(o) + "\n"));
              try {
                const r = (await dispatch(id, op, body, req.signal, (d) => send({ t: "out", v: b64(d) }))) as { exitCode: number | null };
                send({ t: "exit", code: r.exitCode });
              } catch (err) {
                send({ t: "error", message: (err as Error).message });
              }
              controller.close();
            },
          });
          return stamp(new Response(stream, { headers: { "content-type": "application/x-ndjson" } }));
        }
        try {
          return stamp(Response.json(await dispatch(id, op, body, req.signal)));
        } catch (err) {
          const e = err as Error & { status?: number };
          return stamp(bad(e.message, e.status ?? 500));
        }
      }),
    },
  };
}

// ------------------------------------------------------------------ client

export interface ComputerApi {
  call<T = any>(id: string, op: string, body?: Body, signal?: AbortSignal): Promise<T>;
  exec(id: string, body: Body, onData: (chunk: Buffer) => void, signal?: AbortSignal): Promise<{ exitCode: number | null }>;
  capabilities(): Promise<ComputerCapabilities>;
}

const local: ComputerApi = {
  call: (id, op, body = {}, signal) => dispatch(id, op, body, signal) as Promise<any>,
  exec: (id, body, onData, signal) => dispatch(id, "exec", body, signal, onData) as Promise<{ exitCode: number | null }>,
  capabilities: () => capabilities(),
};

/** Why a paired device's computer can't be used right now. A bot sees `message`; the settings show `reason`. */
export class TargetError extends Error {
  constructor(
    readonly reason: "unpaired" | "offline" | "revoked" | "denied" | "outdated" | "mismatch",
    message: string,
  ) {
    super(message);
  }
}

/** Where each paired device was last found answering as itself, so a burst of tool calls checks once. */
const verified = new Map<string, { base: string; at: number }>();
const VERIFIED_FOR = 15_000;

/**
 * The address a paired device answers at as itself. Asked with a read-only request first, so an
 * address that now belongs to another machine (or an older OpenBuild, which doesn't check grants)
 * is found out before anything runs there.
 */
async function reach(device: StoredDevice, signal?: AbortSignal): Promise<string> {
  const known = verified.get(device.id);
  if (known && Date.now() - known.at < VERIFIED_FOR && device.urls.includes(known.base)) return known.base;
  verified.delete(device.id);
  let last = "it didn't answer";
  let refused: TargetError | undefined;
  for (const url of device.urls) {
    const base = url.replace(/\/$/, "");
    try {
      const res = await fetch(`${base}/api/computers/capabilities`, { headers: { authorization: `Bearer ${device.token}` }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000) });
      void res.body?.cancel().catch(() => {});
      if (res.status === 502 || res.status === 503 || res.status === 504) {
        last = `it answered HTTP ${res.status}`;
        continue;
      }
      if (res.status === 401) throw new TargetError("revoked", `${device.name} no longer trusts this pairing. Pair it again, or choose another computer in the bot's settings.`);
      const answered = res.headers.get(SERVER_HEADER);
      if (answered === device.id) {
        devices.touchDevice(device.id, true);
        verified.set(device.id, { base, at: Date.now() });
        return base;
      }
      // Another address may still be the right machine.
      refused ??= answered
        ? new TargetError("mismatch", `${base} isn't ${device.name} anymore: another OpenBuild answered there. Nothing ran.`)
        : new TargetError("outdated", `${device.name} needs a newer OpenBuild before bots can use it. Nothing ran.`);
    } catch (err) {
      if (err instanceof TargetError) throw err;
      if (signal?.aborted) throw new Error("aborted");
      last = (err as Error).message;
    }
  }
  throw refused ?? new TargetError("offline", `${device.name} is unreachable (${last}). Nothing ran; try again once it's online.`);
}

/** A request to a paired device's server, at the address it was just found answering as itself. */
async function deviceFetch(deviceId: string, path: string, init: RequestInit = {}): Promise<Response> {
  const device = devices.deviceCredentials(deviceId);
  if (!device) throw new TargetError("unpaired", "This bot's computer is on a device that isn't paired anymore. Choose another computer in the bot's settings.");
  const base = await reach(device, init.signal ?? undefined);
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${device.token}`, "content-type": "application/json" } });
  } catch (err) {
    verified.delete(deviceId);
    if (init.signal?.aborted) throw new Error("aborted");
    throw new TargetError("offline", `${device.name} stopped answering (${(err as Error).message}).`);
  }
  if (res.status === 401) {
    verified.delete(deviceId);
    throw new TargetError("revoked", `${device.name} no longer trusts this pairing. Pair it again, or choose another computer in the bot's settings.`);
  }
  if (res.headers.get(SERVER_HEADER) !== device.id) {
    verified.delete(deviceId);
    void res.body?.cancel().catch(() => {});
    throw new TargetError("mismatch", `${device.name}'s address answered as another machine.`);
  }
  if (res.status === 403) throw new TargetError("denied", ((await res.json().catch(() => ({}))) as { error?: string }).error ?? `${device.name} hasn't allowed this.`);
  return res;
}

function remote(deviceId: string): ComputerApi {
  return {
    async call(id, op, body = {}, signal) {
      const res = await deviceFetch(deviceId, `/api/computers/${encodeURIComponent(id)}/${op}`, { method: "POST", body: JSON.stringify(body), signal });
      const data = (await res.json().catch(() => ({}))) as any;
      if (!res.ok) throw new Error(data.error ?? `The device answered HTTP ${res.status}`);
      return data;
    },
    async exec(id, body, onData, signal) {
      const res = await deviceFetch(deviceId, `/api/computers/${encodeURIComponent(id)}/exec`, { method: "POST", body: JSON.stringify(body), signal });
      if (!res.ok || !res.body) throw new Error(((await res.json().catch(() => ({}))) as any).error ?? `The device answered HTTP ${res.status}`);
      const dec = new TextDecoder();
      let buf = "";
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          const e = JSON.parse(line);
          if (e.t === "out") onData(Buffer.from(e.v, "base64"));
          else if (e.t === "exit") return { exitCode: e.code };
          else if (e.t === "error") throw new Error(e.message);
        }
      }
      throw new Error(signal?.aborted ? "aborted" : `${devices.deviceCredentials(deviceId)?.name ?? "The device"} stopped answering mid-command. It may have run partly.`);
    },
    async capabilities() {
      const res = await deviceFetch(deviceId, "/api/computers/capabilities");
      if (!res.ok) throw new Error(`The device answered HTTP ${res.status}. It may need a newer OpenBuild.`);
      return { ...((await res.json()) as ComputerCapabilities), device: deviceId };
    },
  };
}

export const computerApi = (device: string): ComputerApi => (device === "local" ? local : remote(device));

/** Every place a bot's computer could run, and whether it can right now. Asks each paired device. */
export async function computerTargets(): Promise<ComputerTarget[]> {
  const here = await capabilities();
  const local: ComputerTarget = { device: "local", name: devices.deviceName(), status: "ready", grants: { files: true, terminal: true, browser: true, unisolated: true }, engines: here.engines };
  const remote = await Promise.all(
    devices.readDevices().map(async (d): Promise<ComputerTarget> => {
      try {
        const caps = await computerApi(d.id).capabilities();
        const g = caps.grants;
        return { device: d.id, name: d.name, status: g && (g.files || g.terminal || g.browser) ? "ready" : "access", grants: g, engines: caps.engines };
      } catch (err) {
        return { device: d.id, name: d.name, status: err instanceof TargetError ? (err.reason === "denied" ? "access" : err.reason) : "offline", message: (err as Error).message };
      }
    }),
  );
  return [local, ...remote];
}
