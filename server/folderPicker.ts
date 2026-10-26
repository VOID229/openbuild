// The OS's own folder picker (Finder on macOS, zenity or kdialog on Linux), for the New project
// dialog's Browse button. A browser can't hand a page a folder's real path, so the server opens the
// picker instead. That only makes sense when the browser is on this machine: the picker appears on
// this machine's screen.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const LOOPBACK_IPS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * Whether the browser making `req` runs on this machine: it connected over loopback and asked for a
 * loopback host. A proxy on this machine (`tailscale serve`) also connects over loopback, but keeps
 * the public host name, so its visitors don't count.
 */
export function sameMachine(req: Request, ip: string | undefined): boolean {
  const host = (req.headers.get("host") ?? "").toLowerCase().replace(/:\d+$/, "");
  return !!ip && LOOPBACK_IPS.has(ip) && LOOPBACK_HOSTS.has(host);
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
