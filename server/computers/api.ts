// One way into a computer, wherever it is. `dispatch` runs an operation on a computer on this
// machine; /api/computers/:id/:op exposes the same operations to the server this device is paired
// with (so a bot on that server can have its computer here); `computerApi(device)` is what the bots
// service uses: direct calls for "local", HTTP to the paired device otherwise.
import type { ComputerCapabilities } from "../../shared/bots";
import * as devices from "../devices";
import { bad, readJson } from "../handlers";
import { capabilities, computer } from "./index";

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

/** /api/computers: for this server's bots service, and for the server this device is paired with. */
export function computerRoutes(api: Api) {
  return {
    "/api/computers/capabilities": { GET: api(async () => Response.json(await capabilities())) },
    "/api/computers/:id/:op": {
      POST: api(async (req: Bun.BunRequest<"/api/computers/:id/:op">, server: Bun.Server<unknown>) => {
        server.timeout(req, 0);
        const body = ((await readJson(req)) ?? {}) as Body;
        const { id, op } = req.params;
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
          return new Response(stream, { headers: { "content-type": "application/x-ndjson" } });
        }
        try {
          return Response.json(await dispatch(id, op, body, req.signal));
        } catch (err) {
          const e = err as Error & { status?: number };
          return bad(e.message, e.status ?? 500);
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

/** A request to a paired device's server, trying each of its addresses. */
async function deviceFetch(deviceId: string, path: string, init: RequestInit = {}): Promise<Response> {
  const device = devices.deviceCredentials(deviceId);
  if (!device) throw new Error("That paired device isn't paired anymore.");
  let last = "it didn't answer";
  for (const base of device.urls) {
    try {
      const res = await fetch(`${base.replace(/\/$/, "")}${path}`, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${device.token}`, "content-type": "application/json" } });
      if (res.status === 502 || res.status === 503 || res.status === 504) {
        last = `it answered HTTP ${res.status}`;
        continue;
      }
      devices.touchDevice(deviceId, true);
      return res;
    } catch (err) {
      if (init.signal?.aborted) throw new Error("aborted");
      last = (err as Error).message;
    }
  }
  throw new Error(`Couldn't reach ${device.name}: ${last}`);
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
      throw new Error(signal?.aborted ? "aborted" : "The device stopped answering");
    },
    async capabilities() {
      const res = await deviceFetch(deviceId, "/api/computers/capabilities");
      if (!res.ok) throw new Error(`The device answered HTTP ${res.status}. It may need a newer OpenBuild.`);
      return { ...((await res.json()) as ComputerCapabilities), device: deviceId };
    },
  };
}

export const computerApi = (device: string): ComputerApi => (device === "local" ? local : remote(device));
