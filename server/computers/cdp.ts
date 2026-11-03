// The Chrome DevTools Protocol over Chromium's --remote-debugging-pipe: NUL-terminated JSON
// messages on two file descriptors. The browser is started through `sh` so its fd 3 and fd 4 are
// this process's stdin and stdout, which works the same for a browser on this machine and one
// inside a container (`podman exec -i`). No debugging port is opened, so nothing else on the
// machine can drive a bot's browser and its logged-in sessions.
import type { Subprocess } from "bun";

type Listener = (method: string, params: any, sessionId?: string) => void;

export class CdpError extends Error {}

export class Cdp {
  private next = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private listeners = new Set<Listener>();
  private stderrTail: string[] = [];
  closed = false;

  constructor(private proc: Subprocess<"pipe", "pipe", "pipe">) {
    void this.read();
    void this.readStderr();
    void proc.exited.then((code) => this.close(`The browser exited (code ${code})${this.stderrTail.length ? `: ${this.stderrTail.slice(-3).join(" / ")}` : ""}`));
  }

  private async read() {
    const dec = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of this.proc.stdout) {
        buf += dec.decode(chunk, { stream: true });
        let end: number;
        while ((end = buf.indexOf("\0")) >= 0) {
          const raw = buf.slice(0, end);
          buf = buf.slice(end + 1);
          let msg: any;
          try {
            msg = JSON.parse(raw);
          } catch {
            continue;
          }
          if (typeof msg.id === "number") {
            const p = this.pending.get(msg.id);
            if (!p) continue;
            this.pending.delete(msg.id);
            clearTimeout(p.timer);
            if (msg.error) p.reject(new CdpError(msg.error.message ?? "DevTools error"));
            else p.resolve(msg.result ?? {});
          } else if (typeof msg.method === "string") {
            for (const l of this.listeners) {
              try {
                l(msg.method, msg.params ?? {}, msg.sessionId);
              } catch {}
            }
          }
        }
      }
    } catch {}
    this.close("The browser closed its connection");
  }

  private async readStderr() {
    const dec = new TextDecoder();
    try {
      for await (const chunk of this.proc.stderr) {
        for (const line of dec.decode(chunk).split("\n")) {
          const t = line.trim();
          // Chromium's own log lines ("[pid:tid:time:LEVEL:file]") are noise unless they're errors.
          if (!t || (t.startsWith("[") && !/:(ERROR|FATAL):/.test(t))) continue;
          this.stderrTail.push(t.slice(0, 300));
          if (this.stderrTail.length > 20) this.stderrTail.shift();
        }
      }
    } catch {}
  }

  private close(reason: string) {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new CdpError(reason));
    }
    this.pending.clear();
    for (const l of this.listeners) {
      try {
        l("Openbots.closed", { reason });
      } catch {}
    }
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 30_000): Promise<T> {
    if (this.closed) return Promise.reject(new CdpError("The browser isn't running"));
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`The browser didn't answer ${method} in time`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.proc.stdin.write(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }) + "\0");
        this.proc.stdin.flush();
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new CdpError((err as Error).message));
      }
    });
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Resolve with the first matching event, or undefined after `timeoutMs`. */
  waitFor(method: string, match: (params: any, sessionId?: string) => boolean, timeoutMs: number): Promise<any | undefined> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        off();
        resolve(undefined);
      }, timeoutMs);
      const off = this.on((m, p, s) => {
        if ((m === method && match(p, s)) || m === "Openbots.closed") {
          clearTimeout(timer);
          off();
          resolve(m === method ? p : undefined);
        }
      });
    });
  }

  kill() {
    try {
      this.proc.stdin.end();
    } catch {}
    this.proc.kill("SIGTERM");
    setTimeout(() => !this.closed && this.proc.kill("SIGKILL"), 2000).unref?.();
  }
}
