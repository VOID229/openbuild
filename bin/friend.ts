// `openbuild friend …`: friends are other people's OpenBuilds whose bots share group chats with yours
// (docs/friends.md). The running server does the work; this asks it over its control socket
// (server/friends/control.ts) and never opens the bots' database itself.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../server/paths";
import { MODE_LABEL, type FriendMode, type FriendSummary } from "../shared/friends";
import { ask, confirm } from "./prompt";

type Out = { fail: (msg: string) => never; bold: (s: string) => string; dim: (s: string) => string };

const socket = () => join(dataDir(), "friends", "control.sock");

export const FRIEND_HELP = `  openbuild friend invite [--tailscale|--lan|--tunnel]   let a friend's OpenBuild connect here (prints a one-time code)
  openbuild friend add <code> become friends with the OpenBuild that printed the code
  openbuild friend list       your friends, and whether they're connected
  openbuild friend remove <friend>   stop being friends, at once
  openbuild friend chat <friend> <name> --bots <bot,…>   share a new group chat with them
  openbuild friend chats      the chats you share with friends
  openbuild friend join|leave <chat> --bots <bot,…>   bring your bots into a shared chat, or out
  openbuild friend tools <friend> on|off   let your bots use their usual tools with them (off)`;

/** One call to the server's control socket. */
async function call<T = any>(out: Out, method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch("http://localhost/", { unix: socket(), method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method, params }), signal } as RequestInit);
  } catch (err) {
    if (signal?.aborted) throw err;
    return out.fail("OpenBuild isn't running here, and friends connect through it. Start it first: openbuild start");
  }
  const body = (await res.json().catch(() => ({}))) as { result?: T; error?: string };
  if (!res.ok || body.error) return out.fail(body.error ?? `the server answered ${res.status}`);
  return body.result as T;
}

/** `--bots a,b`, `--name x`, flags and the bare words left over. */
function parse(args: string[]) {
  const flags: Record<string, string | true> = {};
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const [name, value] = a.slice(2).split(/=(.*)/s);
      if (value !== undefined) flags[name!] = value;
      else if (["bots", "name", "address"].includes(name!)) flags[name!] = args[++i] ?? "";
      else flags[name!] = true;
    } else if (a !== "-y") words.push(a);
    else flags.yes = true;
  }
  return { flags, words };
}

const STATUS: Record<FriendSummary["status"], string> = { online: "connected", offline: "not connected", refused: "refused (they may have removed you)" };

function printFriends(out: Out, friends: FriendSummary[]) {
  if (!friends.length) return console.log("No friends yet. Run `openbuild friend invite` here, or `openbuild friend add <code>` with a friend's code.");
  for (const f of friends) {
    const how = f.role === "host" ? `you connect to them over ${MODE_LABEL[f.mode] ?? "Tailscale"}` : `they connect here over ${MODE_LABEL[f.mode] ?? "Tailscale"}`;
    console.log(`${out.bold(f.name)}  ${STATUS[f.status]}`);
    console.log(out.dim(`  ${f.fingerprint} · ${how}${f.allowTools ? " · bots may use their tools" : ""}`));
    if (f.failing) console.log(`  A message from them couldn't be delivered here after ${f.failing.attempts} tries (${f.failing.error}). Still trying; what they send next waits for it.`);
  }
}

/** The ACL snippet for the tailnet policy, so a friend's shared access reaches the friend port and nothing else. */
function aclHint(out: Out, ip: string, port: number) {
  console.log(`\n  ${out.bold("Share this computer with your friend in Tailscale")} (admin console → Machines → this machine → Share).`);
  console.log(out.dim("  Sharing reaches this machine only, but on every port your tailnet policy allows. To hold them to"));
  console.log(out.dim("  the friend port, add this to your tailnet policy file (Access controls):"));
  console.log(`\n    "grants": [\n      { "src": ["autogroup:shared"], "dst": ["${ip}"], "ip": ["tcp:${port}"] }\n    ]\n`);
  console.log(out.dim(`  and check no other rule has "src": ["*"], which includes shared users (use "autogroup:member").`));
  console.log(out.dim("  More, including the older \"acls\" form, in docs/friends.md."));
}

async function invite(out: Out, args: string[]) {
  const { flags } = parse(args);
  // Someone has to say yes to whoever uses the code: the owner at a terminal, or --yes beforehand.
  if (!process.stdin.isTTY && flags.yes !== true) out.fail("run this in a terminal so you can approve your friend, or pass --yes to approve whoever uses the code.");
  let mode: FriendMode | undefined = flags.lan ? "lan" : flags.tailscale ? "tailscale" : flags.tunnel ? "tunnel" : undefined;
  if (!mode) {
    if (!process.stdin.isTTY) out.fail("say --tailscale, --lan or --tunnel.");
    const answer = (await ask("Friends connect over [1] Tailscale, [2] LAN or [3] OpenTunnel? [1] ")).toLowerCase();
    mode = answer === "2" || answer === "lan" ? "lan" : answer === "3" || answer === "tunnel" ? "tunnel" : "tailscale";
  }
  const created = await call<{ code: string; urls: string[]; expiresAt: number; port: number; tailscaleIp?: string }>(out, "invite", {
    mode,
    ...(typeof flags.address === "string" ? { address: flags.address } : {}),
    ...(typeof flags.name === "string" ? { name: flags.name } : {}),
  });
  let cancelled = false;
  const cancel = async () => {
    if (cancelled) return;
    cancelled = true;
    await call(out, "cancel").catch(() => {});
  };
  process.once("SIGINT", () => void cancel().finally(() => (console.log("\nInvite cancelled."), process.exit(130))));
  console.log(`\n  Send your friend this code. It works once, for 15 minutes:\n\n  ${out.bold(created.code)}\n`);
  console.log(out.dim(`  They run: openbuild friend add <code>`));
  console.log(out.dim(`  It points at ${created.urls.join(", ")}, which only answers the friend protocol.`));
  if (mode === "tailscale" && created.tailscaleIp) aclHint(out, created.tailscaleIp, created.port);
  if (mode === "lan") console.log(out.dim("  Over LAN, what you and your friend's bots say is signed but not encrypted. Tailscale encrypts it."));
  if (mode === "tunnel") console.log(out.dim("  Through OpenTunnel, which reaches the friend listener only. Your friend needs nothing but the code."));
  console.log(out.dim("\n  Waiting for them… (Ctrl+C cancels)"));
  for (;;) {
    const { request } = await call<{ request: { id: string; name: string; fingerprint: string } | null }>(out, "wait");
    if (!request) {
      if (cancelled) return;
      return out.fail("the invite expired or was replaced before anyone used it.");
    }
    console.log(`\n  ${out.bold(request.name)} wants to be friends. Their key: ${request.fingerprint}`);
    console.log(out.dim("  If you weren't expecting them, decline. Friends' bots can talk with yours in chats you share, nothing else."));
    const approve = flags.yes === true || (await confirm("  Approve?", false));
    const { friend } = await call<{ friend: FriendSummary | null }>(out, "decide", { request: request.id, approve });
    if (!friend) return console.log(`  Declined. The invite is used up; run \`openbuild friend invite\` again for a new one.`);
    console.log(`\n  You and ${out.bold(friend.name)} are friends.`);
    console.log(out.dim(`  Share a chat: openbuild friend chat "${friend.name}" "<chat name>" --bots <your bot>`));
    return;
  }
}

async function add(out: Out, args: string[]) {
  const { flags, words } = parse(args);
  const code = words.join("") || (process.stdin.isTTY ? await ask("Friend's invite code: ") : "");
  if (!code) out.fail("usage: openbuild friend add <code>");
  let res: Response;
  try {
    res = await fetch("http://localhost/", { unix: socket(), method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method: "add", params: { code, ...(typeof flags.name === "string" ? { name: flags.name } : {}) } }) } as RequestInit);
  } catch {
    return out.fail("OpenBuild isn't running here, and friends connect through it. Start it first: openbuild start");
  }
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  console.log(out.dim("Asking their OpenBuild…"));
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buf += dec.decode(value, { stream: true });
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      const line = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      if (line.waiting) console.log(`Waiting for ${out.bold(line.waiting.name)} to approve. Their key: ${line.waiting.fingerprint}`);
      if (line.error) return out.fail(line.error);
      if (line.friend) {
        console.log(`\nYou and ${out.bold(line.friend.name)} are friends.`);
        console.log(out.dim("Chats they share with you show up in OpenBots. Pick which of your bots join from the chat's Members."));
        return;
      }
    }
    if (done) return out.fail("the server stopped answering.");
  }
}

/** With the server stopped, the list is still on disk. */
function listOffline(out: Out) {
  let friends: { id: string; name: string; role: "host" | "guest"; mode: FriendMode; addedAt: number }[] = [];
  try {
    friends = JSON.parse(readFileSync(join(dataDir(), "friends", "friends.json"), "utf8")).friends ?? [];
  } catch {}
  printFriends(out, friends.map((f) => ({ ...f, status: "offline", fingerprint: f.id.slice(0, 16).match(/.{4}/g)!.join("-") })));
  console.log(out.dim("OpenBuild isn't running, so nobody is connected."));
}

export async function friendCommand(args: string[], out: Out) {
  const [sub, ...rest] = args;
  const { flags, words } = parse(rest);
  switch (sub) {
    case "invite":
      return invite(out, rest);
    case "add":
      return add(out, rest);
    case undefined:
    case "list": {
      const status = await fetch("http://localhost/", { unix: socket(), method: "POST", body: JSON.stringify({ method: "status" }) } as RequestInit)
        .then((res) => res.json() as Promise<{ result?: { friends: FriendSummary[] } }>)
        .catch(() => undefined);
      return status?.result ? printFriends(out, status.result.friends) : listOffline(out);
    }
    case "remove": {
      if (!words.length) out.fail("usage: openbuild friend remove <friend>");
      const name = words.join(" ");
      if (process.stdin.isTTY && flags.yes !== true && !(await confirm(`Stop being friends with ${name}? Your shared chats stop syncing at once.`, false))) return;
      const { removed } = await call(out, "remove", { friend: name });
      console.log(`You and ${out.bold(removed)} aren't friends anymore. Their connection is closed and their key forgotten.`);
      return;
    }
    case "tools": {
      const [who, onOff] = [words.slice(0, -1).join(" "), words.at(-1)];
      if (!who || (onOff !== "on" && onOff !== "off")) out.fail("usage: openbuild friend tools <friend> on|off");
      const { name, allowTools } = await call(out, "tools", { friend: who, allow: onOff === "on" });
      console.log(allowTools ? `Your bots can use their usual tools in chats with ${out.bold(name)}. They still treat what ${name} writes as untrusted.` : `In chats with ${out.bold(name)}, your bots can only chat.`);
      return;
    }
    case "chat": {
      const [who, ...name] = words;
      if (!who || !name.length || typeof flags.bots !== "string") out.fail('usage: openbuild friend chat <friend> "<chat name>" --bots <bot>[,<bot>…]');
      const { chat } = await call(out, "chat", { friend: who, name: name.join(" "), bots: (flags.bots as string).split(",") });
      console.log(`Shared “${out.bold(chat.name)}” with ${chat.friend}, with ${chat.bots.join(", ")}. It's in OpenBots.`);
      return;
    }
    case "chats": {
      const { chats } = await call<{ chats: { id: string; name: string; friend: string; bots: string[]; theirs: string[]; ended?: string }[] }>(out, "chats");
      if (!chats.length) return console.log("No shared chats yet. Start one: openbuild friend chat <friend> \"<name>\" --bots <bot>");
      for (const c of chats) {
        console.log(`${out.bold(c.name)}  with ${c.friend}${c.ended ? " (not syncing anymore)" : ""}`);
        console.log(out.dim(`  ${c.id.slice(0, 8)} · yours: ${c.bots.join(", ") || "none yet"} · theirs: ${c.theirs.join(", ") || "none yet"}`));
      }
      return;
    }
    case "join":
    case "leave": {
      if (!words.length || typeof flags.bots !== "string") out.fail(`usage: openbuild friend ${sub} <chat> --bots <bot>[,<bot>…]`);
      const { chat } = await call(out, sub, { chat: words.join(" "), bots: (flags.bots as string).split(",") });
      console.log(`“${out.bold(chat.name)}” now has ${chat.bots.join(", ") || "none of your bots"}.`);
      return;
    }
    default:
      out.fail(`unknown friend command "${sub}".\n${FRIEND_HELP}`);
  }
}
