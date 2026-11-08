// A fake OpenBuild server for the composer's page, imported before anything that asks it.
(window as any).WebSocket = undefined;
window.fetch = (async (input: RequestInfo | URL) => {
  const path = new URL(String(input), location.href).pathname;
  if (path === "/api/config") return Response.json({ mode: "local", convexUrl: null, serverId: "fixture", machine: "imac" });
  return Response.json({});
}) as typeof fetch;

export {};
