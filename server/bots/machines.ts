// The machines bots' tools run on: this server, and every paired device. A bot has a computer of its
// own on each, and a tool call names its machine (this server when it names none). The call goes to
// that machine or fails saying why: nothing falls back to another. Pairing alone allows nothing
// there; the device's own grant (its Settings → Devices → Using this device) decides, and the device
// checks it on every request (computers/api.ts). How bots are kept apart on each machine, a
// container or the host, is this server's choice per machine (Settings → Devices), not per bot.
import { type ComputerTarget, type Isolation } from "../../shared/bots";
import { computerApi, computerTargets } from "../computers/api";
import { engines } from "../computers/index";
import * as devices from "../devices";
import { BotsError, getSettings, updateSettings } from "./service";

/** How bots' computers are kept apart on a machine. A container unless the user chose the host. */
export const isolationOf = (device: string): Isolation => (getSettings().isolation?.[device] === "host" ? "host" : "container");

/** Settings → Devices: a container or the host for bots on this server ("local") or a paired device. */
export function setIsolation(device: string, kind: unknown): Isolation {
  if (kind !== "container" && kind !== "host") throw new BotsError("Isolation is container or host.");
  if (device !== "local" && !devices.hasDevice(device)) throw new BotsError("That device isn't paired with this server.", 404);
  const isolation = { ...getSettings().isolation };
  if (kind === "container") delete isolation[device];
  else isolation[device] = kind;
  updateSettings({ isolation });
  return kind;
}

/** Every machine, what it allows this server's bots right now, and how they're kept apart there. */
export async function machines(): Promise<ComputerTarget[]> {
  return (await computerTargets()).map((t) => ({ ...t, isolation: isolationOf(t.device) }));
}

const LOCAL_NAMES = ["local", "this server", "here", "server"];
const shown = (value: string) => JSON.stringify(value.slice(0, 80));

/** "Studio (this server), Laptop (id)": what a bot can name. */
function choices(): string {
  return [`${devices.deviceName()} (this server)`, ...devices.readDevices().map((d) => `${d.name} (${d.id})`)].join(", ");
}

/**
 * The machine a tool call names, by name or id: this server when it names none. Only this server or
 * a paired device, matched exactly, never a guess. A paired device here may still refuse the call.
 */
export function resolveMachine(value: unknown): { device: string; name: string } {
  const here = { device: "local", name: devices.deviceName() };
  if (value === undefined || value === null || (typeof value === "string" && !value.trim())) return here;
  if (typeof value !== "string") throw new BotsError("machine is a machine's name or id, as your context lists them. Nothing ran.");
  const wanted = value.trim().toLowerCase();
  const all = [here, ...devices.readDevices().map((d) => ({ device: d.id, name: d.name }))];
  const byId = all.filter((m) => (m.device === "local" ? LOCAL_NAMES.includes(wanted) || wanted === devices.serverId() : m.device.toLowerCase() === wanted));
  const hits = byId.length ? byId : all.filter((m) => m.name.toLowerCase() === wanted);
  if (hits.length === 1) return hits[0]!;
  throw new BotsError(
    hits.length
      ? `More than one machine is called ${shown(value)}; use its id. Machines: ${choices()}. Nothing ran.`
      : `${shown(value)} isn't this server or a machine paired with it. Machines: ${choices()}. Nothing ran.`,
  );
}

/** A bot's computer on the machine a call names, started if need be. A paired device's runs there or not at all. */
export async function computerOn(botId: string, machine: unknown) {
  const { device, name } = resolveMachine(machine);
  const kind = isolationOf(device);
  if (device === "local" && kind === "container" && !(await engines()).length) {
    throw new BotsError(`${name} (this server) has no container engine (Podman or Docker), so bots' computers can't run in a container here. Install one, or have the user choose Host for ${name} in Settings → Devices. Nothing ran.`);
  }
  const api = computerApi(device);
  await api.call(botId, "ensure", { kind });
  return { api, id: botId, device, on: device === "local" ? undefined : name };
}

const TOOLS = ["files", "terminal", "browser"] as const;
const TROUBLE: Record<Exclude<ComputerTarget["status"], "ready" | "access">, string> = {
  offline: "unreachable right now",
  revoked: "no longer trusts this pairing",
  outdated: "needs a newer OpenBuild",
  mismatch: "its address answers as another machine",
  unpaired: "not paired anymore",
};

/** One machine, as a bot's context lists it. `here` is this server's name, which the device's owner looks for. */
export function machineLine(t: ComputerTarget, here: string): string {
  if (t.device === "local") return `- ${t.name} (this server, used when you don't name one): files, terminal, browser; ${t.isolation === "host" ? "host (unisolated)" : "container"}.`;
  const label = `- ${t.name} (machine id ${t.device})`;
  if (t.status === "access") return `${label}: hasn't allowed this server's bots anything. Its owner allows them on ${t.name}, in Settings → Devices → Using this device → ${here}.`;
  if (t.status !== "ready") return `${label}: ${TROUBLE[t.status]}. Its tools fail until that changes.`;
  const allowed = TOOLS.filter((k) => t.grants?.[k]);
  const missing = TOOLS.filter((k) => !t.grants?.[k]);
  const kind = t.isolation === "host" ? (t.grants?.unisolated ? "host (unisolated)" : "host chosen, but it only allows a container, so its tools fail") : "container";
  return `${label}: ${allowed.join(", ")}${missing.length ? ` (not ${missing.join(" or ")})` : ""}; ${kind}.`;
}

const NOTE_WAIT = 2500;

/** The machines a bot can reach, for its context. A device slow to answer doesn't hold up the turn: it's listed as not checked. */
export async function machinesNote(): Promise<string> {
  const here = devices.deviceName();
  const listed = await Promise.race([machines().catch(() => undefined), Bun.sleep(NOTE_WAIT).then(() => undefined)]);
  const lines = listed
    ? listed.map((t) => machineLine(t, here))
    : [machineLine({ device: "local", name: here, status: "ready", isolation: isolationOf("local") }, here), ...devices.readDevices().map((d) => `- ${d.name} (machine id ${d.id}): not checked yet; a call there finds out.`)];
  return [
    "Machines you can reach. bash, read, write, edit, browser and process run on this server unless you pass machine (a name or id from this list), and send_message takes machine for its images and attach_screenshot. You have a computer of your own on each: its own home folder, files, processes and browser, not shared with the others. A call a machine refuses or can't take fails; it never runs somewhere else instead. Whether a paired device allows this server's bots is its owner's choice, made on that device. A link to a file in a message is file:///path on this server, or file://<machine id>/path on another machine.",
    ...lines,
  ].join("\n");
}
