// Where a bot's computer runs, for its settings: this server or a paired device, each with what it
// allows. A device that can't run the bot's tools right now stays selected and says why; tools then
// fail there instead of quietly running on this server.
import type { ComputerConfig, ComputerTarget } from "../../../shared/bots";

export const LOCAL: ComputerConfig = { device: "local", kind: "container" };

/** The list, fetched each time the settings open (statuses change as devices come and go). */
export async function loadTargets(): Promise<ComputerTarget[]> {
  const res = await fetch("/api/bots/targets");
  const body = (await res.json().catch(() => null)) as { targets?: ComputerTarget[]; error?: string } | null;
  if (!res.ok || !body?.targets) throw new Error(body?.error ?? `Couldn't list computers (HTTP ${res.status})`);
  return body.targets;
}

const SHORT: Record<ComputerTarget["status"], string> = {
  ready: "",
  access: "access required",
  offline: "unreachable",
  revoked: "pairing revoked",
  outdated: "needs update",
  mismatch: "wrong machine",
  unpaired: "not paired",
};

/** A "Runs on" option: the device's name, and its trouble when it has one. */
export function targetLabel(t: ComputerTarget): string {
  if (t.device === "local") return `${t.name} (this server)`;
  return SHORT[t.status] ? `${t.name} · ${SHORT[t.status]}` : t.name;
}

/** The options, with the bot's current device kept even when it's gone from the list (or still loading). */
export function targetOptions(targets: ComputerTarget[] | undefined, cfg: ComputerConfig): ComputerTarget[] {
  const list: ComputerTarget[] = targets?.length ? targets : [{ device: "local", name: "This server", status: "ready" }];
  if (cfg.device === "local" || list.some((t) => t.device === cfg.device)) return list;
  return [...list, targets ? { device: cfg.device, name: "A device", status: "unpaired" } : { device: cfg.device, name: "Paired device (checking…)", status: "ready" }];
}

/**
 * What to tell the user about the bot's computer, or undefined when it's fine. `here` is this
 * server's name, which the other device lists under Settings → Devices → Using this device.
 */
export function targetNote(target: ComputerTarget | undefined, cfg: ComputerConfig, here: string): { tone: "warn" | "bad"; text: string } | undefined {
  if (cfg.device === "local" || !target) return undefined;
  const name = target.name;
  const where = `On ${name}, open Settings → Devices → Using this device → ${here}`;
  switch (target.status) {
    case "access":
      return { tone: "warn", text: `Access required. ${name} hasn't allowed this server's bots anything yet. ${where}, and switch on Files, Terminal or Browser. Until then the bot's tools fail; nothing runs here instead.` };
    case "offline":
      return { tone: "warn", text: `${name} is unreachable. The bot's tools fail until it's back; nothing runs here instead.` };
    case "revoked":
      return { tone: "bad", text: `${name} no longer trusts this pairing. Pair it again, or choose another computer.` };
    case "outdated":
      return { tone: "bad", text: `${name} needs a newer OpenBuild before bots can use it.` };
    case "mismatch":
      return { tone: "bad", text: `${name}'s address now answers as another machine, so nothing is sent there. Pair it again.` };
    case "unpaired":
      return { tone: "bad", text: "This device isn't paired anymore. Choose another computer." };
  }
  const g = target.grants;
  if (cfg.kind === "host" && !g?.unisolated) return { tone: "warn", text: `${name} only allows a container. Choose Container, or ${where.charAt(0).toLowerCase() + where.slice(1)} and allow Unisolated.` };
  const missing = (["files", "terminal", "browser"] as const).filter((k) => !g?.[k]);
  if (missing.length) return { tone: "warn", text: `${name} doesn't allow ${missing.join(", ")}. Those tools fail; ${where} to allow them.` };
  return undefined;
}
