// Pi's providers and credentials, through the installed Pi's SDK (helper.mjs, run with Node).
// A sign-in is a small conversation: the helper asks for things (an API key, a pasted code, a
// choice) and reports progress (an authorization URL, a device code); the browser answers.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import * as storage from "../storage";
import { nodeBin, packageRoot, piEnv } from "./install";
import { PiError } from "./rpc";
import { restartIdle } from "./sessions";

const HELPER = join(import.meta.dir, "helper.mjs");

/** Names this OpenBuild install to providers whose sign-in asks for a device id. */
const deviceId = () => {
  let id = storage.getValue("pi-device-id");
  if (!id) storage.setValue("pi-device-id", (id = crypto.randomUUID()));
  return id;
};

function helper(args: string[]): ChildProcessWithoutNullStreams {
  const root = packageRoot();
  if (!root) throw new PiError("Pi isn't installed. Install it in Settings → Pi.");
  return spawn(nodeBin(), [HELPER, root, ...args], { env: { ...piEnv(), OPENBUILD_DEVICE_ID: deviceId() }, stdio: ["pipe", "pipe", "pipe"] });
}

/** Read the helper's JSONL output, record by record. */
function onRecords(child: ChildProcessWithoutNullStreams, fn: (r: any) => void) {
  let buf = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        fn(JSON.parse(line));
      } catch {}
    }
  });
}

/** Run a helper command that answers once. */
function once<T>(args: string[], timeoutMs = 60_000): Promise<T> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = helper(args);
    } catch (err) {
      return reject(err);
    }
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => (child.kill(), reject(new PiError("Pi took too long to answer"))), timeoutMs);
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.stdin.end();
    onRecords(child, (r) => {
      if (settled) return;
      if (r.type === "error") {
        settled = true;
        reject(new PiError(r.message));
      } else {
        settled = true;
        resolve(r as T);
      }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (!settled) reject(new PiError(stderr.trim().split("\n").pop() || `The Pi helper exited with code ${code}`));
    });
    child.on("error", (err) => (clearTimeout(timer), reject(err)));
  });
}

export interface PiProvider {
  id: string;
  name: string;
  apiKey?: { name: string; canLogin: boolean };
  oauth?: { name: string; label?: string; subscription: boolean };
  status: { configured: boolean; source?: string; label?: string };
  /** A credential saved in auth.json (removable with sign out). */
  stored?: "api_key" | "oauth";
  models: number;
}

export async function providers(): Promise<PiProvider[]> {
  return (await once<{ providers: PiProvider[] }>(["providers"])).providers;
}

export async function logout(provider: string) {
  await once(["logout", provider]);
  restartIdle();
}

// ------------------------------------------------------------------ sign-in conversations

interface Login {
  id: string;
  child: ChildProcessWithoutNullStreams;
  records: any[];
  done: boolean;
  waiters: Set<() => void>;
}
const hot = globalThis as { openbuildLogins?: Map<string, Login> };
const logins = (hot.openbuildLogins ??= new Map());

export function startLogin(provider: string, type: "api_key" | "oauth"): Login {
  // One sign-in at a time is plenty; a new one replaces any left hanging.
  for (const l of logins.values()) cancelLogin(l.id);
  const child = helper(["login", provider, type]);
  const login: Login = { id: crypto.randomUUID(), child, records: [], done: false, waiters: new Set() };
  const push = (r: any) => {
    login.records.push(r);
    for (const w of login.waiters) w();
    login.waiters.clear();
  };
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
  onRecords(child, (r) => {
    // Never echo secrets back: prompts and events carry none, but be strict about what's forwarded.
    if (["prompt", "prompt_closed", "event", "done", "error"].includes(r.type)) push(r);
  });
  child.on("close", (code) => {
    if (!login.records.some((r) => r.type === "done" || r.type === "error")) push({ type: "error", message: stderr.trim().split("\n").pop() || `Sign-in ended (code ${code})` });
    login.done = true;
    for (const w of login.waiters) w();
    login.waiters.clear();
    if (login.records.some((r) => r.type === "done")) restartIdle();
    setTimeout(() => logins.delete(login.id), 5 * 60_000).unref?.();
  });
  logins.set(login.id, login);
  return login;
}

export const findLogin = (id: string) => logins.get(id);

export function answerLogin(id: string, promptId: string, value: string | undefined): boolean {
  const l = logins.get(id);
  if (!l || l.done) return false;
  l.child.stdin.write(JSON.stringify(value === undefined ? { id: promptId, cancel: true } : { id: promptId, value }) + "\n");
  return true;
}

export function cancelLogin(id: string) {
  const l = logins.get(id);
  if (!l || l.done) return;
  l.child.stdin.end();
  setTimeout(() => !l.done && l.child.kill(), 3000).unref?.();
}

/** The sign-in's records as NDJSON, from the start, following it until it ends. */
export function loginStream(l: Login): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let sent = 0;
  return new ReadableStream({
    async pull(controller) {
      if (sent >= l.records.length && !l.done) {
        const beat = await Promise.race([new Promise<false>((r) => l.waiters.add(() => r(false))), new Promise<true>((r) => setTimeout(() => r(true), 15_000))]);
        if (beat && sent >= l.records.length && !l.done) return controller.enqueue(enc.encode("\n"));
      }
      if (sent < l.records.length) {
        const batch = l.records.slice(sent);
        sent += batch.length;
        return controller.enqueue(enc.encode(batch.map((r) => JSON.stringify(r) + "\n").join("")));
      }
      if (l.done) controller.close();
    },
  });
}
