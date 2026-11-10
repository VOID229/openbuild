// The GitHub app's page with its sign-in panel, for tests/githubSignInUi.test.ts to look at in Chrome.
// `?state=pending` shows a device sign-in under way; `?state=connected` the app signed in and
// connected, whose Save leaves the page (`?save=fail` makes it fail); otherwise it's the panel
// before connecting. `?clipboard=fail` makes copying fail.
import "../../../src/styles.css";
import "../../../src/bots.css";
import "../../../src/mobile.css";
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { AppPage } from "../../../src/components/bots/BotApps";
import { appById } from "../../../shared/apps";
import { useWorkspace } from "../../../src/lib/bots/workspace";
import { useGithub } from "../../../src/lib/github";

const params = new URLSearchParams(location.search);
const state = params.get("state");
const pending = { status: "pending", userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device", expiresAt: Date.now() + 600_000 };
const connected = state === "connected";
const apps = "/api/workspace/to/local/api/bots/apps";
const replies: Record<string, unknown> = {
  [apps]: { apps: [connected ? { id: "github", status: "connected", fields: { access: "read" } } : { id: "github", status: "disconnected" }], clients: [], githubKey: false },
  "/api/github": connected ? { configured: true, mode: "app", legacy: false, hasPat: false, app: { login: "octo", userId: 1, signedOut: false } } : { configured: true, mode: "off", legacy: false, hasPat: false },
  "/api/github/installations": { installations: [] },
};
window.fetch = (async (input: string, init?: RequestInit) => {
  const path = String(input);
  if (path === `${apps}/github/connect` && init?.method === "POST") {
    (window as any).saved = JSON.parse(String(init.body));
    return params.get("save") === "fail" ? Response.json({ error: "GitHub didn't answer." }, { status: 502 }) : Response.json({});
  }
  return Response.json(path.startsWith("/api/github/device/") ? pending : (replies[path] ?? {}));
}) as typeof fetch;
if (params.get("clipboard") === "fail") {
  Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.reject(new Error("denied")) } });
  document.execCommand = () => false;
}
useWorkspace.setState({ localId: "local" });
if (state === "pending") useGithub.setState({ device: { flowId: "flow", status: pending as never } });
document.documentElement.dataset.theme = params.get("theme") === "dark" ? "dark" : "light";

function Page() {
  const [open, setOpen] = useState(true);
  return open ? <AppPage app={appById("github")!} onDone={() => setOpen(false)} /> : <p id="closed">Closed</p>;
}
createRoot(document.getElementById("root")!).render(<Page />);
