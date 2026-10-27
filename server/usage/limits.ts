// Plan limits, asked of each provider with the sign-in its CLI saved on this machine: the same
// requests the CLIs make for their own usage screens. Nothing here refreshes or rewrites a sign-in;
// an expired one is reported, and the CLI renews it the next time it runs.
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { agentDir } from "../pi/install";
import { USAGE_PROVIDER_NAMES, type UsageLimits, type UsageProvider, type UsageWindow } from "../../shared/usage";

const home = () => process.env.HOME || homedir();
const tilde = (p: string) => resolve(p.replace(/^~(?=\/|$)/, home()));
const TIMEOUT_MS = 8000;

class Missing extends Error {}

type Reading = Omit<UsageLimits, "provider" | "asOf" | "id"> & { asOf?: number };

/** `/home/me/.claude-2` → `~/.claude-2`. */
const tildePath = (p: string) => (p.startsWith(home() + "/") ? `~${p.slice(home().length)}` : p);

async function readJson(path: string): Promise<any> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new Missing();
  }
  return JSON.parse(text);
}

async function getJson(url: string, init: RequestInit, who: string): Promise<any> {
  const res = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status === 401 || res.status === 403) throw new Error(`${who} turned down the saved sign-in. Run ${who === "Cursor" ? "cursor-agent" : who.toLowerCase()} to sign in again.`);
  if (!res.ok) throw new Error(`${who} answered HTTP ${res.status}.`);
  return res.json();
}

const pct = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : undefined);
const epoch = (v: unknown) => {
  const t = typeof v === "number" ? (v < 1e12 ? v * 1000 : v) : typeof v === "string" ? (/^\d+$/.test(v) ? Number(v) : Date.parse(v)) : NaN;
  return Number.isFinite(t) && t > 0 ? t : undefined;
};
const kindOf = (mins: number | undefined): UsageWindow["kind"] =>
  mins === undefined ? "other" : mins >= 27 * 1440 ? "monthly" : mins >= 6 * 1440 ? "weekly" : "session";
const LABEL = { session: "Session", weekly: "Weekly", monthly: "Monthly", other: "Usage" } as const;

// ------------------------------------------------------------------ Claude Code

const CLAUDE_WINDOWS: [key: string, label: string, mins: number][] = [
  ["five_hour", "Session", 300],
  ["seven_day", "Weekly", 10080],
  ["seven_day_opus", "Weekly · Opus", 10080],
  ["seven_day_sonnet", "Weekly · Sonnet", 10080],
];

/** Claude Code config dirs: the default, CLAUDE_CONFIG_DIR, and siblings like ~/.claude-2 (one per account). */
export async function claudeDirs(): Promise<string[]> {
  const dirs = [join(home(), ".claude")];
  if (process.env.CLAUDE_CONFIG_DIR) dirs.push(tilde(process.env.CLAUDE_CONFIG_DIR));
  dirs.push(...(await siblings(/^\.claude[-_.].+/)));
  return [...new Set(dirs)];
}

/** Dot-directories in the home folder matching `re` (other accounts' config dirs). */
async function siblings(re: RegExp): Promise<string[]> {
  try {
    const entries = await readdir(home(), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && re.test(e.name)).map((e) => join(home(), e.name)).sort();
  } catch {
    return [];
  }
}

/** `~/.claude-2` → "2"; the default dir has no tag. */
const dirTag = (dir: string, base: string) => {
  const name = dir.slice(dir.lastIndexOf("/") + 1);
  return name === base ? undefined : name.replace(new RegExp(`^${base.replace(".", "\\.")}[-_.]?`), "") || name;
};

async function claudeAccounts(): Promise<Account[]> {
  const out: Account[] = [];
  for (const dir of await claudeDirs()) {
    let creds: any;
    try {
      creds = (await readJson(join(dir, ".credentials.json"))).claudeAiOauth;
    } catch {
      continue;
    }
    if (!creds?.accessToken) continue;
    // The account id Claude Code keeps beside the sign-in (in ~/.claude.json for the default dir).
    let id: string | undefined;
    for (const f of [join(dir, ".claude.json"), ...(dir === join(home(), ".claude") ? [join(home(), ".claude.json")] : [])]) {
      id ??= await readJson(f).then((j) => j?.oauthAccount?.accountUuid, () => undefined);
    }
    out.push({ key: id ?? `token:${Bun.hash(creds.refreshToken ?? creds.accessToken).toString(36)}`, tag: dirTag(dir, ".claude"), source: tildePath(dir), read: () => claudeLimits(creds) });
  }
  return out;
}

async function claudeLimits(creds: any): Promise<Reading> {
  const plan = typeof creds.subscriptionType === "string" ? creds.subscriptionType : undefined;
  if (typeof creds.expiresAt === "number" && creds.expiresAt < Date.now())
    return { plan, windows: [], error: "The sign-in has expired. Run Claude Code with this config once to renew it." };
  const body = await getJson("https://api.anthropic.com/api/oauth/usage", {
    headers: { authorization: `Bearer ${creds.accessToken}`, "anthropic-beta": "oauth-2025-04-20" },
  }, "Claude");
  const windows: UsageWindow[] = [];
  for (const [key, label, mins] of CLAUDE_WINDOWS) {
    const w = body[key];
    const used = pct(w?.utilization);
    if (used === undefined) continue;
    windows.push({ id: key, label, kind: kindOf(mins), usedPercent: used, resetsAt: epoch(w.resets_at), windowMins: mins });
  }
  const extra = body.extra_usage;
  if (extra?.is_enabled) {
    const scale = 10 ** (typeof extra.decimal_places === "number" ? extra.decimal_places : 2);
    const used = typeof extra.used_credits === "number" ? extra.used_credits / scale : undefined;
    const limit = typeof extra.monthly_limit === "number" ? extra.monthly_limit / scale : undefined;
    const percent = pct(extra.utilization) ?? (used !== undefined && limit ? (used / limit) * 100 : undefined);
    if (percent !== undefined) windows.push({ id: "extra_usage", label: "Extra usage", kind: "monthly", usedPercent: pct(percent)!, usedUsd: used, limitUsd: limit });
  }
  return { plan, windows };
}

// ------------------------------------------------------------------ Codex

const codexHome = () => (process.env.CODEX_HOME ? tilde(process.env.CODEX_HOME) : join(home(), ".codex"));

function codexWindow(id: string, w: any, fallbackMins: number): UsageWindow | undefined {
  const used = pct(w?.used_percent);
  if (used === undefined) return;
  const secs = w.limit_window_seconds ?? (typeof w.window_minutes === "number" ? w.window_minutes * 60 : undefined);
  const mins = typeof secs === "number" ? Math.round(secs / 60) : fallbackMins;
  const kind = kindOf(mins);
  return { id, label: LABEL[kind], kind, usedPercent: used, resetsAt: epoch(w.reset_at ?? w.resets_at), windowMins: mins };
}

/** Codex homes: ~/.codex, CODEX_HOME, and siblings like ~/.codex-2. */
export async function codexHomes(): Promise<string[]> {
  return [...new Set([codexHome(), join(home(), ".codex"), ...(await siblings(/^\.codex[-_.].+/))])];
}

async function codexAccounts(): Promise<Account[]> {
  const out: Account[] = [];
  for (const dir of await codexHomes()) {
    const tokens = await readJson(join(dir, "auth.json")).then((a) => a?.tokens, () => undefined);
    // An API key alone is billed per token: no plan, no limits.
    if (!tokens?.access_token) continue;
    out.push({
      key: tokens.account_id ? `acct:${tokens.account_id}` : `token:${Bun.hash(tokens.access_token).toString(36)}`,
      tag: dirTag(dir, ".codex"),
      source: tildePath(dir),
      read: () => codexLimits(tokens.access_token, tokens.account_id, dir),
    });
  }
  // ChatGPT sign-ins Pi keeps itself (openai-codex, and openai-codex-2… from pi-codex-multi).
  const pi = await readJson(join(agentDir(), "auth.json")).catch(() => ({}));
  for (const [provider, cred] of Object.entries<any>(pi ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (!/^openai-codex(-.+)?$/.test(provider) || cred?.type !== "oauth" || !cred.access) continue;
    out.push({
      key: cred.accountId ? `acct:${cred.accountId}` : `token:${Bun.hash(cred.access).toString(36)}`,
      tag: provider.replace(/^openai-codex-?/, "") || undefined,
      source: `Pi · ${provider}`,
      read: () =>
        typeof cred.expires === "number" && cred.expires < Date.now()
          ? Promise.resolve({ windows: [], error: `Pi's ${provider} sign-in has expired. Use it in Pi once to renew it.` })
          : codexLimits(cred.access, cred.accountId),
    });
  }
  return out;
}

async function codexLimits(token: string, accountId: string | undefined, dir?: string): Promise<Reading> {
  try {
    const body = await getJson("https://chatgpt.com/backend-api/wham/usage", {
      headers: { authorization: `Bearer ${token}`, ...(accountId ? { "chatgpt-account-id": accountId } : {}) },
    }, "Codex");
    const rl = body.rate_limit ?? {};
    const monthly = body.plan_type === "free" || body.plan_type === "go";
    const windows = [codexWindow("primary", rl.primary_window, monthly ? 43200 : 300), codexWindow("secondary", rl.secondary_window, 10080)].filter((w): w is UsageWindow => !!w);
    const credits = body.rate_limit_reset_credits?.available_count;
    return { plan: body.plan_type ?? undefined, windows, ...(typeof credits === "number" && credits > 0 ? { resetCredits: credits } : {}) };
  } catch (err) {
    // Offline or signed out: what the CLI's last session recorded, marked as such.
    const snap = dir ? await codexSnapshot(dir).catch(() => undefined) : undefined;
    if (snap) return { ...snap, stale: true, error: (err as Error).message };
    throw err;
  }
}

/** The rate limits in the newest Codex transcript. */
async function codexSnapshot(dir: string): Promise<Reading | undefined> {
  const root = join(dir, "sessions");
  const names = (await readdir(root, { recursive: true })).filter((n) => /\.jsonl(\.zst)?$/.test(n));
  const dated = await Promise.all(names.map(async (n) => ({ path: join(root, n), m: (await stat(join(root, n))).mtimeMs })));
  const newest = dated.sort((a, b) => b.m - a.m)[0];
  if (!newest) return;
  const raw = await Bun.file(newest.path).bytes();
  const bytes: Uint8Array = newest.path.endsWith(".zst") ? Bun.zstdDecompressSync(raw) : raw;
  const lines = new TextDecoder().decode(bytes).split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]!.includes('"rate_limits"')) continue;
    try {
      const e = JSON.parse(lines[i]!);
      const rl = e.payload?.rate_limits;
      if (!rl || (rl.limit_id && rl.limit_id !== "codex")) continue;
      const windows = [codexWindow("primary", rl.primary, 300), codexWindow("secondary", rl.secondary, 10080)].filter((w): w is UsageWindow => !!w);
      return { plan: rl.plan_type ?? undefined, windows, asOf: Date.parse(e.timestamp) || newest.m };
    } catch {}
  }
}

// ------------------------------------------------------------------ Grok

/** The grok.com sign-in; never another deployment's from the same file. */
const GROK_ACCOUNTS = ["https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828", "https://accounts.x.ai/sign-in"];

async function grokLimits(): Promise<Reading> {
  const dir = process.env.GROK_HOME ? tilde(process.env.GROK_HOME) : join(home(), ".grok");
  const auth = await readJson(join(dir, "auth.json"));
  const cred = GROK_ACCOUNTS.map((k) => auth?.[k]).find(Boolean);
  if (!cred?.key || cred.auth_mode === "api_key") throw new Missing();
  const body = await getJson("https://cli-chat-proxy.grok.com/v1/billing?format=credits", { headers: { authorization: `Bearer ${cred.key}` } }, "Grok");
  const period = body.config?.currentPeriod;
  const type = String(period?.type ?? "").replace(/^USAGE_PERIOD_TYPE_/, "");
  const kind: UsageWindow["kind"] = type === "WEEKLY" ? "weekly" : type === "MONTHLY" ? "monthly" : "other";
  // A period with no use leaves the percentage out.
  const used = pct(body.config?.creditUsagePercent) ?? (period?.end ? 0 : undefined);
  if (used === undefined) return { windows: [] };
  return { windows: [{ id: "credits", label: LABEL[kind], kind, usedPercent: used, resetsAt: epoch(period?.end), windowMins: kind === "weekly" ? 10080 : undefined }] };
}

// ------------------------------------------------------------------ Cursor

/** Where cursor-agent keeps its sign-in (on a Mac it's in the Keychain, which isn't read). */
export function cursorAuthPath() {
  if (process.platform === "darwin") return join(home(), ".cursor", "auth.json");
  return join(process.env.XDG_CONFIG_HOME ? tilde(process.env.XDG_CONFIG_HOME) : join(home(), ".config"), "cursor", "auth.json");
}

export async function cursorToken(): Promise<string> {
  const token = (await readJson(cursorAuthPath()))?.accessToken;
  if (typeof token !== "string" || !token) throw new Missing();
  return token;
}

const CURSOR_WINDOWS = [
  ["totalPercentUsed", "Overall"],
  ["autoPercentUsed", "Auto + Composer"],
  ["apiPercentUsed", "API models"],
] as const;

async function cursorLimits(): Promise<Reading> {
  const token = await cursorToken();
  const body = await getJson("https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "connect-protocol-version": "1", "x-cursor-client-type": "cli", "content-type": "application/json" },
    body: "{}",
  }, "Cursor");
  const start = epoch(body.billingCycleStart);
  const end = epoch(body.billingCycleEnd);
  const mins = start && end ? Math.round((end - start) / 60_000) : undefined;
  const kind = kindOf(mins);
  const windows: UsageWindow[] = [];
  for (const [key, label] of CURSOR_WINDOWS) {
    const used = pct(body.planUsage?.[key]);
    if (used !== undefined) windows.push({ id: key, label, kind, usedPercent: used, resetsAt: end, windowMins: mins });
  }
  return { windows };
}

// ------------------------------------------------------------------ all of them

interface Account {
  /** Identifies the account, so the same one signed in twice (the CLI and Pi) shows once. */
  key: string;
  /** Tells accounts of one provider apart ("2"). */
  tag?: string;
  /** Where the sign-in was read from. */
  source?: string;
  read: () => Promise<Reading>;
}

const one = (source: string, read: () => Promise<Reading>) => async (): Promise<Account[]> => [{ key: source, read }];

const PROVIDERS: [UsageProvider, () => Promise<Account[]>][] = [
  ["claude", claudeAccounts],
  ["codex", codexAccounts],
  ["grok", one("grok", grokLimits)],
  ["cursor", one("cursor", cursorLimits)],
];

/** Fresh enough to reuse; Refresh asks again once this has passed. */
const TTL_MS = 60_000;
const MIN_REFRESH_MS = 10_000;
const cache = new Map<UsageProvider, { at: number; value: Promise<UsageLimits[]> }>();

async function readAccounts(provider: UsageProvider, list: () => Promise<Account[]>): Promise<UsageLimits[]> {
  const seen = new Set<string>();
  const accounts = (await list()).filter((a) => !seen.has(a.key) && seen.add(a.key));
  const id = (a: Account) => `${provider}:${a.key}`;
  const results = await Promise.all(accounts.map((a) => a.read().then(
    (r): UsageLimits => ({ provider, id: id(a), asOf: Date.now(), ...r }),
    (err): UsageLimits | undefined => {
      if (err instanceof Missing) return undefined;
      const message = err?.name === "TimeoutError" ? `${USAGE_PROVIDER_NAMES[provider]} didn't answer in time.` : (err as Error).message;
      return { provider, id: id(a), asOf: Date.now(), windows: [], error: message };
    },
  ).then((r) => r && { ...r, ...(accounts.length > 1 ? { account: a.tag ?? "1" } : {}), source: a.source })));
  return results.filter((r): r is NonNullable<typeof r> => !!r);
}

/** Limits for each account signed in on this machine. */
export async function limits(force = false): Promise<UsageLimits[]> {
  const now = Date.now();
  const all = await Promise.all(PROVIDERS.map(([provider, list]) => {
    const hit = cache.get(provider);
    if (hit && now - hit.at < (force ? MIN_REFRESH_MS : TTL_MS)) return hit.value;
    const value = readAccounts(provider, list);
    cache.set(provider, { at: now, value });
    return value;
  }));
  return all.flat();
}
