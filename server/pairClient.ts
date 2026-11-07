// Client side of pairing: find another OpenBuild that is waiting with `openbuild pair --host` and
// trade its code for a token. `openbuild pair --client` and Settings → Devices (POST
// /api/pair/connect) both use this, so the two stay one protocol.
//
// Only two fixed paths are ever requested from the other device, /api/pair/info and
// /api/pair/claim, with no redirects followed: a typed address can't turn this into a proxy.
import { existsSync } from "node:fs";
import { hostname, networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import type { Device } from "../shared/types";
import { discoverPairing, probePairing, type PairCandidate } from "../bin/pairDiscovery";
import * as devices from "./devices";

export type PairMode = "lan" | "tailscale";

export const isTailscaleIp = (ip: string) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip);

/** "abcd 2345", "ABCD2345" and "abcd-2345" are the same code: the host shows ABCD-2345. */
export function normalizeCode(raw: string): string {
  const clean = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return clean.length === 8 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : raw.trim().toUpperCase();
}

/** Addresses on this computer's LAN subnets to probe. */
export function lanCandidates(port: number, interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): string[] {
  const out = new Set<string>([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  for (const list of Object.values(interfaces)) {
    for (const a of list ?? []) {
      if (a.family !== "IPv4" || a.internal || isTailscaleIp(a.address)) continue;
      const prefix = a.address.split(".").slice(0, 3).join(".");
      for (let n = 1; n <= 254; n++) out.add(`http://${prefix}.${n}:${port}`);
    }
  }
  return [...out];
}

export const tailscaleArgs = (args: string[]) => (process.env.OPENBUILD_TAILSCALE_SOCKET ? [`--socket=${process.env.OPENBUILD_TAILSCALE_SOCKET}`, ...args] : args);
export const tailscaleBin = () => Bun.which("tailscale") ?? ["/usr/local/bin/tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"].find(existsSync);

/** `tailscale status --json`, or undefined when Tailscale isn't installed or answering. */
async function tailscaleStatus(signal?: AbortSignal): Promise<any> {
  const bin = tailscaleBin();
  if (!bin) return undefined;
  try {
    const child = Bun.spawn([bin, ...tailscaleArgs(["status", "--json"])], { stdout: "pipe", stderr: "ignore", signal, timeout: 20_000 });
    const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return code === 0 ? JSON.parse(out) : undefined;
  } catch {
    return undefined;
  }
}

/** This machine and its tailnet peers, by address and MagicDNS name. */
export function tailscalePeerCandidates(port: number, status: any): string[] {
  const out = new Set<string>([`http://127.0.0.1:${port}`]);
  if (!status) return [...out];
  for (const peer of [status.Self, ...Object.values(status.Peer ?? {})] as any[]) {
    for (const ip of peer?.TailscaleIPs ?? []) if (typeof ip === "string" && ip.includes(".")) out.add(`http://${ip}:${port}`);
    const dns = String(peer?.DNSName ?? "").replace(/\.$/, "");
    if (dns) {
      out.add(`https://${dns}`);
      out.add(`https://${dns}:${port}`);
      out.add(`http://${dns}:${port}`);
    }
  }
  return [...out];
}

export async function candidateUrls(mode: PairMode, port: number, signal?: AbortSignal): Promise<string[]> {
  return mode === "lan" ? lanCandidates(port) : tailscalePeerCandidates(port, await tailscaleStatus(signal));
}

/**
 * The origin a person typed (host, host:port, or http(s)://host[:port]), or undefined when it isn't
 * one. Paths, queries and credentials are refused rather than dropped, so nothing typed is sent on.
 */
export function addressOrigins(typed: string, port: number): string[] | undefined {
  const text = typed.trim();
  if (!text || text.length > 255 || /\s/.test(text)) return undefined;
  const explicit = /^https?:\/\//i.test(text);
  let url: URL;
  try {
    url = new URL(explicit ? text : `http://${text}`);
  } catch {
    return undefined;
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) return undefined;
  if (explicit) return [url.origin];
  const host = url.port ? url.host : `${url.hostname}:${port}`;
  // Tailscale often has HTTPS on a nonstandard port; a LAN host is usually plain HTTP.
  return [`https://${host}`, `http://${host}`];
}

/** Probe a typed address, trying HTTPS then HTTP when no scheme was given. */
export async function probeAddress(typed: string, port: number, signal?: AbortSignal): Promise<PairCandidate | undefined> {
  for (const origin of addressOrigins(typed, port) ?? []) {
    const found = await probePairing(origin, signal);
    if (found) return found;
  }
  return undefined;
}

export type ClaimResult = { device: Device } | { rejected: true };

/**
 * Trade the code for a token at one waiting host and keep it (devices.json). The token stays on
 * this server: the result carries the device without it.
 */
export async function claimCandidate(candidate: PairCandidate, input: { code: string; mode: PairMode; name?: string; signal?: AbortSignal }): Promise<ClaimResult> {
  const timeout = AbortSignal.timeout(5000);
  const res = await fetch(`${candidate.base}/api/pair/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: input.code, name: input.name ?? hostname().replace(/\.local$/, "") }),
    redirect: "error",
    signal: input.signal ? AbortSignal.any([input.signal, timeout]) : timeout,
  });
  const body = (await res.json().catch(() => null)) as any;
  if (!res.ok || typeof body?.token !== "string" || !body?.device) return { rejected: true };
  const urls = [...new Set([candidate.base, ...(body.device.urls ?? [])].filter((u: unknown): u is string => typeof u === "string" && /^https?:\/\//.test(u)))];
  const stored: devices.StoredDevice = {
    ...body.device,
    id: String(body.device.id),
    name: String(body.device.name || candidate.name),
    machine: body.device.machine || candidate.machine,
    mode: body.device.mode === "lan" ? "lan" : body.device.mode === "tailscale" ? "tailscale" : input.mode,
    urls,
    token: String(body.token),
    serverId: body.device.serverId || body.device.id,
    pairedAt: Date.now(),
  };
  devices.addDevice(stored);
  const { token: _token, ...device } = stored;
  return { device };
}

export type PairOutcome =
  | { ok: true; device: Device }
  /** Nobody was waiting to pair (on the network, or at the typed address). */
  | { ok: false; reason: "not-found" }
  /** Someone was waiting, but no host accepted the code. */
  | { ok: false; reason: "rejected" }
  | { ok: false; reason: "cancelled" };

/**
 * Find a waiting host (on the tailnet or LAN, or at a typed address) and claim the code there.
 * Each waiting host is offered the code in turn until one accepts, as `openbuild pair --client` does.
 */
export async function pairWithCode(input: {
  mode: PairMode;
  code: string;
  address?: string;
  port: number;
  signal?: AbortSignal;
  name?: string;
  /** Skip this server id, so a server never pairs with itself. */
  selfId?: string;
  /** Addresses to look at instead of scanning (tests). */
  candidates?: string[];
}): Promise<PairOutcome> {
  const { signal } = input;
  const code = normalizeCode(input.code);
  async function* waiting(): AsyncGenerator<PairCandidate> {
    if (input.address) {
      const found = await probeAddress(input.address, input.port, signal);
      if (found) yield found;
      return;
    }
    yield* discoverPairing(input.candidates ?? (await candidateUrls(input.mode, input.port, signal)), probePairing, 64, signal);
  }
  let seen = false;
  for await (const candidate of waiting()) {
    if (signal?.aborted) break;
    if (input.selfId && candidate.deviceId === input.selfId) continue;
    seen = true;
    try {
      const result = await claimCandidate(candidate, { code, mode: input.mode, name: input.name, signal });
      if ("device" in result) return { ok: true, device: result.device };
    } catch {
      // Try the next host that has a pairing open.
    }
  }
  if (signal?.aborted) return { ok: false, reason: "cancelled" };
  return { ok: false, reason: seen ? "rejected" : "not-found" };
}

/**
 * Pairing from Settings goes through this server, so it is limited here too: one search at a time,
 * and a handful a minute. The host keeps its own limit on wrong codes as well.
 */
const ATTEMPTS_PER_MINUTE = 10;
let attempts: number[] = [];
let inFlight = false;

export function beginAttempt(now = Date.now()): { end: () => void } | { busy: true } | { limited: true; retryAfter: number } {
  if (inFlight) return { busy: true };
  attempts = attempts.filter((at) => at > now - 60_000);
  if (attempts.length >= ATTEMPTS_PER_MINUTE) return { limited: true, retryAfter: Math.max(1, Math.ceil((attempts[0]! + 60_000 - now) / 1000)) };
  attempts.push(now);
  inFlight = true;
  let ended = false;
  return { end: () => void (!ended && ((ended = true), (inFlight = false))) };
}
