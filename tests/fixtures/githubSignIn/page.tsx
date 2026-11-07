// The GitHub app's page with its sign-in panel, for tests/githubSignInUi.test.ts to look at in Chrome.
// `?state=pending` shows a device sign-in under way; otherwise it's the panel before connecting.
import "../../../src/styles.css";
import "../../../src/bots.css";
import "../../../src/mobile.css";
import { createRoot } from "react-dom/client";
import { AppsDialog } from "../../../src/components/bots/BotApps";
import { useGithub } from "../../../src/lib/github";

const params = new URLSearchParams(location.search);
const pending = { status: "pending", userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device", expiresAt: Date.now() + 600_000 };
const replies: Record<string, unknown> = {
  "/api/bots/apps": { apps: [{ id: "github", status: "disconnected" }], clients: [], githubKey: false },
  "/api/github": { configured: true, mode: "off", legacy: false, hasPat: false },
};
window.fetch = (async (input: string) => {
  const path = String(input);
  return Response.json(path.startsWith("/api/github/device/") ? pending : (replies[path] ?? {}));
}) as typeof fetch;
if (params.get("state") === "pending") useGithub.setState({ device: { flowId: "flow", status: pending as never } });
document.documentElement.dataset.theme = params.get("theme") === "dark" ? "dark" : "light";
createRoot(document.getElementById("root")!).render(<AppsDialog initial="github" onClose={() => {}} />);
