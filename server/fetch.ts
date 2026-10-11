// The fetch_url tool: the model gives a URL and gets back the page as readable text. HTML is
// reduced to text (with links kept), GitHub file pages are rewritten to their raw contents, and
// JSON, Markdown and plain text pass through. Works without any search provider.
import type { ToolSpec } from "./search";
import { USER_AGENT } from "./opencode";

/** Hosted only: the relay must not reach private or local addresses on the server's network. */
export function isPublicUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || (!host.includes(".") && !host.includes(":"))) return false;
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224) return false;
  }
  if (host.includes(":") && (host === "::1" || host === "::" || /^f[cd]/.test(host) || host.startsWith("fe80") || host.startsWith("::ffff:"))) return false;
  return true;
}

export const FETCH_TOOL = "fetch_url";
const TIMEOUT = 20_000;
const MAX_BYTES = 2_000_000;
/** Characters of page text the model sees; the rest is cut off and the model is told so. */
const MAX_CHARS = 30_000;
const MAX_REDIRECTS = 5;

export const FETCH_SPEC: ToolSpec = {
  name: FETCH_TOOL,
  description:
    "Fetch a web page or file by URL and read its contents as text. HTML is converted to readable text with links kept. GitHub file and blob links return the raw file, and GitHub API URLs return JSON. " +
    "Use it when the user gives a URL, or when you need the contents of a specific page, such as docs, a README, a spec or a source file. Prefer it over search when you already know the URL.",
  parameters: {
    type: "object",
    properties: { url: { type: "string", description: "The full http(s) URL to read." } },
    required: ["url"],
  },
};

/** GitHub's own hosts: the only places a GitHub token is ever sent. */
export const isGithubHost = (host: string) => {
  const h = host.toLowerCase();
  return h === "github.com" || h.endsWith(".github.com") || h === "githubusercontent.com" || h.endsWith(".githubusercontent.com");
};

/** Which tool reads a URL: "github" for GitHub's hosts, otherwise "fetch". */
export function toolFor(raw: string): "fetch" | "github" {
  try {
    return isGithubHost(new URL(raw).hostname) ? "github" : "fetch";
  } catch {
    return "fetch";
  }
}

/** Rewrites github.com file views to raw.githubusercontent.com so the model gets the file itself. */
export function normalizeUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.hostname === "github.com" || url.hostname === "www.github.com") {
    const m = url.pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
    if (m) return new URL(`https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`);
  }
  return url;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

/** Reduces HTML to readable text: drops scripts, styles and page chrome, keeps headings, lists, code and links. */
export function htmlToText(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<(nav|footer|header|aside)\b[\s\S]*?<\/\1>/gi, "");
  s = s
    .replace(/<a\b[^>]*?href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, text: string) => {
      const label = text.replace(/<[^>]+>/g, "").trim();
      return label ? `[${label}](${href})` : "";
    })
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n: string, t: string) => `\n\n${"#".repeat(Number(n))} ${t.replace(/<[^>]+>/g, "").trim()}\n\n`)
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, c: string) => `\n\n\`\`\`\n${c.replace(/<[^>]+>/g, "")}\n\`\`\`\n\n`)
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|tr|table|ul|ol|blockquote|main)>/gi, "\n\n")
    .replace(/<(p|div|section|article|tr|table|ul|ol|blockquote|main)\b[^>]*>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const code = e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    });
  return s
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function readCapped(res: Response, signal: AbortSignal): Promise<{ text: string; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { text: "", truncated: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  while (true) {
    if (signal.aborted) throw signal.reason ?? new Error("Aborted");
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > MAX_BYTES) {
      chunks.push(value.subarray(0, MAX_BYTES - size));
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  return { text: new TextDecoder().decode(Buffer.concat(chunks)), truncated };
}

export interface FetchResult {
  url: string;
  text?: string;
  error?: string;
}

/** Fetches a URL and returns its readable text, or an error the model can read. */
export async function fetchPage(raw: string, signal: AbortSignal, opts: { hosted?: boolean; githubToken?: string } = {}): Promise<FetchResult> {
  let url: URL;
  try {
    url = normalizeUrl(raw.trim());
  } catch {
    return { url: raw, error: "Not a valid URL." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { url: raw, error: "Only http and https URLs can be fetched." };

  const timed = AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT)]);
  let res: Response | undefined;
  try {
    // Follow redirects by hand so each hop gets the same address check when hosted.
    for (let hop = 0; ; hop++) {
      if (opts.hosted && !isPublicUrl(url.toString())) return { url: url.toString(), error: "Only public https:// addresses can be fetched on the website." };
      // The token goes to GitHub's hosts only, checked on every hop, so a redirect can't leak it.
      const auth: Record<string, string> = opts.githubToken && isGithubHost(url.hostname) ? { authorization: `Bearer ${opts.githubToken}` } : {};
      res = await fetch(url, {
        redirect: "manual",
        signal: timed,
        headers: { "user-agent": USER_AGENT, accept: "text/markdown, text/html;q=0.9, application/json;q=0.8, text/plain;q=0.7, */*;q=0.1", ...auth },
      });
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        if (hop >= MAX_REDIRECTS) return { url: url.toString(), error: "Too many redirects." };
        url = new URL(location, url);
        await res.body?.cancel().catch(() => {});
        continue;
      }
      break;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return { url: url.toString(), error: `The page returned HTTP ${res.status}.` };
    }
    const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    const isText = type.startsWith("text/") || type === "" || /\/(json|xml|javascript|markdown)$/.test(type) || type.endsWith("+json") || type.endsWith("+xml");
    if (!isText) {
      await res.body?.cancel().catch(() => {});
      return { url: url.toString(), error: `Can't read this content type (${type}). Only text pages are supported.` };
    }
    const read = await readCapped(res, timed);
    const body = read.text;
    let truncated = read.truncated;
    let text = type === "text/html" || type === "application/xhtml+xml" || (type === "" && /<html[\s>]/i.test(body)) ? htmlToText(body) : body.trim();
    if (text.length > MAX_CHARS) {
      text = text.slice(0, MAX_CHARS).trimEnd();
      truncated = true;
    }
    if (truncated) text += "\n\n[Page cut off: it's too long to read in full.]";
    return { url: url.toString(), text: text || "(The page has no readable text.)" };
  } catch (err) {
    if (signal.aborted) throw err;
    const e = err as Error;
    if (e.name === "TimeoutError" || e.name === "AbortError") return { url: url.toString(), error: "The page didn't answer within 20 seconds." };
    return { url: url.toString(), error: `Couldn't fetch the page: ${e.message}` };
  }
}
