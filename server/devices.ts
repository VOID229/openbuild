// Paired devices.
//
// A "host" device runs an ordinary OpenBuild server and shows a short pairing code
// (`openbuild pair --host`). A "client" device enters that code (`openbuild pair --client`) and
// keeps a token, so its OpenBuild UI can use the host's server: projects, worktrees, Pi turns and
// shells all run there, proxied through /api/devices/<id>/… on the client's server.
//
// Files are kept next to the database with owner-only permissions:
//   devices.json          this server's paired hosts, including their tokens (client side)
//   paired-clients.json   tokens (hashed) of devices allowed to use this server (host side)
//   pairing.json          a pending pairing code, while `openbuild pair --host` waits (host side)
//   device-name           the name chosen for this device when it hosted a pairing
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { Device } from "../shared/types";
import { dataDir } from "./paths";
import * as storage from "./storage";

const DATA = dataDir();
const DEVICES = join(DATA, "devices.json");
const PAIRED = join(DATA, "paired-clients.json");
const PAIRING = join(DATA, "pairing.json");
const NAME = join(DATA, "device-name");

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PAIR_TTL = 15 * 60 * 1000;

export interface StoredDevice extends Device {
  token: string;
  serverId?: string;
}

interface PairedClient {
  id: string;
  name: string;
  tokenHash: string;
  createdAt: number;
  lastSeenAt?: number;
}

export interface PendingPairing {
  code: string;
  name: string;
  machine: string;
  mode: "lan" | "tailscale";
  urls: string[];
  createdAt: number;
  expiresAt: number;
  claimedBy?: string;
  claimedAt?: number;
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Write owner-only, atomically. */
function writeJson(file: string, value: unknown): void {
  mkdirSync(DATA, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {}
  }
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** This server's own id (its data), shared with /api/config and reply streams. */
export function serverId(): string {
  let id = storage.getValue("server-id");
  if (!id) {
    storage.setValue("server-id", (id = crypto.randomUUID()));
  }
  return id;
}

/** The name chosen for this device, or its computer name. */
export function deviceName(): string {
  try {
    const name = readFileSync(NAME, "utf8").trim();
    if (name) return name;
  } catch {}
  return hostname().replace(/\.local$/, "");
}

export function setDeviceName(name: string): void {
  const clean = name.trim().slice(0, 80);
  if (!clean) return;
  mkdirSync(DATA, { recursive: true, mode: 0o700 });
  writeFileSync(NAME, clean + "\n", { mode: 0o600 });
}

// ------------------------------------------------------------------ host side: pending pairing

const newCode = () => {
  const bytes = randomBytes(8);
  const chars = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]!);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
};

/** Start waiting for a client. A local pairing is replaced by a newer one. */
export function createPairing(input: { name: string; mode: "lan" | "tailscale"; urls: string[] }): PendingPairing {
  const now = Date.now();
  const pending: PendingPairing = {
    code: newCode(),
    name: input.name.trim().slice(0, 80) || hostname(),
    machine: hostname().replace(/\.local$/, ""),
    mode: input.mode,
    urls: input.urls,
    createdAt: now,
    expiresAt: now + PAIR_TTL,
  };
  setDeviceName(pending.name);
  writeJson(PAIRING, pending);
  return pending;
}

export function readPairing(): PendingPairing | undefined {
  const pending = readJson<PendingPairing | undefined>(PAIRING, undefined);
  if (!pending) return undefined;
  if (!pending.code || pending.expiresAt <= Date.now()) {
    rmSync(PAIRING, { force: true });
    return undefined;
  }
  return pending;
}

export function cancelPairing(): void {
  rmSync(PAIRING, { force: true });
}

/** What a discovering client may see: that a pairing is open, and what device it is. Never the code. */
export function pairingInfo() {
  const pending = readPairing();
  if (!pending) return { pending: false as const };
  return {
    pending: true as const,
    name: pending.name,
    machine: pending.machine,
    mode: pending.mode,
    urls: pending.urls,
    deviceId: serverId(),
    expiresAt: pending.expiresAt,
    claimed: !!pending.claimedBy,
  };
}

function sameCode(a: string, b: string): boolean {
  const left = Buffer.from(a.toUpperCase());
  const right = Buffer.from(b.toUpperCase());
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Failed claims, so a code can't be guessed quickly (ten a minute is plenty for a person). */
let failures: number[] = [];

/** Exchange a pairing code for a token this client keeps. */
export function claimPairing(code: string, clientName: string): { token: string; device: Device } | undefined {
  const now = Date.now();
  failures = failures.filter((at) => at > now - 60_000);
  if (failures.length >= 10) return undefined;
  const pending = readPairing();
  if (!pending || pending.claimedBy || !sameCode(code.trim(), pending.code)) {
    failures.push(now);
    return undefined;
  }
  const token = randomBytes(32).toString("hex");
  const client: PairedClient = {
    id: crypto.randomUUID(),
    name: clientName.trim().slice(0, 80) || hostname().replace(/\.local$/, ""),
    tokenHash: hash(token),
    createdAt: now,
  };
  const list = readJson<PairedClient[]>(PAIRED, []);
  writeJson(PAIRED, [...list.filter((c) => c.name !== client.name || c.tokenHash !== client.tokenHash), client]);
  // Leave the claimed pairing for the waiting CLI to notice, then it cleans it up.
  writeJson(PAIRING, { ...pending, claimedBy: client.name, claimedAt: Date.now() });
  return {
    token,
    device: {
      id: serverId(),
      name: pending.name,
      machine: pending.machine,
      mode: pending.mode,
      urls: pending.urls,
      pairedAt: Date.now(),
      serverId: serverId(),
    } as Device & { serverId: string },
  };
}

/** A paired device's token, checked for every proxied request. */
export function authenticateDevice(req: Request): { id: string; name: string } | undefined {
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer ([a-f0-9]{64})$/.exec(header);
  if (!match) return undefined;
  const wanted = hash(match[1]!);
  const list = readJson<PairedClient[]>(PAIRED, []);
  const client = list.find((c) => c.tokenHash === wanted);
  if (!client) return undefined;
  // Remember activity, but don't write the file on every streamed event.
  if (!client.lastSeenAt || Date.now() - client.lastSeenAt > 60_000) {
    client.lastSeenAt = Date.now();
    try {
      writeJson(PAIRED, list);
    } catch {}
  }
  return { id: client.id, name: client.name };
}

export function pairedClients(): Omit<PairedClient, "tokenHash">[] {
  return readJson<PairedClient[]>(PAIRED, []).map(({ tokenHash: _hash, ...rest }) => rest);
}

export function forgetPairedClient(id: string): void {
  writeJson(PAIRED, readJson<PairedClient[]>(PAIRED, []).filter((c) => c.id !== id));
}

// ------------------------------------------------------------------ client side: paired hosts

export function readDevices(): StoredDevice[] {
  return readJson<StoredDevice[]>(DEVICES, []);
}

export function addDevice(device: StoredDevice): void {
  const all = readDevices();
  const list = all.filter((d) => d.id !== device.id);
  // Pairing again renews the token; it doesn't change whose machine it is.
  const external = all.find((d) => d.id === device.id)?.external;
  writeJson(DEVICES, [...list, external ? { ...device, external } : device]);
}

export function setDeviceExternal(id: string, external: boolean): boolean {
  const list = readDevices();
  const device = list.find((d) => d.id === id);
  if (!device) return false;
  if (external) device.external = true;
  else delete device.external;
  writeJson(DEVICES, list);
  return true;
}

export function removeDevice(id: string): boolean {
  const list = readDevices();
  const next = list.filter((d) => d.id !== id);
  if (next.length === list.length) return false;
  writeJson(DEVICES, next);
  return true;
}

export function deviceCredentials(id: string): StoredDevice | undefined {
  return readDevices().find((d) => d.id === id);
}

/**
 * Ask a paired host to forget this client's token, so an unpair really revokes access.
 * Best effort: an unreachable or stopped server (one without a keeper) can't be told.
 */
export async function revokeDevice(device: StoredDevice): Promise<boolean> {
  for (const base of device.urls) {
    try {
      const res = await fetch(`${base.replace(/\/$/, "")}/api/pair/self`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${device.token}` },
        signal: AbortSignal.timeout(4000),
      });
      if (res.ok) return true;
    } catch {}
  }
  return false;
}

export function touchDevice(id: string, online: boolean): void {
  const list = readDevices();
  const device = list.find((d) => d.id === id);
  if (!device || !online) return;
  device.lastSeenAt = Date.now();
  try {
    writeJson(DEVICES, list);
  } catch {}
}

// ------------------------------------------------------------------ client side: controlling a paired host

interface RemoteAnswer {
  status: number;
  body?: { running?: boolean; keeper?: boolean; error?: string };
}

/** Call a paired host with its token, trying each saved address. Undefined when none answered. */
async function remoteCall(device: StoredDevice, path: string, method: "GET" | "POST", timeoutMs: number): Promise<RemoteAnswer | undefined> {
  for (const base of device.urls) {
    try {
      const res = await fetch(`${base.replace(/\/$/, "")}${path}`, {
        method,
        headers: { authorization: `Bearer ${device.token}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      return { status: res.status, body: await res.json().catch(() => undefined) };
    } catch {}
  }
  return undefined;
}

/**
 * Where a paired host's server stands. A stopped server's keeper still answers /api/remote/status,
 * so "stopped" (startable from here) is told apart from "unreachable".
 */
export async function probeDevice(device: StoredDevice): Promise<Device> {
  const { token: _token, ...shown } = device;
  const answer = await remoteCall(device, "/api/remote/status", "GET", 1500);
  const status: Device["status"] = !answer
    ? "offline"
    : answer.status === 401
      ? "revoked"
      : answer.status === 200 && answer.body?.running === false
        ? "stopped"
        : answer.status < 500
          ? "online"
          : "offline";
  if (status === "online" || status === "stopped") touchDevice(device.id, true);
  return {
    ...shown,
    status,
    online: status === "online",
    restartable: status === "stopped" || answer?.body?.keeper,
    lastSeenAt: status === "online" || status === "stopped" ? Date.now() : shown.lastSeenAt,
  };
}

/** Poll until the host's server is running (or stopped, with its keeper answering). */
async function waitForServer(device: StoredDevice, running: boolean, timeoutMs: number): Promise<boolean> {
  for (const end = Date.now() + timeoutMs; Date.now() < end; ) {
    await Bun.sleep(500);
    const answer = await remoteCall(device, "/api/remote/status", "GET", 1500);
    if (answer?.status === 200 && !!answer.body?.running === running) return true;
  }
  return false;
}

/**
 * Restart a paired host's server, or start it when it's stopped. The same steps as
 * `openbuild remote server stop` then `start`, so it needs the host's keeper: a server started some
 * other way (`bun dev`) would stay down, so that one is refused before anything stops.
 */
export async function restartDevice(device: StoredDevice): Promise<{ error?: string }> {
  const status = await remoteCall(device, "/api/remote/status", "GET", 4000);
  if (!status) return { error: `Couldn't reach ${device.name}.` };
  if (status.status === 401) return { error: `${device.name} no longer trusts this pairing. Unpair it and pair again.` };
  if (status.status !== 200) return { error: `${device.name} has no remote control. Update OpenBuild there.` };
  if (status.body?.running) {
    if (status.body.keeper === false) return { error: `${device.name} wasn't started with \`openbuild start\`, so it couldn't come back after stopping.` };
    const stop = await remoteCall(device, "/api/remote/stop", "POST", 4000);
    if (!stop || stop.status >= 300) return { error: `${device.name} didn't accept the stop.` };
    if (!(await waitForServer(device, false, 10_000))) return { error: `${device.name} didn't stop in time.` };
  }
  const start = await remoteCall(device, "/api/remote/start", "POST", 4000);
  if (!start || start.status >= 300) return { error: `${device.name} didn't accept the start.` };
  return (await waitForServer(device, true, 30_000)) ? {} : { error: `Asked ${device.name} to start, but it isn't answering yet.` };
}

/** Whether this server's keeper is running, so a paired device could start it again after a stop. */
export function keeperRunning(): boolean {
  try {
    const { pid } = JSON.parse(readFileSync(join(DATA, "keeper.json"), "utf8")) as { pid?: unknown };
    if (typeof pid !== "number") return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Whether a paired token can be used at all (the file is readable and holds this device). */
export function hasDevice(id: string): boolean {
  return readDevices().some((d) => d.id === id);
}

/** Diagnostic: where the pairing state lives. */
export const files = { devices: DEVICES, paired: PAIRED, pairing: PAIRING, name: NAME };
export const exists = (file: string) => existsSync(file) && statSync(file).isFile();
