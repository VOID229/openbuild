// A fake OpenBuild server for the startup popup's page: imported before anything that asks it, so
// /api/config, /api/runtimes and Pi's install answer from here and nothing is ever installed.
//   ?case=none | hermes | codex | installed | error   what /api/runtimes finds (error answers HTTP 500)
//   &install=ok | fail-then-ok                         how Install's job ends
// `window.calls` counts each path asked, for the test to read.
const params = new URLSearchParams(location.search);
const RUNTIMES = ["pi", "durable", "claude", "codex", "cursor", "fx", "opencode", "hermes", "grok"];
const found: Record<string, string[]> = { none: [], hermes: ["hermes"], codex: ["codex", "claude"], installed: ["pi", "durable"] };
let installed = found[params.get("case") ?? "none"] ?? [];
let attempts = 0;
const calls: Record<string, number> = ((window as any).calls = {});

const runtimes = () => ({ runtimes: Object.fromEntries(RUNTIMES.map((r) => [r, { installed: installed.includes(r), install: r === "pi" || r === "durable" ? "curl -fsSL https://pi.dev/install.sh | sh" : `install ${r}` }])) });

/** Pi's installer as the job stream tells it: a few lines, then its exit code. */
function job(code: number): Response {
  const lines = ["Downloading Pi…", "Installing to ~/.local/bin/pi", ...(code ? ["curl: (6) Could not resolve host: pi.dev"] : ["Pi 1.9.0 installed."])];
  const body = [...lines.map((line) => JSON.stringify({ line })), JSON.stringify({ done: true, code, title: "Installing Pi" })].join("\n") + "\n";
  return new Response(body, { headers: { "content-type": "application/x-ndjson" } });
}

// The job stream would go over /api/stream's socket; this page has none, so it falls back to fetch.
(window as any).WebSocket = undefined;
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = new URL(String(input), location.href).pathname;
  calls[path] = (calls[path] ?? 0) + 1;
  // Slow enough for the progress state to be seen.
  await new Promise((r) => setTimeout(r, path === "/api/pi/job" ? 300 : 20));
  if (path === "/api/config") return Response.json({ mode: "local", convexUrl: null, serverId: "fixture", machine: "imac" });
  if (path === "/api/runtimes") return params.get("case") === "error" ? Response.json({ error: "boom" }, { status: 500 }) : Response.json(runtimes());
  if (path === "/api/pi/install" && init?.method === "POST") return Response.json({ job: `job-${++attempts}` });
  if (path === "/api/pi/job") {
    const ok = params.get("install") === "ok" || attempts > 1;
    if (ok) installed = [...installed, "pi", "durable"];
    return job(ok ? 0 : 1);
  }
  return Response.json({});
}) as typeof fetch;

export {};
