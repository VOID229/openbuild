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

export function listDevices(): Device[] {
  return readJson<StoredDevice[]>(DEVICES, []).map(({ token: _token, ...device }) => device);
}

export function readDevices(): StoredDevice[] {
  return readJson<StoredDevice[]>(DEVICES, []);
}

export function addDevice(device: StoredDevice): void {
  const list = readDevices().filter((d) => d.id !== device.id);
  writeJson(DEVICES, [...list, device]);
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

export function touchDevice(id: string, online: boolean): void {
  const list = readDevices();
  const device = list.find((d) => d.id === id);
  if (!device || !online) return;
  device.lastSeenAt = Date.now();
  try {
    writeJson(DEVICES, list);
  } catch {}
}

/** Whether a paired token can be used at all (the file is readable and holds this device). */
export function hasDevice(id: string): boolean {
  return readDevices().some((d) => d.id === id);
}

/** Diagnostic: where the pairing state lives. */
export const files = { devices: DEVICES, paired: PAIRED, pairing: PAIRING, name: NAME };
export const exists = (file: string) => existsSync(file) && statSync(file).isFile();
