/** Only existing streaming endpoints may travel over the browser's socket transport. */
export function streamPath(path: string, method: string): boolean {
  if (!path.startsWith("/api/") || path.includes("\\") || path.includes("#")) return false;
  const url = new URL(path, "http://stream.invalid");
  if (url.origin !== "http://stream.invalid") return false;
  const p = url.pathname.replace(/^\/api\/devices\/[^/]+(?=\/api\/)/, "");
  return method === "POST"
    ? p === "/api/chat" || p === "/api/pi/chat" || /^\/api\/pi\/threads\/[^/]+\/shell$/.test(p)
    : method === "GET" && (/^\/api\/chat\/runs\/[^/]+$/.test(p) || /^\/api\/pi\/shells\/[^/]+$/.test(p) || /^\/api\/terminals\/[^/]+$/.test(p) || p === "/api/pi/job" || /^\/api\/pi\/login\/[^/]+$/.test(p));
}
