import { createHash, randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./paths";

const COOKIE = "openbuild_session";
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const MAX_SESSIONS = 1000;
const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 10;
const MAX_BODY = 4096;

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  const result = new Headers(headers);
  result.set("Content-Type", "application/json");
  result.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(value), { status, headers: result });
}

function tokenKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function requestToken(req: Request): string | undefined {
  const matches = (req.headers.get("cookie") ?? "").split(";")
    .map((part) => part.trim()).filter((part) => part.startsWith(`${COOKIE}=`));
  // Reject ambiguous cookies rather than choosing between different paths/domains.
  if (matches.length !== 1) return;
  const token = matches[0]!.slice(COOKIE.length + 1);
  return /^[a-f0-9]{64}$/.test(token) ? token : undefined;
}

function cookie(req: Request, token: string, maxAge: number): string {
  return `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${new URL(req.url).protocol === "https:" ? "; Secure" : ""}`;
}

async function passwordBody(req: Request): Promise<string> {
  const length = req.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY)) {
    void req.body?.cancel().catch(() => {});
    throw new Error("Invalid body size");
  }
  if (!req.body) throw new Error("Missing body");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) {
        void reader.cancel().catch(() => {});
        throw new Error("Body too large");
      }
      if (value.byteLength) chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!value || typeof value.password !== "string" || value.password.length < 1 || value.password.length > 1024) {
    throw new Error("Invalid password");
  }
  return value.password;
}

export function createLocalAuth(options: { directory?: string; now?: () => number } = {}) {
  const directory = options.directory ?? dataDir();
  const file = join(directory, "access.json");
  const now = options.now ?? Date.now;
  const sessions = new Map<string, number>();
  let knownHash: string | undefined;
  let attempts: number[] = [];
  let verifying = 0;

  // Read on every request: another process may replace or remove the credential.
  // Errors and malformed files fail closed and revoke all existing sessions.
  function refresh(): string | undefined {
    let hash: string | undefined;
    try {
      if (statSync(file).size > 16_384) throw new Error("Invalid credential file");
      const value = JSON.parse(readFileSync(file, "utf8"));
      if (typeof value?.hash === "string" && value.hash.startsWith("$argon2id$")) hash = value.hash;
    } catch { /* Unconfigured, including unreadable files. */ }
    if (hash !== knownHash) {
      sessions.clear();
      knownHash = hash;
    }
    return hash;
  }

  function prune(): void {
    const time = now();
    for (const [key, expires] of sessions) if (expires <= time) sessions.delete(key);
  }

  function authenticated(req: Request): boolean {
    if (!refresh()) return false;
    prune();
    const token = requestToken(req);
    return token !== undefined && sessions.has(tokenKey(token));
  }

  return {
    configured(): boolean {
      return refresh() !== undefined;
    },

    async setPassword(password: string): Promise<void> {
      if (typeof password !== "string" || password.length < 12 || password.length > 1024) {
        throw new Error("Password must contain 12–1024 characters");
      }
      const hash = await Bun.password.hash(password, { algorithm: "argon2id" });
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const temporary = `${file}.${randomBytes(16).toString("hex")}.tmp`;
      let fd: number | undefined;
      try {
        fd = openSync(temporary, "wx", 0o600);
        writeFileSync(fd, JSON.stringify({ hash }) + "\n");
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        renameSync(temporary, file);
      } finally {
        if (fd !== undefined) closeSync(fd);
        try { unlinkSync(temporary); } catch { /* Renamed or never created. */ }
      }
      sessions.clear();
      knownHash = hash;
    },

    authorize(req: Request): Response | undefined {
      if (!authenticated(req)) return json({ error: "Unauthorized" }, 401);
    },

    status(req: Request): Response {
      const authenticatedSession = authenticated(req);
      return json({ configured: knownHash !== undefined, authenticated: authenticatedSession });
    },

    async login(req: Request): Promise<Response> {
      const hash = refresh();
      if (!hash) return json({ error: "Password not configured" }, 503);
      const time = now();
      // Instance-wide rather than IP-based: forwarded/client IPs are not trusted.
      attempts = attempts.filter((attempt) => attempt > time - WINDOW_MS);
      if (attempts.length >= MAX_ATTEMPTS) {
        return json({ error: "Too many attempts" }, 429, {
          "Retry-After": String(Math.max(1, Math.ceil((attempts[0]! + WINDOW_MS - time) / 1000))),
        });
      }
      attempts.push(time);
      let password: string;
      try { password = await passwordBody(req); }
      catch { return json({ error: "Invalid login body" }, 400); }
      if (verifying >= 2) return json({ error: "Login busy" }, 429, { "Retry-After": "1" });
      verifying++;
      let valid = false;
      try { valid = await Bun.password.verify(password, hash); }
      catch { /* Invalid hash or verification failure: never authenticate. */ }
      finally { verifying--; }
      // Do not issue a session for a password replaced while verification ran.
      if (!valid || refresh() !== hash) return json({ error: "Invalid credentials" }, 401);
      prune();
      if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
      const token = randomBytes(32).toString("hex");
      sessions.set(tokenKey(token), now() + SESSION_SECONDS * 1000);
      return json({ authenticated: true }, 200, { "Set-Cookie": cookie(req, token, SESSION_SECONDS) });
    },

    logout(req: Request): Response {
      refresh();
      const token = requestToken(req);
      if (token) sessions.delete(tokenKey(token));
      return json({ authenticated: false }, 200, { "Set-Cookie": cookie(req, "", 0) });
    },
  };
}

export const localAuth = createLocalAuth();
