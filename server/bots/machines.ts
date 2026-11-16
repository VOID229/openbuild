// The machines bots' tools run on: this server, and every paired device. A bot has a computer of its
// own on each, and a tool call names its machine (this server when it names none). The call goes to
// that machine or fails saying why: nothing falls back to another. Pairing alone allows nothing
// there; the device's own grant (its Settings → Devices → Using this device) decides, and the device
// checks it on every request (computers/api.ts). How bots are kept apart on each machine, a
// container or the host, is this server's choice per machine (Settings → Devices), not per bot: the
// host unless the user chose a container there.
import { type ComputerTarget, type Isolation } from "../../shared/bots";
import type { BotToolGrants } from "../../shared/types";
import { computerApi, computerTargets } from "../computers/api";
import { engines } from "../computers/index";
import * as devices from "../devices";
import { BotsError, getSettings, updateSettings } from "./service";

/** The isolation the user chose for a machine in Settings → Devices, if they chose one. */
export const chosenIsolation = (device: string): Isolation | undefined => {
  const kind = getSettings().isolation?.[device];
  return kind === "container" || kind === "host" ? kind : undefined;
};

/**
 * How bots' computers are kept apart on a machine: what the user chose there, else the host. A
 * paired device whose owner allows only a container (no Unisolated in `grants`, or none known) gets
 * a container until the user chooses, since the host would only fail there.
 *
 * Before host was the default, only a choice of host was saved and a container was the absence of
 * one, so a machine left as it was then has nothing saved and runs on the host now. A choice made
 * here is saved either way, so it stays put if the default changes again.
 */
export const isolationOf = (device: string, grants?: Pick<BotToolGrants, "unisolated">): Isolation =>
  chosenIsolation(device) ?? (device === "local" || grants?.unisolated ? "host" : "container");

/** Settings → Devices: a container or the host for bots on this server ("local") or a paired device. */
export function setIsolation(device: string, kind: unknown): Isolation {
  if (kind !== "container" && kind !== "host") throw new BotsError("Isolation is container or host.");
  if (device !== "local" && !devices.hasDevice(device)) throw new BotsError("That device isn't paired with this server.", 404);
  updateSettings({ isolation: { ...getSettings().isolation, [device]: kind } });
  return kind;
}

/** Every machine, what it allows this server's bots right now, and how they're kept apart there. `engines: false` leaves this server's container engines unasked. */
export async function machines(opts: { engines?: boolean } = {}): Promise<ComputerTarget[]> {
  return (await computerTargets(opts)).map((t) => ({ ...t, isolation: isolationOf(t.device, t.grants) }));
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
  const api = computerApi(device);
  // Nothing chosen for a paired device: the host if its owner allows it, as Settings → Devices shows.
  const kind = device === "local" || chosenIsolation(device) ? isolationOf(device) : isolationOf(device, await api.grants());
  if (device === "local" && kind === "container" && !(await engines()).length) {
    throw new BotsError(`${name} (this server) has no container engine (Podman or Docker), so bots' computers can't run in a container here. Install one, or have the user choose Host for ${name} in Settings → Devices. Nothing ran.`);
  }
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

/** The longest a bot's context waits on its machines: only while nothing is known of them yet, as on the first turn after the server starts. */
const NOTE_WAIT = 2500;
/** How old what the machines said may be before they're asked again. */
const NOTE_FRESH = 60_000;
/** How long a turn gives that asking: a device that's awake answers within it, and one that isn't never holds the turn. */
const NOTE_GRACE = 150;

type Checked = Omit<ComputerTarget, "isolation">;
const hot = globalThis as { openbotsMachines?: { at: number; list: Checked[] }; openbotsMachinesCheck?: Promise<void> };

/** Ask every machine what it allows, once at a time, and keep what they said. Never rejects. */
function checkMachines(): Promise<void> {
  return (hot.openbotsMachinesCheck ??= Promise.resolve()
    .then(() => computerTargets({ engines: false }))
    .then((list) => void (hot.openbotsMachines = { at: Date.now(), list }), () => {})
    .finally(() => (hot.openbotsMachinesCheck = undefined)));
}

/** The server asks its paired devices as it starts, so the first turn's context doesn't wait on them. */
export function warmMachines() {
  if (devices.readDevices().length) void checkMachines();
}

/**
 * The machines a bot can reach, for its context. It's said from what each machine last answered, and
 * they're asked again behind the turn, never in front of it: a paired device that doesn't answer (a
 * laptop that's asleep) takes five seconds per address to give up on, and the note used to wait 2.5
 * seconds for it before the first model request of every turn of every bot, then listed every
 * device as "not checked yet". Now only the first note after the server starts waits that long;
 * after that a stale answer is given at most NOTE_GRACE to refresh, and the turn goes on with what's known.
 */
export async function machinesNote(): Promise<string> {
  const here = devices.deviceName();
  const paired = devices.readDevices();
  // The note says how bots are kept apart on each machine, which is the user's setting: no engine is asked,
  // which took `podman info` two seconds in front of a turn's first model request, whenever a minute had passed since the last.
  if (paired.length) {
    const known = hot.openbotsMachines;
    if (!known) await Promise.race([checkMachines(), Bun.sleep(NOTE_WAIT)]);
    else if (Date.now() - known.at > NOTE_FRESH) await Promise.race([checkMachines(), Bun.sleep(NOTE_GRACE)]);
  }
  const answered = new Map((hot.openbotsMachines?.list ?? []).map((t) => [t.device, t]));
  // Which machines there are and how bots are kept apart on each are read now; only what a device answered is from before.
  const lines = [
    machineLine({ device: "local", name: answered.get("local")?.name ?? here, status: "ready", isolation: isolationOf("local") }, here),
    ...paired.map((d) => {
      const t = answered.get(d.id);
      return t ? machineLine({ ...t, name: d.name, isolation: isolationOf(d.id, t.grants) }, here) : `- ${d.name} (machine id ${d.id}): not checked yet; a call there finds out.`;
    }),
  ];
  // Nothing is paired: there's one computer, and nothing to say about choosing between several.
  if (!paired.length) return ["Your computer is on this server: bash, read, write, edit, browser and process run there. A link to a file in a message is file:///path.", ...lines].join("\n");
  return [
    "Machines you can reach. bash, read, write, edit, browser and process run on this server unless you pass machine (a name or id from this list), and send_message takes machine for its images and attach_screenshot. You have a computer of your own on each: its own home folder, files, processes and browser, not shared with the others. A call a machine refuses or can't take fails; it never runs somewhere else instead. Whether a paired device allows this server's bots is its owner's choice, made on that device. A link to a file in a message is file:///path on this server, or file://<machine id>/path on another machine.",
    ...lines,
  ].join("\n");
}
