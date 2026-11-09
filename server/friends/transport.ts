// How two friends' servers reach each other, kept apart from what they say (link.ts, protocol.ts).
// Whatever carries it, the shape is the same: the host runs the friend listener (listener.ts), the
// guest opens one connection to it and holds it, and frames go both ways over that. A transport only
// decides where the listener binds, which addresses an invite gives, and whatever has to keep running
// for those to reach it (a tunnel). Who's on the other end is proved by the friend protocol itself,
// never by the network: an address, a tunnel's URL or a loopback peer is no proof of anything.
import { networkInterfaces } from "node:os";
import type { FriendMode } from "../../shared/friends";
import { isTailscaleIp, tailscaleStatus } from "../pairClient";
import { tunnel } from "./tunnel";

export interface Socket {
  send(text: string): void;
  close(code?: number, reason?: string): void;
}

/** Where the friend listener binds for an invite, and the addresses its code gives. */
export interface Placement {
  listen: string;
  urls: string[];
  tailscaleIp?: string;
}

export interface Transport {
  /** Host side: where to listen for an invite, and what the guest dials. `address` is what the owner said to advertise instead. */
  place(input: { port: number; address?: string }): Promise<Placement>;
  /** Host side: keep whatever makes the listener reachable running while it's `needed`, and stop it when it isn't. */
  sync?(input: { needed: boolean; port: number }): void;
  stop?(): void;
}

/** Something the owner can fix: said to them as it is. */
export class TransportError extends Error {}

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) if (a.family === "IPv4" && !a.internal && !isTailscaleIp(a.address)) out.push(a.address);
  return out;
}

const bindable = (ip: string) => Object.values(networkInterfaces()).some((list) => list?.some((a) => a.address === ip));

const urlFor = (host: string, port: number) => (/^https?:\/\//.test(host) ? host.replace(/\/$/, "") : /:\d+$/.test(host) ? `http://${host}` : `http://${host}:${port}`);

function checkAddress(address: string | undefined) {
  if (address && !/^(https?:\/\/)?[A-Za-z0-9.\-[\]:]+$/.test(address)) throw new TransportError(`${address} isn't an address. Give a host or IP, optionally with :port.`);
}

const lan: Transport = {
  async place({ port, address }) {
    checkAddress(address);
    const urls = address ? [urlFor(address, port)] : lanAddresses().map((ip) => urlFor(ip, port));
    if (!urls.length) throw new TransportError("This computer has no LAN address. Connect it to a network, or give one with --address.");
    return { listen: "0.0.0.0", urls };
  },
};

const tailscale: Transport = {
  async place({ port, address }) {
    checkAddress(address);
    const status = await tailscaleStatus();
    const self = status?.Self;
    const ip: string | undefined = self?.TailscaleIPs?.find((a: string) => a.includes(".")) ?? Object.values(networkInterfaces()).flat().find((a) => a?.family === "IPv4" && isTailscaleIp(a.address))?.address;
    if (!ip) throw new TransportError("Tailscale isn't running here (no tailnet address found). Connect Tailscale first, or invite over LAN.");
    // Only the tailnet address, so the friend port isn't on any other network.
    if (!bindable(ip) && !process.env.OPENBUILD_FRIEND_HOST) throw new TransportError(`Tailscale here has no network interface for ${ip} (userspace networking), so OpenBuild can't listen on it. Run Tailscale with its own interface, or invite over LAN.`);
    const name = String(self?.DNSName ?? "").replace(/\.$/, "");
    return { listen: ip, urls: address ? [urlFor(address, port)] : [urlFor(ip, port), ...(name ? [urlFor(name, port)] : [])], tailscaleIp: ip };
  },
};

export const transports: Record<FriendMode, Transport> = { lan, tailscale, tunnel };

// ------------------------------------------------------------------ guest side: dialing

export interface DialEvents {
  message(text: string): void;
  close(code: number): void;
}

/** Guest side: one connection to a host's friend listener, carrying frames both ways. */
export type Dial = (url: string, events: DialEvents) => Socket;

/** A WebSocket: `ws://` on a LAN or tailnet, `wss://` through a tunnel. */
const webSocket: Dial = (url, events) => {
  const ws = new WebSocket(url);
  ws.onmessage = (event) => events.message(typeof event.data === "string" ? event.data : "");
  ws.onclose = (event) => events.close(event.code);
  ws.onerror = () => {};
  return { send: (t) => ws.send(t), close: (code, reason) => ws.close(code, reason) };
};

const hot = globalThis as { openbuildFriendDial?: Dial };
export const dial: Dial = (url, events) => (hot.openbuildFriendDial ?? webSocket)(url, events);
/** Carry friends' connections some other way (the tests' fakes); undefined goes back to WebSockets. */
export function setDial(next: Dial | undefined) {
  hot.openbuildFriendDial = next;
}
