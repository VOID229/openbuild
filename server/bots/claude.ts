// Claude for bots: the pi-claude-code bridge (claude-code/, vendored) ships with OpenBuild, so a
// bot can run on a Claude subscription without the user enabling a Pi package. Each Claude Code
// login on this server (the default one, plus the accounts Settings knows or finds, such as a
// `claude2` wrapper) is its own provider: `claude-code`, `claude-code-2`, …
//
// Signing in is Claude Code's own: `claude auth login --claudeai` under that login's config
// directory. The user opens its link, approves, and pastes the code back; it goes to the CLI's
// stdin and nowhere else. OpenBuild never reads, copies or stores Claude's credentials: status
// comes from `claude auth status`. Disconnecting takes the login away from bots and leaves Claude
// Code signed in, unless the user also asks to sign it out.
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { BotClaudeLogin, BotClaudeSignIn } from "../../shared/bots";
import type { PiChatRequest, RuntimeAccount } from "../../shared/types";
import { claudeAccounts } from "../claude/accounts";
import { claudeBin } from "../claude/install";
import { withRuntimeAccount } from "../runtimeAccounts";
import * as storage from "../storage";
import { botsDir } from "./db";
import * as svc from "./service";

const BRIDGE = join(import.meta.dir, "claude-code", "index.ts");
/** The pi-claude-code package's own name: a user's copy of it registers the same providers. */
export const BRIDGE_PACKAGE = "@earendil-works/pi-claude-code";
export const DEFAULT_ID = "claude-code";
const SIGN_IN_MS = 10 * 60_000;
const STATUS_MS = 20_000;
/** Claude Code reads these before its own sign-in; a bot's subscription must not quietly become an API key. */
const AMBIENT_AUTH = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"];

export interface ClaudeProfile {
  id: string;
  name: string;
  configDir: string;
  command?: string;
}

/** The accounts the app saved for this server, as the last browser left them. */
function savedAccounts(): RuntimeAccount[] {
  try {
    const accounts = JSON.parse(storage.getValue("client-state") ?? "{}")?.state?.settings?.runtimeAccounts;
    return Array.isArray(accounts) ? accounts.filter((a: RuntimeAccount) => a?.runtime === "claude" && !a.deviceId) : [];
  } catch {
    return [];
  }
}

/** `claude2` → `claude-code-2`, `work` → `claude-code-work`: the ids the pi-claude-code package uses. */
export function providerId(accountId: string): string {
  const suffix = accountId.replace(/^claude[-_]?/, "") || accountId;
  return `${DEFAULT_ID}-${suffix}`;
}

/** Every Claude Code login on this server, whether bots use it or not. */
export function allProfiles(saved: unknown = savedAccounts(), home = homedir(), path = process.env.PATH ?? ""): ClaudeProfile[] {
  const command = claudeBin();
  const primary = resolve((home === homedir() && process.env.CLAUDE_CONFIG_DIR) || join(home, ".claude"));
  const profiles: ClaudeProfile[] = [{ id: DEFAULT_ID, name: "Claude", configDir: primary, command }];
  for (const account of claudeAccounts(saved, home, path)) {
    const id = providerId(account.id);
    if (profiles.some((p) => p.id === id || p.configDir === account.configDir)) continue;
    const bin = withRuntimeAccount({ runtime: "claude", runtimeAccount: account } as PiChatRequest, () => claudeBin()) ?? command;
    profiles.push({ id, name: `Claude (${id.slice(DEFAULT_ID.length + 1)})`, configDir: account.configDir, command: bin });
  }
  return profiles;
}

let recent: { at: number; profiles: ClaudeProfile[] } | undefined;

/** The logins bots load: all but the ones the user disconnected here. Asked on every turn, so kept a few seconds. */
export function botProfiles(): ClaudeProfile[] {
  if (!recent || Date.now() - recent.at > 10_000) recent = { at: Date.now(), profiles: allProfiles() };
  const off = new Set(svc.getSettings().claude?.off ?? []);
  return recent.profiles.filter((p) => !off.has(p.id));
}

/**
 * The file bots' Pi loads (`-e`) for these logins, or undefined when there are none. It's named
 * after what it holds, so a change of logins (or a sign-in) is a new set of flags: Pi's model
 * listings are asked again and each bot's Pi starts over between turns.
 */
export function bridgeExtension(profiles = botProfiles(), revision = svc.getSettings().claude?.changedAt ?? 0): string | undefined {
  if (!profiles.length) return undefined;
  const body = `// Written by OpenBuild for bots' Pi (revision ${revision}). Holds no credentials.\nimport bridge from ${JSON.stringify(BRIDGE)};\nexport default (pi: any) => bridge(pi, ${JSON.stringify(profiles)});\n`;
  const dir = join(botsDir(), "claude-code");
  const path = join(dir, `bridge-${Bun.hash(body).toString(36)}.ts`);
  if (existsSync(path)) return path;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, body, { mode: 0o600 });
  // Older ones a Pi may be starting with stay a while.
  for (const name of readdirSync(dir)) {
    const old = join(dir, name);
    try {
      if (old !== path && name.startsWith("bridge-") && Date.now() - statSync(old).mtimeMs > 3600_000) unlinkSync(old);
    } catch {}
  }
  return path;
}

function cliEnv(profile: ClaudeProfile): Record<string, string> {
  const env = { ...process.env, PATH: `${join(homedir(), ".local/bin")}:${process.env.PATH ?? ""}`, CLAUDE_CONFIG_DIR: profile.configDir, BROWSER: "true" } as Record<string, string>;
  for (const key of AMBIENT_AUTH) delete env[key];
  return env;
}

function profile(id: string): ClaudeProfile {
  const found = allProfiles().find((p) => p.id === id);
  if (!found) throw new svc.BotsError("There's no such Claude login on this server.", 404);
  return found;
}

const tilde = (path: string) => (path.startsWith(homedir() + "/") ? `~${path.slice(homedir().length)}` : path);

/** Claude Code's own answer for one login. */
async function authStatus(p: ClaudeProfile): Promise<{ loggedIn: boolean; email?: string; plan?: string; method?: string; error?: string }> {
  if (!p.command) return { loggedIn: false, error: "Claude Code isn't installed on this server." };
  const run = async () => {
    const proc = Bun.spawn([p.command!, "auth", "status", "--json"], { env: cliEnv(p), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(), STATUS_MS);
    const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    clearTimeout(timer);
    return out.trim();
  };
  // Claude Code sometimes answers with nothing at all; that isn't a sign-out.
  for (let attempt = 0; attempt < 3; attempt++) {
    const out = await run().catch(() => "");
    const json = out.slice(Math.max(0, out.indexOf("{")));
    try {
      const status = JSON.parse(json);
      if (status?.loggedIn !== true) return { loggedIn: false };
      return {
        loggedIn: true,
        email: typeof status.email === "string" ? status.email : undefined,
        plan: typeof status.subscriptionType === "string" ? status.subscriptionType : undefined,
        method: typeof status.authMethod === "string" ? status.authMethod : undefined,
      };
    } catch {}
    await Bun.sleep(150 * (attempt + 1));
  }
  return { loggedIn: false, error: "Claude Code didn't say whether it's signed in. Try again in a moment." };
}

// ------------------------------------------------------------------ signing in

interface Flow {
  id: string;
  profileId: string;
  proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  sign: BotClaudeSignIn;
  output: string;
  timer: ReturnType<typeof setTimeout>;
}
const flows = new Map<string, Flow>();

function endFlow(flow: Flow, sign: Partial<BotClaudeSignIn>) {
  clearTimeout(flow.timer);
  flow.sign = { ...flow.sign, ...sign, url: undefined };
  if (flow.proc.exitCode === null) flow.proc.kill();
  // A finished one is shown once more, then forgotten.
  setTimeout(() => flows.get(flow.profileId) === flow && flows.delete(flow.profileId), 60_000).unref?.();
}

/** The last thing Claude Code said, without links or anything the user pasted. */
function said(output: string, code?: string): string | undefined {
  let line = output.split(/\r?\n/).map((l) => l.replace(/^.*Paste code here if prompted >\s*/, "").trim()).filter(Boolean).pop();
  if (!line) return undefined;
  if (code) line = line.split(code).join("…");
  return line.replace(/https?:\/\/\S+/g, "").slice(0, 300) || undefined;
}

async function startFlow(p: ClaudeProfile): Promise<BotClaudeSignIn> {
  if (!p.command) throw new svc.BotsError("Claude Code isn't installed on this server. Install it first.", 409);
  mkdirSync(p.configDir, { recursive: true, mode: 0o700 });
  const proc = Bun.spawn([p.command, "auth", "login", "--claudeai"], { env: cliEnv(p), cwd: homedir(), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const flow: Flow = { id: crypto.randomUUID(), profileId: p.id, proc, sign: { id: "", status: "starting", startedAt: Date.now() }, output: "", timer: setTimeout(() => endFlow(flow, { status: "failed", error: "The sign-in ran out of time. Start again." }), SIGN_IN_MS) };
  flow.sign.id = flow.id;
  flows.set(p.id, flow);
  const url = new Promise<string | undefined>((done) => {
    const read = async (stream: ReadableStream<Uint8Array>) => {
      const dec = new TextDecoder();
      for await (const chunk of stream) {
        flow.output = (flow.output + dec.decode(chunk, { stream: true })).slice(-8000);
        const found = /https:\/\/\S+\/oauth\/authorize\?\S+/.exec(flow.output)?.[0];
        if (found) done(found);
      }
    };
    void Promise.all([read(proc.stdout), read(proc.stderr)]).finally(() => done(undefined));
    setTimeout(() => done(undefined), 20_000);
  });
  void proc.exited.then((code) => {
    if (flow.sign.status === "waiting" || flow.sign.status === "starting") endFlow(flow, { status: "failed", error: said(flow.output) ?? `Claude Code stopped (exit ${code}) before the sign-in finished.` });
  });
  const link = await url;
  if (flows.get(p.id) !== flow || flow.sign.status !== "starting") return flow.sign;
  if (!link) {
    endFlow(flow, { status: "failed", error: said(flow.output) ?? "Claude Code didn't give a sign-in link." });
    return flow.sign;
  }
  flow.sign = { ...flow.sign, status: "waiting", url: link };
  return flow.sign;
}

/** Keep only what an authorization code looks like: no spaces, nothing that could be another line. */
function cleanCode(value: unknown): string {
  const code = typeof value === "string" ? value.trim() : "";
  if (!code || code.length > 1024 || /[\s\u0000-\u001f\u007f]/.test(code)) throw new svc.BotsError("Paste the code Claude showed you after you approved.", 400);
  return code;
}

// ------------------------------------------------------------------ what the routes do

export async function logins(): Promise<{ logins: BotClaudeLogin[]; installed: boolean; userPackage: boolean }> {
  const off = new Set(svc.getSettings().claude?.off ?? []);
  const all = allProfiles();
  recent = { at: Date.now(), profiles: all };
  const statuses = await Promise.all(all.map(authStatus));
  return {
    installed: !!all[0]?.command,
    userPackage: (await import("./extensions")).userBridgeSelected(),
    logins: all.map((p, i) => {
      const s = statuses[i]!;
      const flow = flows.get(p.id);
      return {
        id: p.id,
        name: p.name,
        configDir: tilde(p.configDir),
        signedIn: s.loggedIn,
        enabled: !off.has(p.id),
        email: s.email,
        plan: s.plan,
        method: s.method,
        error: s.error,
        signIn: flow?.sign,
      };
    }),
  };
}

function setOff(id: string, off: boolean) {
  const current = new Set(svc.getSettings().claude?.off ?? []);
  if (off) current.add(id);
  else current.delete(id);
  svc.updateSettings({ claude: { off: [...current], changedAt: Date.now() } });
}

/** Bots may use this login again; signs in first when Claude Code isn't. */
export async function connect(id: string): Promise<BotClaudeSignIn | undefined> {
  const p = profile(id);
  const running = flows.get(id);
  if (running && (running.sign.status === "waiting" || running.sign.status === "starting" || running.sign.status === "verifying")) return running.sign;
  if ((await authStatus(p)).loggedIn) {
    setOff(id, false);
    return undefined;
  }
  return startFlow(p);
}

export async function submitCode(id: string, flowId: unknown, value: unknown): Promise<BotClaudeSignIn> {
  const flow = flows.get(id);
  if (!flow || flow.id !== flowId || flow.sign.status !== "waiting") throw new svc.BotsError("That sign-in is over. Start again.", 409);
  const code = cleanCode(value);
  flow.sign = { ...flow.sign, status: "verifying" };
  flow.output = "";
  flow.proc.stdin.write(`${code}\n`);
  flow.proc.stdin.flush();
  const exit = await Promise.race([flow.proc.exited, Bun.sleep(60_000).then(() => undefined)]);
  if (exit === 0 && (await authStatus(profile(id))).loggedIn) {
    setOff(id, false);
    endFlow(flow, { status: "connected" });
  } else {
    endFlow(flow, { status: "failed", error: said(flow.output, code) ?? "Claude didn't accept that code. Start again to get a new one." });
  }
  return flow.sign;
}

export function cancel(id: string): void {
  const flow = flows.get(id);
  if (flow) {
    endFlow(flow, { status: "cancelled" });
    flows.delete(id);
  }
}

/**
 * Bots stop using this login. Claude Code stays signed in (Claude Code threads and the terminal use
 * it too) unless `signOut`, which runs `claude auth logout` for this login only.
 */
export async function disconnect(id: string, signOut: boolean): Promise<void> {
  const p = profile(id);
  cancel(id);
  setOff(id, true);
  if (!signOut || !p.command) return;
  const proc = Bun.spawn([p.command, "auth", "logout"], { env: cliEnv(p), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), STATUS_MS);
  const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  if (code !== 0) throw new svc.BotsError(`Bots no longer use ${p.name}, but Claude Code couldn't sign out: ${said(err) ?? `exit ${code}`}`, 500);
}

/** For tests: forget running sign-ins. */
export function resetFlows() {
  for (const flow of flows.values()) endFlow(flow, { status: "cancelled" });
  flows.clear();
}
