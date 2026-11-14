// The New project dialog on this device, for tests/newProject.test.ts to type a folder path in it
// in Chrome. The server is faked: /api/fs lists the folders below, /api/native/folder says the
// picker is there, and everything else is empty.
//   ?theme=light | dark    the app's theme (dark by default)
import "../../../src/styles.css";
import "../../../src/mobile.css";
import { createRoot } from "react-dom/client";
import { NewProjectDialog } from "../../../src/components/NewProject";

const params = new URLSearchParams(location.search);
const home = ["durable-extensions", "openbuild", "portfolio", "agent", "AppImages", "Atlas", "ci-imac", "cmake-4.4.4-linux-x86_64", "Desktop", "Documents", "Downloads", "go", "Music", "my-tools", "Pictures", "tools", "Videos"];
const git = new Set(["durable-extensions", "openbuild", "portfolio"]);
const folders: Record<string, string[]> = { "~": home, "~/": home, "~/openbuild/": ["bin", "docs", "server", "shared", "src", "tests"] };

(window as any).WebSocket = undefined;
window.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input), location.href);
  if (url.pathname === "/api/config") return Response.json({ mode: "local", convexUrl: null, serverId: "fixture", machine: "imac" });
  if (url.pathname === "/api/native/folder") return Response.json({ available: true });
  if (url.pathname === "/api/fs") {
    const dir = url.searchParams.get("dir") ?? "~";
    const names = folders[dir];
    if (!names) return Response.json({ error: "No such folder" }, { status: 404 });
    return Response.json({ dir, entries: names.map((name) => ({ name, path: `${dir.replace(/\/?$/, "/")}${name}`, git: git.has(name) })) });
  }
  return Response.json({});
}) as typeof fetch;

(window as any).dialogClosed = 0;
document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark";
createRoot(document.getElementById("root")!).render(<NewProjectDialog start={{}} onClose={() => (window as any).dialogClosed++} />);
