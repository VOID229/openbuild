// Runs a web (Request → Response) handler as a Vercel Node.js function, whose entry point gets
// Node's request and response.
import type { IncomingMessage, ServerResponse } from "node:http";

export function toNode(handler: (req: Request) => Promise<Response>) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const headers = new Headers();
    for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i]!, req.rawHeaders[i + 1]!);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    // Fires when the client goes away before the response is finished.
    const gone = new AbortController();
    res.on("close", () => !res.writableFinished && gone.abort());
    const request = new Request(`https://${req.headers.host ?? "localhost"}${req.url ?? "/"}`, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks),
      signal: gone.signal,
    });
    const response = await handler(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (!response.body) return void res.end();
    // Send the headers now: a reply's first event can take a while (the model thinking).
    res.flushHeaders();
    const reader = response.body.getReader();
    gone.signal.addEventListener("abort", () => void reader.cancel().catch(() => {}));
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } catch {}
    res.end();
  };
}
