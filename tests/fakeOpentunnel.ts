// A stand-in for the `opentunnel` client (0.6.2), for the tunnel tests. It behaves as the real one does
// where OpenBuild relies on it: `serve` listens on its control socket and connects a tunnel that
// exists but never creates one; `up` creates the tunnel (tunnel.json with a hostname) and, finding a
// service already running, has it reload instead of starting its own. Each run is noted, with its
// arguments, its whole environment and the route file it found, in $HOME/runs.jsonl: HOME is the
// folder OpenBuild gave the client. It reaches no relay: the fake relay in fakeTunnel.ts plays that part.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const command = args.at(-1);
const profile = args[args.indexOf("--profile") + 1] ?? "default";
let routes = "";
try {
  routes = readFileSync(join(process.env.XDG_CONFIG_HOME!, "opentunnel", `${profile}.toml`), "utf8");
} catch {}
const socket = join(process.env.XDG_RUNTIME_DIR!, "opentunnel", `${profile}.sock`);
// The wrapper OpenBuild ran: its path is how a test tells the native client from the npm launcher.
const native = process.env.FAKE_OPENTUNNEL_SELF ?? "";
appendFileSync(join(process.env.HOME!, "runs.jsonl"), JSON.stringify({ command, pid: process.pid, args, env: process.env, routes, serviceRunning: existsSync(socket), native }) + "\n");

if (command === "serve") {
  mkdirSync(join(process.env.XDG_RUNTIME_DIR!, "opentunnel"), { recursive: true, mode: 0o700 });
  writeFileSync(socket, "");
  const done = () => (rmSync(socket, { force: true }), process.exit(0));
  process.on("SIGTERM", done);
  process.on("SIGINT", done);
  setInterval(() => {}, 60_000);
} else if (command === "up") {
  // The real `up` starts a service of its own (or registers one with systemd) when none answers.
  if (!existsSync(socket)) {
    console.error("background service not running: would start one");
    process.exit(1);
  }
  const dir = join(process.env.XDG_DATA_HOME!, "opentunnel", profile);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "tunnel.json"), JSON.stringify({ id: "t1", hostname: "t1.relay.test" }));
  console.log("Connected https://t1.relay.test");
} else {
  console.error(`fake opentunnel: no ${command}`);
  process.exit(2);
}
