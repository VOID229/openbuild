// A stand-in for the `opentunnel` client, for the tunnel tests: it notes how OpenBuild started it (its
// arguments, its OPENTUNNEL_* environment and the route file it was given) in FAKE_OPENTUNNEL_RECORD,
// says it has a tunnel the way the real one does (tunnel.json with a hostname), and stays up until it's
// stopped. It reaches no relay: the fake relay in fakeTunnel.ts plays that part.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const profile = args[args.indexOf("--profile") + 1] ?? "default";
const configHome = process.env.XDG_CONFIG_HOME!;
const dataHome = process.env.XDG_DATA_HOME!;
let routes = "";
try {
  routes = readFileSync(join(configHome, "opentunnel", `${profile}.toml`), "utf8");
} catch {}
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("OPENTUNNEL_")));
writeFileSync(process.env.FAKE_OPENTUNNEL_RECORD!, JSON.stringify({ pid: process.pid, args, env, configHome, dataHome, routes }));
const dir = join(dataHome, "opentunnel", profile);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "tunnel.json"), JSON.stringify({ id: "t1", hostname: "t1.relay.test" }));
setInterval(() => {}, 60_000);
