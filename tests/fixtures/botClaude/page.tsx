// Settings → Bots → Claude, for tests/botClaudeUi.test.ts to drive in Chrome. The server is faked
// here: the default login is signed in, Claude (2) isn't, and only the code "good-code" works.
// `?installed=no` has no Claude Code on the server. Every request is kept in `window.calls`.
import "../../../src/styles.css";
import "../../../src/bots.css";
import "../../../src/mobile.css";
import { createRoot } from "react-dom/client";
import { BotClaude } from "../../../src/components/bots/BotClaude";

const params = new URLSearchParams(location.search);
const logins = [
  { id: "claude-code", name: "Claude", configDir: "~/.claude", signedIn: true, enabled: true, email: "me@example.com", plan: "max" },
  { id: "claude-code-2", name: "Claude (2)", configDir: "~/.claude-2", signedIn: false, enabled: true },
] as any[];
const calls: { path: string; body?: unknown }[] = ((window as any).calls = []);
const sign = { id: "flow-1", status: "waiting", url: "https://claude.com/cai/oauth/authorize?code=true&state=s", startedAt: Date.now() };
const login = (id: string) => logins.find((l) => l.id === id);
window.fetch = (async (input: string, init?: RequestInit) => {
  const path = String(input);
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  calls.push({ path, body });
  if (path === "/api/bots/claude") return Response.json({ logins, installed: params.get("installed") !== "no", userPackage: false });
  const [, id, action] = /^\/api\/bots\/claude\/([^/]+)\/(\w+)$/.exec(path) ?? [];
  const l = id && login(decodeURIComponent(id));
  if (!l) return Response.json({});
  if (action === "connect") {
    if (l.signedIn) return (l.enabled = true), Response.json({ signIn: null });
    return Response.json({ signIn: sign });
  }
  if (action === "code") {
    if (body.code !== "good-code") return Response.json({ signIn: { ...sign, status: "failed", url: undefined, error: "That code wasn't accepted." } });
    Object.assign(l, { signedIn: true, enabled: true, email: "two@example.com", plan: "pro" });
    return Response.json({ signIn: { ...sign, status: "connected", url: undefined } });
  }
  if (action === "disconnect") {
    l.enabled = false;
    if (body.signOut) l.signedIn = false;
    return Response.json({ ok: true });
  }
  return Response.json({ ok: true });
}) as typeof fetch;
document.documentElement.dataset.theme = params.get("theme") === "dark" ? "dark" : "light";

createRoot(document.getElementById("root")!).render(
  <div className="settings-page" style={{ padding: 16, maxWidth: 720 }}>
    <section className="pi-block">
      <BotClaude />
    </section>
  </div>,
);
