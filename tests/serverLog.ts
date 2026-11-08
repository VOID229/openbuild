// What a spawned test server printed, kept short and scrubbed so a startup failure can say why
// without a CI log ever holding a key or token. Lines are redacted as they arrive, then only the
// last few are kept: a secret cut by the bound can't survive as a fragment of an unredacted line.
const MAX_LINES = 60;
const MAX_LINE = 300;

export function redactLine(text: string): string {
  return text
    .replace(/\b(Bearer|Basic)\s+[\w.~+/=-]+/gi, "$1 [redacted]")
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|authorization|cookie)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, "$1[redacted]")
    .replace(/\b(?:sk|pk|rk|xai|gsk|ghp|gho|ghs|github_pat)[-_][\w-]{8,}/g, "[redacted]")
    .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[redacted]")
    .replace(/\b[0-9a-f]{32,}\b/gi, "[redacted]");
}

export function serverLog() {
  const lines: string[] = [];
  const push = (line: string) => {
    if (!line.trim()) return;
    const clean = redactLine(line);
    lines.push(clean.length > MAX_LINE ? `${clean.slice(0, MAX_LINE)}…` : clean);
    if (lines.length > MAX_LINES) lines.shift();
  };
  return {
    /** Read a child's output to its end. Always drained, so a chatty server never blocks on a full pipe. */
    async drain(stream: ReadableStream<Uint8Array> | undefined, label: string) {
      if (!stream) return;
      const dec = new TextDecoder();
      let buffer = "";
      try {
        for await (const chunk of stream) {
          buffer += dec.decode(chunk, { stream: true });
          let nl: number;
          while ((nl = buffer.indexOf("\n")) >= 0) {
            push(`${label}: ${buffer.slice(0, nl)}`);
            buffer = buffer.slice(nl + 1);
          }
          // A line that never ends is cut here, before it is redacted whole, so keep only its head.
          if (buffer.length > MAX_LINE * 4) buffer = buffer.slice(0, MAX_LINE * 4);
        }
      } catch {
        /* The child went away: whatever it printed is already kept. */
      }
      if (buffer) push(`${label}: ${buffer}`);
    },
    tail: () => (lines.length ? lines.join("\n") : "(the server printed nothing)"),
  };
}
