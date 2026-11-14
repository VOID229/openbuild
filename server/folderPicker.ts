// The OS's own folder picker (Finder on macOS, zenity or kdialog on Linux), for the New project
// dialog's Browse button. A browser can't hand a page a folder's real path, so the server opens the
// picker instead. That only makes sense when the browser is on this machine: the picker appears on
// this machine's screen. "On this machine" goes by where the connection comes from, not by the name
// the page was opened at, so a browser here that reached the server over Tailscale or the LAN
// (http://100.x.y.z:4000, a MagicDNS name, `tailscale serve`) still gets the picker.
import { existsSync } from "node:fs";
import { homedir, networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import { resolve } from "node:path";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** An address as it can be compared: no IPv4-in-IPv6 wrapping, no zone, lower case. */
const plain = (ip: string) =>
  ip
    .trim()
    .toLowerCase()
    .replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, "")
    .replace(/%.*$/, "");

const loopback = (ip: string) => ip === "::1" || ip.startsWith("127.");

/** This machine's own addresses: loopback, the LAN, Tailscale's 100.x and fd7a:… ones, any other. */
export function ownAddresses(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): Set<string> {
  const out = new Set<string>();
  for (const list of Object.values(interfaces)) for (const a of list ?? []) out.add(plain(a.address));
  return out;
}

/**
 * Whether the browser making `req` runs on this machine.
 *
 * A connection from one of this machine's own addresses started here: a browser on this machine
 * that opens the server at its Tailscale or LAN address connects from that same address (another
 * device can't, as replies to it would never leave this machine). Over loopback, a browser that
 * asked for a loopback host is here too. Anything else over loopback came through a proxy on this
 * machine; `tailscale serve` sets X-Forwarded-For to the address the visitor connected from
 * (replacing whatever the visitor sent), so that address decides, the same way. A proxy that adds
 * to the header puts what it saw last, so only the last entry counts.
 */
export function sameMachine(req: Request, ip: string | undefined, own: Set<string> = ownAddresses()): boolean {
  if (!ip) return false;
  const from = plain(ip);
  if (!loopback(from)) return own.has(from);
  const host = (req.headers.get("host") ?? "").toLowerCase().replace(/:\d+$/, "");
  if (LOOPBACK_HOSTS.has(host)) return true;
  const forwarded = plain(req.headers.get("x-forwarded-for")?.split(",").at(-1) ?? "");
  return !!forwarded && own.has(forwarded);
}

const which = (bin: string) => Bun.which(bin) ?? undefined;
const hasDisplay = () => !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);

/** The command that opens the picker at `dir`, or nothing when this machine has none. */
function command(dir: string): string[] | undefined {
  if (process.platform === "darwin") {
    const at = dir.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    // Asked of the frontmost app (the browser), so the picker comes up in front instead of behind it.
    const script = `tell application (path to frontmost application as text) to POSIX path of (choose folder with prompt "Choose a project folder" default location POSIX file "${at}")`;
    return ["osascript", "-e", script];
  }
  if (process.platform !== "linux" || !hasDisplay()) return;
  const zenity = which("zenity");
  if (zenity) return [zenity, "--file-selection", "--directory", "--title=Choose a project folder", `--filename=${dir.replace(/\/?$/, "/")}`];
  const kdialog = which("kdialog");
  if (kdialog) return [kdialog, "--getexistingdirectory", dir, "--title", "Choose a project folder"];
}

export const available = () => !!command(homedir());

let open: Promise<string | undefined> | undefined;

/** Open the picker and wait for a folder; undefined when it was cancelled. One at a time. */
export function pickFolder(rawDir?: string): Promise<string | undefined> {
  if (open) return open;
  const expanded = resolve((rawDir ?? "").trim().replace(/^~(?=$|\/)/, homedir()) || homedir());
  const cmd = command(existsSync(expanded) ? expanded : homedir());
  if (!cmd) return Promise.reject(new Error("This machine has no folder picker"));
  open = (async () => {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    const path = out.trim().replace(/(.)\/$/, "$1");
    return code === 0 && path ? path : undefined;
  })().finally(() => {
    open = undefined;
  });
  return open;
}
