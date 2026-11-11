// A fake OpenBuild server for the composer's page, imported before anything that asks it.
(window as any).WebSocket = undefined;
// The machine's Codex daemon, whose Remote Control Settings → General switches. Each POST is kept in `codexPosts`.
const daemon = { installed: true, status: "running", version: "0.163.0", remoteControl: false, checkedAt: 0 };
(window as any).codexPosts = [];
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = new URL(String(input), location.href).pathname;
  if (path === "/api/config") return Response.json({ mode: "local", convexUrl: null, serverId: "fixture", machine: "imac" });
  if (path === "/api/codex/status/remote-control") {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      (window as any).codexPosts.push(body);
      daemon.remoteControl = body.enabled;
    }
    return Response.json(daemon);
  }
  return Response.json({});
}) as typeof fetch;

export {};
