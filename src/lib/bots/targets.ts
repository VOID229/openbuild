// The machines bots reach: this server and every paired device, each with what it allows this
// server's bots right now and how they're isolated there. Bot settings list them read-only; each
// machine's isolation, and how to allow bots on it, live with that device in Settings → Devices.
// A machine that can't run a tool right now says why; the tool fails there instead of running on
// another machine.
import { create } from "zustand";
import type { ComputerTarget, Isolation } from "../../../shared/bots";
import { useStore } from "../store";

/** The list, fetched each time a list opens (statuses change as devices come and go). */
export async function loadTargets(): Promise<ComputerTarget[]> {
  const res = await fetch("/api/bots/targets");
  const body = (await res.json().catch(() => null)) as { targets?: ComputerTarget[]; error?: string } | null;
  if (!res.ok || !body?.targets) throw new Error(body?.error ?? `Couldn't list machines (HTTP ${res.status})`);
  return body.targets;
}

/** Settings → Devices: a container or the host for this server's bots on one machine. */
export async function setIsolation(device: string, isolation: Isolation): Promise<Isolation> {
  const res = await fetch(`/api/bots/targets/${encodeURIComponent(device)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ isolation }) });
  const body = (await res.json().catch(() => null)) as { isolation?: Isolation; error?: string } | null;
  if (!res.ok || !body?.isolation) throw new Error(body?.error ?? `Couldn't change isolation (HTTP ${res.status})`);
  return body.isolation;
}

const SHORT: Record<ComputerTarget["status"], string> = {
  ready: "Allows bots",
  access: "Doesn't allow bots",
  offline: "Unreachable",
  revoked: "Pairing revoked",
  outdated: "Needs update",
  mismatch: "Wrong machine",
  unpaired: "Not paired",
};

/** Whether bots can use it, in a word or two. */
export function targetStatus(t: ComputerTarget): string {
  return t.device === "local" ? "This server" : SHORT[t.status];
}

/** What a machine allows and how bots are kept apart there, for its line in a list. */
export function targetSummary(t: ComputerTarget): string {
  const kind = t.isolation === "host" ? "Host (unisolated)" : "Container";
  if (t.device === "local") return `Files, terminal and browser · ${kind}`;
  if (t.status !== "ready") return "";
  const tools = (["files", "terminal", "browser"] as const).filter((k) => t.grants?.[k]);
  const named = tools.map((k, i) => (i ? k : k[0]!.toUpperCase() + k.slice(1)));
  return `${named.length > 1 ? `${named.slice(0, -1).join(", ")} and ${named.at(-1)}` : named[0]} · ${kind}`;
}

/**
 * What to tell the user about a machine, or undefined when it's fine. `here` is this server's name,
 * which the other device lists under Settings → Devices → Using this device.
 */
export function targetNote(t: ComputerTarget, here: string): { tone: "warn" | "bad"; text: string } | undefined {
  if (t.device === "local") return undefined;
  const name = t.name;
  const where = `On ${name}, open Settings → Devices → Using this device → ${here}`;
  switch (t.status) {
    case "access":
      return { tone: "warn", text: `${name} hasn't allowed this server's bots anything yet. ${where}, and switch on Files, Terminal or Browser. Until then their tools fail there; nothing runs elsewhere instead.` };
    case "offline":
      return { tone: "warn", text: `${name} is unreachable. Bots' tools fail there until it's back; nothing runs elsewhere instead.` };
    case "revoked":
      return { tone: "bad", text: `${name} no longer trusts this pairing. Pair it again.` };
    case "outdated":
      return { tone: "bad", text: `${name} needs a newer OpenBuild before bots can use it.` };
    case "mismatch":
      return { tone: "bad", text: `${name}'s address now answers as another machine, so nothing is sent there. Pair it again.` };
    case "unpaired":
      return { tone: "bad", text: `${name} isn't paired anymore.` };
  }
  const g = t.grants;
  if (t.isolation === "host" && !g?.unisolated) return { tone: "warn", text: `Host is chosen for ${name}, but it only allows a container, so bots' tools fail there. Choose Container, or ${where.charAt(0).toLowerCase() + where.slice(1)} and allow Unisolated.` };
  const missing = (["files", "terminal", "browser"] as const).filter((k) => !g?.[k]);
  if (missing.length) return { tone: "warn", text: `${name} doesn't allow ${missing.join(" or ")}. Those tools fail there. ${where} to allow them.` };
  return undefined;
}

/** The device Settings → Devices should bring into view when it opens. */
export const useDeviceFocus = create<{ device?: string }>(() => ({}));

/** Open Settings → Devices at one device ("local" for this server). */
export function showDevice(device: string) {
  useDeviceFocus.setState({ device });
  useStore.getState().openSettings("devices");
}

/** A device row's element id, for Settings → Devices to scroll to. */
export const deviceRowId = (device: string) => `device-${device}`;
