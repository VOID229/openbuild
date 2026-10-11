// The fetch_url tool: URL handling, HTML to text, and the hosted address guard. The network is faked.
import { afterEach, describe, expect, test } from "bun:test";
import { fetchPage, htmlToText, normalizeUrl, toolFor } from "../server/fetch";
import { searchToolkit } from "../server/search";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const page = (body: string, type = "text/html; charset=utf-8", status = 200) => new Response(body, { status, headers: { "content-type": type } });
const mock = (f: () => Promise<Response>) => {
  globalThis.fetch = f as unknown as typeof fetch;
};
const never = new AbortController().signal;

describe("normalizeUrl", () => {
  test("github file views become raw file links", () => {
    expect(normalizeUrl("https://github.com/owner/repo/blob/main/src/a.ts").toString()).toBe("https://raw.githubusercontent.com/owner/repo/main/src/a.ts");
    expect(normalizeUrl("https://github.com/owner/repo").toString()).toBe("https://github.com/owner/repo");
  });
});

describe("htmlToText", () => {
  test("keeps headings, links, lists and code; drops scripts and page chrome", () => {
    const text = htmlToText(`
      <html><head><style>p{color:red}</style><script>alert(1)</script></head>
      <body><nav>Menu</nav><h1>Title</h1><p>Read <a href="https://x.dev/docs">the docs</a> &amp; enjoy.</p>
      <ul><li>one</li><li>two</li></ul><pre><code>const a = 1;</code></pre><footer>Footer</footer></body></html>`);
    expect(text).toContain("# Title");
    expect(text).toContain("[the docs](https://x.dev/docs) & enjoy.");
    expect(text).toContain("- one");
    expect(text).toContain("const a = 1;");
    expect(text).not.toContain("alert");
    expect(text).not.toContain("Menu");
    expect(text).not.toContain("Footer");
  });
});

describe("fetchPage", () => {
  test("reads an HTML page as text", async () => {
    mock(async () => page("<h2>Hello</h2><p>World</p>"));
    const r = await fetchPage("https://example.com/a", never);
    expect(r.error).toBeUndefined();
    expect(r.text).toContain("## Hello");
    expect(r.text).toContain("World");
  });

  test("passes markdown and JSON through unchanged", async () => {
    mock(async () => page("# Readme\n\nText", "text/markdown"));
    expect((await fetchPage("https://example.com/r.md", never)).text).toBe("# Readme\n\nText");
    mock(async () => page('{"a":1}', "application/json"));
    expect((await fetchPage("https://api.example.com/x", never)).text).toBe('{"a":1}');
  });

  test("refuses binary content and HTTP errors with a readable message", async () => {
    mock(async () => page("%PDF", "application/pdf"));
    expect((await fetchPage("https://example.com/a.pdf", never)).error).toContain("content type");
    mock(async () => page("nope", "text/html", 404));
    expect((await fetchPage("https://example.com/missing", never)).error).toBe("The page returned HTTP 404.");
  });

  test("rejects non-http schemes and invalid URLs", async () => {
    expect((await fetchPage("file:///etc/passwd", never)).error).toContain("http");
    expect((await fetchPage("not a url", never)).error).toContain("valid URL");
  });

  test("hosted: blocks private addresses, including redirects into them", async () => {
    mock(async () => page("secret"));
    expect((await fetchPage("http://127.0.0.1/admin", never, { hosted: true })).error).toContain("public https");
    mock(async () => new Response(null, { status: 302, headers: { location: "https://10.0.0.5/x" } }));
    expect((await fetchPage("https://example.com/", never, { hosted: true })).error).toContain("public https");
  });

  test("local: allows any address", async () => {
    mock(async () => page("<p>lan</p>"));
    expect((await fetchPage("http://192.168.1.10/", never)).text).toBe("lan");
  });
});

describe("toolkit", () => {
  test("offers fetch_url with no search providers configured", () => {
    const kit = searchToolkit([]);
    expect(kit.specs.map((s) => s.name)).toEqual(["fetch_url"]);
    expect(kit.providerFor("fetch_url", JSON.stringify({ url: "https://example.com" }))).toBe("fetch");
    expect(kit.guidance).toContain("fetch_url");
    expect(kit.guidance).not.toContain("search the web with these tools");
  });

  test("runs fetch_url and reports the result as a fetch outcome", async () => {
    mock(async () => page("<p>Body</p>"));
    const out = await searchToolkit([]).run("fetch_url", JSON.stringify({ url: "https://example.com" }), never);
    expect(out.provider).toBe("fetch");
    expect(out.error).toBeUndefined();
    expect(out.text).toContain("Body");
    expect(out.links[0]?.url).toBe("https://example.com/");
  });
});

describe("GitHub", () => {
  test("routes GitHub hosts to the github tool and everything else to fetch", () => {
    expect(toolFor("https://github.com/a/b")).toBe("github");
    expect(toolFor("https://raw.githubusercontent.com/a/b/main/x.md")).toBe("github");
    expect(toolFor("https://api.github.com/repos/a/b")).toBe("github");
    expect(toolFor("https://example.com/github.com")).toBe("fetch");
    expect(toolFor("https://notgithub.com/x")).toBe("fetch");
  });

  test("sends the token to GitHub only, and not after a redirect off GitHub", async () => {
    const seen: Array<{ url: string; auth?: string }> = [];
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.push({ url: String(url), auth: headers.get("authorization") ?? undefined });
      return String(url).startsWith("https://api.github.com")
        ? new Response(null, { status: 302, headers: { location: "https://example.com/elsewhere" } })
        : page("<p>ok</p>");
    }) as unknown as typeof fetch;
    await fetchPage("https://api.github.com/repos/a/b", never, { githubToken: "tok" });
    await fetchPage("https://example.com/", never, { githubToken: "tok" });
    expect(seen[0]?.auth).toBe("Bearer tok");
    expect(seen[1]?.auth).toBeUndefined();
    expect(seen[2]?.auth).toBeUndefined();
  });
});
