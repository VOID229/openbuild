// Web search tools. Each configured provider becomes its own tool, with a description that
// tells the model what that provider is good at, so it can pick the right one per query.
import { SEARCH_PROVIDERS, type SearchCheckResult, type SearchCredentials, type SearchProviderId, type SearchResultLink } from "../shared/types";
import { USER_AGENT } from "./opencode";

type Json = Record<string, unknown>;

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments (kept to the subset every protocol, Gemini included, accepts). */
  parameters: Json;
}

export interface SearchOutcome {
  provider: SearchProviderId;
  query: string;
  /** What the model sees. */
  text: string;
  /** What the UI shows. */
  links: SearchResultLink[];
  error?: string;
}

type Recency = "day" | "week" | "month" | "year";
type Args = Record<string, unknown>;

interface Result {
  title: string;
  url: string;
  published?: string;
  content?: string;
}

interface Provider {
  /** Rough cost/speed rank: lower is cheaper and faster. */
  cost: number;
  description: string;
  properties: Json;
  /** Per-call timeout. */
  timeout: number;
  /** Max characters of each result's content passed to the model. */
  perResult: number;
  run(credential: string, query: string, args: Args, signal: AbortSignal): Promise<{ results: Result[]; answer?: string }>;
}

class SearchError extends Error {
  constructor(
    message: string,
    /** Whether the next key/instance should be tried. */
    readonly fallback: boolean,
  ) {
    super(message);
  }
}

const query = { type: "string", description: "The search query." };
const recency = (what = "Only return results published within this period.") => ({ type: "string", enum: ["day", "week", "month", "year"], description: what });
const count = (max: number, def: number) => ({ type: "integer", description: `Number of results (1-${max}, default ${def}).` });

const clampInt = (v: unknown, min: number, max: number, def: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};
const pick = <T extends string>(v: unknown, options: readonly T[]): T | undefined => (options.includes(v as T) ? (v as T) : undefined);
const RECENCY = ["day", "week", "month", "year"] as const;
const stripTags = (s: unknown) =>
  typeof s === "string"
    ? s
        .replace(/<[^>]+>/g, "")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .trim()
    : undefined;

function sinceDate(r: Recency | undefined) {
  if (!r) return undefined;
  const days = { day: 1, week: 7, month: 31, year: 366 }[r];
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

async function call(url: string, init: RequestInit, label: string): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers: { "user-agent": USER_AGENT, accept: "application/json", ...init.headers } });
  } catch (err) {
    if ((err as Error).name === "AbortError" || (err as Error).name === "TimeoutError") throw err;
    throw new SearchError(`Couldn't reach ${label}: ${(err as Error).message}`, true);
  }
  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  if (!res.ok) {
    const detail =
      body?.error?.message ?? body?.error?.[0]?.msg ?? body?.errors?.[0]?.message ?? (typeof body?.error === "string" ? body.error : undefined) ?? body?.detail?.error ?? body?.detail ?? body?.message;
    const message = `${label} returned HTTP ${res.status}${detail ? `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`;
    // Rejected, out of credit, or rate limited: worth trying the next key.
    throw new SearchError(message, [401, 402, 403, 429].includes(res.status) || res.status >= 500);
  }
  if (body === undefined) throw new SearchError(`${label} returned a response that isn't JSON.`, true);
  return body;
}

/** Accept "host:port", "http://host/", ".../search" and similar forms of a SearXNG address. */
export function searxngBase(raw: string) {
  let url = raw.trim();
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  const u = new URL(url);
  u.search = "";
  u.hash = "";
  return u.toString().replace(/\/+$/, "").replace(/\/search$/, "");
}

const PROVIDERS: Record<SearchProviderId, Provider> = {
  searxng: {
    cost: 0,
    timeout: 20_000,
    perResult: 600,
    description:
      "Metasearch through the user's own SearXNG instance, which aggregates Google, Bing, DuckDuckGo and other engines. Free and unlimited; returns many results with short snippets. " +
      "Best for quick, broad, everyday lookups: simple facts, definitions, finding an official site or a link, checking what exists, and general overviews. Prefer it for easy searches.",
    properties: {
      query,
      category: { type: "string", enum: ["general", "news", "science", "it"], description: "Engine category (default general). Use it for programming/tech, science for papers." },
      recency: recency(),
    },
    async run(base, q, args, signal) {
      const params = new URLSearchParams({ q, format: "json" });
      const category = pick(args.category, ["general", "news", "science", "it"] as const);
      if (category) params.set("categories", category);
      const r = pick(args.recency, RECENCY);
      // SearXNG has no "week" range; widen it to a month.
      if (r) params.set("time_range", r === "week" ? "month" : r);
      let url: string;
      try {
        url = `${searxngBase(base)}/search?${params}`;
      } catch {
        throw new SearchError(`"${base}" isn't a valid SearXNG address.`, true);
      }
      let body: any;
      try {
        body = await call(url, { signal }, "SearXNG");
      } catch (err) {
        if (err instanceof SearchError && /HTTP 403/.test(err.message)) {
          throw new SearchError("SearXNG refused JSON output (HTTP 403). Add `json` to `search.formats` in the instance's settings.yml.", true);
        }
        throw err;
      }
      const results: Result[] = (body.results ?? []).slice(0, 12).map((x: any) => ({
        title: x.title ?? x.url,
        url: x.url,
        published: x.publishedDate ?? undefined,
        content: x.content,
      }));
      const answers = (body.answers ?? []).map((a: any) => (typeof a === "string" ? a : a?.answer)).filter(Boolean);
      const infobox = body.infoboxes?.[0];
      const answer = [...answers, infobox ? `${infobox.infobox}: ${infobox.content ?? ""}`.trim() : ""].filter(Boolean).join("\n") || undefined;
      return { results, answer };
    },
  },

  brave: {
    cost: 1,
    timeout: 20_000,
    perResult: 800,
    description:
      "Brave Search's independent web index. Fast; returns concise snippets, with a freshness filter. " +
      "Best for quick general web searches and current events or news from the last days, especially when SearXNG isn't available or gave poor results.",
    properties: { query, recency: recency("Only return pages discovered within this period (useful for news and recent events)."), count: count(20, 8) },
    async run(key, q, args, signal) {
      const params = new URLSearchParams({ q, count: String(clampInt(args.count, 1, 20, 8)), extra_snippets: "true" });
      const r = pick(args.recency, RECENCY);
      if (r) params.set("freshness", { day: "pd", week: "pw", month: "pm", year: "py" }[r]);
      const body = await call(`https://api.search.brave.com/res/v1/web/search?${params}`, { headers: { "x-subscription-token": key }, signal }, "Brave");
      const results: Result[] = (body.web?.results ?? []).map((x: any) => ({
        title: stripTags(x.title) ?? x.url,
        url: x.url,
        published: x.page_age ?? x.age,
        content: [stripTags(x.description), ...(x.extra_snippets ?? []).map(stripTags)].filter(Boolean).join("\n"),
      }));
      return { results };
    },
  },

  kagi: {
    cost: 2,
    timeout: 20_000,
    perResult: 800,
    description:
      "Kagi premium search: high-quality, ad-free results with SEO spam and content farms filtered out. " +
      "Best for technical and programming questions, official documentation, niche or expert topics, and product research where source quality matters, or when other engines returned spammy results.",
    properties: { query, count: count(15, 8) },
    async run(key, q, args, signal) {
      const params = new URLSearchParams({ q, limit: String(clampInt(args.count, 1, 15, 8)) });
      const body = await call(`https://kagi.com/api/v0/search?${params}`, { headers: { authorization: `Bot ${key}` }, signal }, "Kagi");
      const results: Result[] = (body.data ?? [])
        .filter((x: any) => x.t === 0 && x.url)
        .map((x: any) => ({ title: x.title ?? x.url, url: x.url, published: x.published, content: x.snippet }));
      return { results };
    },
  },

  exa: {
    cost: 3,
    timeout: 30_000,
    perResult: 2500,
    description:
      "Exa neural search: understands the meaning of a natural-language query, filters by publish date with fresh crawling, and returns the text of each page. " +
      "Best for the latest, most up-to-date information (recent releases, announcements, news from the past days or weeks) and for finding specific kinds of content: research papers, companies, GitHub repos, blogs, similar pages. " +
      "Phrase the query as a description of the page you want.",
    properties: {
      query,
      recency: recency(),
      category: {
        type: "string",
        enum: ["news", "research paper", "company", "github", "pdf", "personal site", "financial report"],
        description: "Restrict results to one kind of content.",
      },
      count: count(10, 6),
    },
    async run(key, q, args, signal) {
      const r = pick(args.recency, RECENCY);
      const body: Json = {
        query: q,
        type: "auto",
        numResults: clampInt(args.count, 1, 10, 6),
        contents: { text: { maxCharacters: 3000 }, ...(r ? { livecrawl: "preferred" } : {}) },
      };
      if (r) body.startPublishedDate = sinceDate(r);
      const category = pick(args.category, ["news", "research paper", "company", "github", "pdf", "personal site", "financial report"] as const);
      if (category) body.category = category;
      const res = await call("https://api.exa.ai/search", { method: "POST", headers: { "content-type": "application/json", "x-api-key": key }, body: JSON.stringify(body), signal }, "Exa");
      const results: Result[] = (res.results ?? []).map((x: any) => ({
        title: x.title || x.url,
        url: x.url,
        published: x.publishedDate,
        content: x.text ?? x.highlights?.join("\n"),
      }));
      return { results };
    },
  },

  tavily: {
    cost: 4,
    timeout: 45_000,
    perResult: 2000,
    description:
      "Tavily search built for AI research: gathers several sources, extracts the most relevant passages from each, and adds a short synthesized answer. " +
      "Best for deep research and fact-finding that needs accurate, cross-checked information from multiple sources: comparisons, how/why questions, analysis, finance and news. Use depth=advanced for thorough research.",
    properties: {
      query,
      depth: { type: "string", enum: ["basic", "advanced"], description: "advanced is slower and more thorough (default basic)." },
      topic: { type: "string", enum: ["general", "news", "finance"], description: "Search category (default general)." },
      recency: recency(),
      count: count(10, 6),
    },
    async run(key, q, args, signal) {
      const body: Json = {
        query: q,
        search_depth: pick(args.depth, ["basic", "advanced"] as const) ?? "basic",
        topic: pick(args.topic, ["general", "news", "finance"] as const) ?? "general",
        max_results: clampInt(args.count, 1, 10, 6),
        include_answer: true,
      };
      const r = pick(args.recency, RECENCY);
      if (r) body.time_range = r;
      const res = await call("https://api.tavily.com/search", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify(body), signal }, "Tavily");
      const results: Result[] = (res.results ?? []).map((x: any) => ({ title: x.title || x.url, url: x.url, published: x.published_date, content: x.content }));
      return { results, answer: typeof res.answer === "string" ? res.answer : undefined };
    },
  },

  firecrawl: {
    cost: 5,
    timeout: 90_000,
    perResult: 8000,
    description:
      "Firecrawl search that scrapes every result's full page into clean markdown. The slowest and most expensive option, but it returns whole articles rather than snippets. " +
      "Best for deep analysis that needs complete page contents: long articles, documentation, specs, changelogs, pricing pages and tables. Keep count small (2-4).",
    properties: { query, recency: recency(), count: count(5, 3) },
    async run(key, q, args, signal) {
      const body: Json = {
        query: q,
        limit: clampInt(args.count, 1, 5, 3),
        scrapeOptions: { formats: ["markdown"], onlyMainContent: true },
      };
      const r = pick(args.recency, RECENCY);
      if (r) body.tbs = `qdr:${r[0]}`;
      const res = await call("https://api.firecrawl.dev/v2/search", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify(body), signal }, "Firecrawl");
      if (res.success === false) throw new SearchError(`Firecrawl: ${res.error ?? "search failed"}`, true);
      // v2 groups results by source ({ web, news }); v1 returned a flat array.
      const list: any[] = Array.isArray(res.data) ? res.data : [...(res.data?.web ?? []), ...(res.data?.news ?? [])];
      const results: Result[] = list.map((x) => ({
        title: x.title ?? x.metadata?.title ?? x.url,
        url: x.url ?? x.metadata?.sourceURL ?? x.metadata?.url,
        published: x.date ?? x.metadata?.publishedTime,
        content: x.markdown ?? x.description ?? x.snippet,
      }));
      return { results: results.filter((x) => x.url) };
    },
  },

  x: {
    cost: 2.5,
    timeout: 20_000,
    perResult: 600,
    description:
      "Searches posts on the X (Twitter) platform from the last 7 days through the X API. " +
      "Best for what people are saying right now: reactions and public opinion, breaking news as it unfolds, announcements posted on X, and posts from specific accounts. " +
      "Not a general web search. The query supports X operators, e.g. `from:username`, `-is:retweet`, `lang:en`, `has:links`, `\"exact phrase\"`, `#hashtag`.",
    properties: {
      query: { type: "string", description: "X search query (keywords plus optional operators such as from:, -is:retweet, lang:)." },
      sort: { type: "string", enum: ["relevancy", "recency"], description: "relevancy (default) or newest first." },
      count: { type: "integer", description: "Number of posts (10-50, default 15)." },
    },
    async run(key, q, args, signal) {
      const params = new URLSearchParams({
        query: q,
        max_results: String(clampInt(args.count, 10, 50, 15)),
        sort_order: pick(args.sort, ["relevancy", "recency"] as const) ?? "relevancy",
        "tweet.fields": "created_at,public_metrics,author_id,lang",
        expansions: "author_id",
        "user.fields": "username,name,verified",
      });
      // Accept a pasted "Bearer …" header value as well as the bare token.
      const token = decodeURIComponent(key.replace(/^bearer\s+/i, ""));
      const body = await call(`https://api.x.com/2/tweets/search/recent?${params}`, { headers: { authorization: `Bearer ${token}` }, signal }, "X");
      const users = new Map<string, any>((body.includes?.users ?? []).map((u: any) => [u.id, u]));
      const results: Result[] = (body.data ?? []).map((t: any) => {
        const u = users.get(t.author_id);
        const handle = u?.username ?? "i";
        const m = t.public_metrics ?? {};
        const text = String(t.text ?? "");
        const stats = [`${m.like_count ?? 0} likes`, `${m.retweet_count ?? 0} reposts`, `${m.reply_count ?? 0} replies`].join(", ");
        return {
          title: `@${handle}: ${text.replace(/\s+/g, " ").slice(0, 90)}${text.length > 90 ? "…" : ""}`,
          url: `https://x.com/${handle}/status/${t.id}`,
          published: t.created_at,
          content: `${u?.name ? `${u.name} (@${handle})` : `@${handle}`} · ${stats}\n${text}`,
        };
      });
      return { results };
    },
  },
};

/**
 * Check a key (or SearXNG address) with one small search, so Settings can say whether it works.
 * Rejected credentials are "invalid"; anything else that fails (unreachable, rate limited) is "error".
 */
export async function checkSearch(id: SearchProviderId, credential: string, signal?: AbortSignal): Promise<SearchCheckResult> {
  const provider = PROVIDERS[id];
  const label = SEARCH_PROVIDERS[id].label;
  // The cheapest call each provider allows: one result (X's minimum is 10), no page scraping.
  const args: Args = { count: 1 };
  const run =
    id === "firecrawl"
      ? (key: string, s: AbortSignal) =>
          call("https://api.firecrawl.dev/v2/search", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify({ query: "openchat", limit: 1 }), signal: s }, "Firecrawl")
      : (key: string, s: AbortSignal) => provider.run(key, "openchat", args, s);
  try {
    await run(credential, AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(20_000)]));
    return { provider: id, status: "valid" };
  } catch (err) {
    if (signal?.aborted) throw err;
    const e = err as Error;
    if (e.name === "TimeoutError") return { provider: id, status: "error", error: `${label} didn't answer within 20 seconds` };
    const rejected = id !== "searxng" && /HTTP (401|403)\b/.test(e.message);
    if (rejected) return { provider: id, status: "invalid", error: `${label} rejected this key` };
    return { provider: id, status: "error", error: e.message };
  }
}

const toolName = (id: SearchProviderId) => `search_${id}`;
const providerOf = (name: string) => (Object.keys(PROVIDERS) as SearchProviderId[]).find((id) => toolName(id) === name);

function clip(s: string | undefined, max: number) {
  if (!s) return "";
  const t = s.replace(/\n{3,}/g, "\n\n").trim();
  return t.length > max ? `${t.slice(0, max).trimEnd()}…` : t;
}

function format(results: Result[], answer: string | undefined, perResult: number) {
  if (!results.length && !answer) return "No results found. Try a different query or another search tool.";
  const parts: string[] = [];
  if (answer) parts.push(`Summary answer: ${answer.trim()}`);
  results.forEach((r, i) => {
    const lines = [`[${i + 1}] ${r.title}`, `URL: ${r.url}`];
    if (r.published) lines.push(`Published: ${r.published}`);
    const content = clip(r.content, perResult);
    if (content) lines.push(content);
    parts.push(lines.join("\n"));
  });
  return parts.join("\n\n");
}

/** Which providers fit each kind of search, best first (filtered to what's configured). */
const ROUTING: { task: string; order: SearchProviderId[] }[] = [
  { task: "Quick, broad or simple lookups", order: ["searxng", "brave", "kagi", "exa", "tavily", "firecrawl"] },
  { task: "Latest, up-to-date information and recent news", order: ["exa", "brave", "x", "tavily", "searxng", "kagi", "firecrawl"] },
  { task: "Deep research and multi-source fact-finding", order: ["tavily", "exa", "firecrawl", "kagi", "brave", "searxng"] },
  { task: "Reading full page contents (docs, long articles, specs)", order: ["firecrawl", "exa", "tavily"] },
  { task: "Technical, programming and quality-sensitive topics", order: ["kagi", "exa", "searxng", "brave", "tavily"] },
  { task: "Finding papers, companies, repos or similar pages", order: ["exa", "kagi", "searxng", "tavily"] },
  { task: "What people are saying on X: reactions, opinions, breaking news, posts by an account", order: ["x", "exa", "brave", "tavily"] },
];

export interface SearchToolkit {
  specs: ToolSpec[];
  /** System prompt section explaining the tools and when to use which. */
  guidance: string;
  /** The configured provider behind a tool name, if any. */
  providerFor(name: string): SearchProviderId | undefined;
  run(name: string, rawArgs: string, signal: AbortSignal): Promise<SearchOutcome>;
}

export function searchToolkit(creds: SearchCredentials[]): SearchToolkit | undefined {
  const configured = new Map<SearchProviderId, string[]>();
  for (const c of creds) if (PROVIDERS[c.provider] && c.keys?.length) configured.set(c.provider, c.keys);
  if (!configured.size) return undefined;
  const ids = [...configured.keys()].sort((a, b) => PROVIDERS[a].cost - PROVIDERS[b].cost);

  const specs = ids.map((id) => ({
    name: toolName(id),
    description: `${SEARCH_PROVIDERS[id].label}: ${PROVIDERS[id].description}`,
    parameters: { type: "object", properties: PROVIDERS[id].properties, required: ["query"] },
  }));

  const lines = [
    "## Web search",
    `You can search the web with these tools: ${ids.map(toolName).join(", ")}.`,
    "Search when the answer depends on current events, recent releases, prices, live facts, or specifics you aren't sure about. Don't search for things you already know well (general knowledge, writing, coding help, math).",
  ];
  if (ids.length > 1) {
    lines.push("Pick the tool that fits the task (best first):");
    for (const r of ROUTING) {
      const order = r.order.filter((id) => configured.has(id));
      if (order.length) lines.push(`- ${r.task}: ${order.map(toolName).join(" > ")}`);
    }
    lines.push("Prefer cheaper, faster tools for easy questions and save the deep tools for questions that need them. If one tool fails or returns poor results, try another.");
  }
  lines.push(
    "You can run several searches, in parallel when they are independent, and refine queries based on what you find. Use specific queries.",
    "Base your answer on the results and cite sources inline as Markdown links, e.g. [Source title](https://example.com). Never invent URLs.",
  );

  return {
    specs,
    guidance: lines.join("\n"),
    providerFor: (name) => {
      const id = providerOf(name);
      return id && configured.has(id) ? id : undefined;
    },
    async run(name, rawArgs, signal) {
      const id = providerOf(name);
      let args: Args = {};
      try {
        args = rawArgs.trim() ? JSON.parse(rawArgs) : {};
      } catch {}
      const q = typeof args.query === "string" ? args.query.trim() : "";
      const keys = id && configured.get(id);
      if (!id || !keys) return { provider: id ?? "searxng", query: q, text: `Error: unknown tool ${name}.`, links: [], error: "Unknown tool" };
      if (!q) return { provider: id, query: q, text: "Error: a non-empty `query` argument is required.", links: [], error: "Missing query" };
      const provider = PROVIDERS[id];
      const label = SEARCH_PROVIDERS[id].label;
      let lastError = `${label} search failed.`;
      // Try keys (or instances) in order; fall back when one is rejected, out of credit or unreachable.
      for (let i = 0; i < keys.length; i++) {
        try {
          const { results, answer } = await provider.run(keys[i]!, q, args, AbortSignal.any([signal, AbortSignal.timeout(provider.timeout)]));
          return {
            provider: id,
            query: q,
            text: format(results, answer, provider.perResult),
            links: results.slice(0, 12).map((r) => ({ title: r.title, url: r.url })),
          };
        } catch (err) {
          if (signal.aborted) throw err;
          const e = err as Error;
          lastError = e.name === "TimeoutError" ? `${label} timed out.` : e.message;
          if (err instanceof SearchError && !err.fallback) break;
          if (i < keys.length - 1) console.warn(`[search] ${label} ${SEARCH_PROVIDERS[id].credential} ${i + 1} failed (${lastError}); trying ${i + 2}`);
        }
      }
      return { provider: id, query: q, text: `Error: ${lastError} Try another search tool if one is available.`, links: [], error: lastError };
    },
  };
}
