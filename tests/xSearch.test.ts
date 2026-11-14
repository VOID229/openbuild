// X search (server/search.ts): the user's X key is the app's Bearer Token, sent exactly as the X
// developer console shows it, and X's refusals come back as what to do, never with the token.
import { afterEach, expect, test } from "bun:test";
import { checkSearch, searchToolkit, xBearer, xProblem } from "../server/search";

// The sample Bearer Token from docs.x.com (OAuth 2.0 Bearer Token), not a real key: an app-only token
// holds URL escapes such as %2B and %3D, and X takes it only as issued.
const SAMPLE = "AAAAAAAAAAAAAAAAAAAAAMLheAAAAAAA0%2BuSeid%2BULvsea4JtiGRiSDSJSI%3DEUifiRBkKG5E2XzMDjRfl76ZC9Ub0wnz4XsNiRVBChTYbJcE3F"; // gitleaks:allow (docs sample)
const SECRET_SHAPED = "TEST-ONLY-api-key-secret-0123456789abcdefghijklmn"; // gitleaks:allow (fake)
const UNAUTHORIZED = { title: "Unauthorized", type: "about:blank", status: 401, detail: "Unauthorized" };

const realFetch = globalThis.fetch;
const realWarn = console.warn;
afterEach(() => {
  globalThis.fetch = realFetch;
  console.warn = realWarn;
});

/** X stand-in: answers `answer`, and keeps each request's URL and Authorization header. */
function fakeX(answer: () => Response) {
  const seen: { url: URL; auth: string | null }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url: new URL(url), auth: new Headers(init.headers).get("authorization") });
    return answer();
  }) as unknown as typeof fetch;
  return seen;
}

const problem = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/problem+json" } });
const search = (keys: string[]) => searchToolkit([{ provider: "x", keys }]).run("search_x", JSON.stringify({ query: "openbuild from:openbuild", count: 20 }), new AbortController().signal);

test("sends the Bearer Token exactly as issued, %2B and %3D included, to recent search", async () => {
  const seen = fakeX(() => Response.json({ data: [{ id: "1", text: "hello", author_id: "9" }], includes: { users: [{ id: "9", username: "openbuild" }] } }));
  const out = await search([SAMPLE]);
  expect(out.error).toBeUndefined();
  expect(seen).toHaveLength(1);
  expect(seen[0]!.auth).toBe(`Bearer ${SAMPLE}`);
  expect(seen[0]!.url.origin + seen[0]!.url.pathname).toBe("https://api.x.com/2/tweets/search/recent");
  expect(seen[0]!.url.searchParams.get("query")).toBe("openbuild from:openbuild");
  expect(seen[0]!.url.searchParams.get("max_results")).toBe("20");
  expect(out.links).toEqual([{ title: "@openbuild: hello", url: "https://x.com/openbuild/status/1" }]);
});

test("the Settings check sends the token as issued too", async () => {
  const seen = fakeX(() => Response.json({ meta: { result_count: 0 } }));
  expect(await checkSearch("x", SAMPLE)).toEqual({ provider: "x", status: "valid" });
  expect(seen[0]!.auth).toBe(`Bearer ${SAMPLE}`);
});

test('a pasted header value works too: only the "Bearer " is taken off', () => {
  expect(xBearer(`Bearer ${SAMPLE}`)).toBe(SAMPLE);
  expect(xBearer(`  bearer ${SAMPLE}\n`)).toBe(SAMPLE);
  expect(xBearer(SAMPLE)).toBe(SAMPLE);
});

test("401: says X refused the Bearer Token and which key to paste where, never the token", async () => {
  // X's real answer to a token it won't take.
  fakeX(problem(401, UNAUTHORIZED));
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
  const out = await search([SAMPLE]);
  expect(out.error).toStartWith("X returned HTTP 401 (Unauthorized). X refused the Bearer Token.");
  expect(out.error).toContain("console.x.com (your app → Keys and tokens → Bearer Token)");
  expect(out.error).toContain("Settings → Bots → Web search → X");
  expect(out.error).toContain("doesn't use the API Key, API Key Secret or Access Token");
  // A Bearer-shaped token: no word about its shape.
  expect(out.error).not.toContain("doesn't look like a Bearer Token");
  expect(out.error).not.toContain(SAMPLE);
  expect(out.text).toContain(out.error!);
  expect(warnings).toEqual(["[search] X refused a search (HTTP 401: Unauthorized)"]);
});

test("401 with a key that isn't Bearer-shaped (the API Key Secret): says so, without the key", async () => {
  fakeX(problem(401, UNAUTHORIZED));
  console.warn = () => {};
  const out = await search([SECRET_SHAPED]);
  expect(out.error).toContain("The saved key doesn't look like a Bearer Token");
  expect(out.error).toContain("it may be the API Key or API Key Secret");
  expect(out.error).not.toContain(SECRET_SHAPED);
});

test("the Settings check: 401 is the wrong token, 403 and 429 are the account, each in X's words", async () => {
  fakeX(problem(401, UNAUTHORIZED));
  const refused = await checkSearch("x", SECRET_SHAPED);
  expect(refused.status).toBe("invalid");
  expect(refused.error).toStartWith("X returned HTTP 401 (Unauthorized). X refused the Bearer Token.");
  expect(refused.error).not.toContain(SECRET_SHAPED);

  fakeX(problem(403, { title: "Client Forbidden", detail: "When authenticating requests to the Twitter API v2 endpoints, you must use keys and tokens from a Twitter developer App that is attached to a Project.", reason: "client-not-enrolled", type: "https://api.twitter.com/2/problems/client-forbidden" }));
  const forbidden = await checkSearch("x", SAMPLE);
  expect(forbidden.status).toBe("error");
  expect(forbidden.error).toContain("X doesn't let this app search posts");

  fakeX(problem(429, { title: "Too Many Requests", detail: "Too Many Requests", type: "about:blank", status: 429 }));
  expect(await checkSearch("x", SAMPLE)).toEqual({ provider: "x", status: "error", error: "X returned HTTP 429 (Too Many Requests). X is rate limiting the searches. Try again in a few minutes." });
});

test("X's billing and access errors say what to do in console.x.com", () => {
  const credits = xProblem(402, { title: "CreditsDepleted", detail: "Your enrolled account [1] does not have any credits to fulfill this request.", type: "https://api.x.com/2/problems/credits" }, SAMPLE);
  expect(credits).toStartWith("X returned HTTP 402 (CreditsDepleted: Your enrolled account [1] does not have any credits");
  expect(credits).toContain("no credits left. Buy credits in console.x.com");

  const capped = xProblem(429, { title: "Usage cap exceeded", detail: "Monthly product cap", type: "https://api.x.com/2/problems/usage-capped" }, SAMPLE);
  expect(capped).toContain("spending limit or usage cap");

  expect(xProblem(429, { errors: [{ code: 88, message: "Rate limit exceeded" }] }, SAMPLE)).toBe("X returned HTTP 429 (Rate limit exceeded). X is rate limiting the searches. Try again in a few minutes.");
  expect(xProblem(403, { title: "Forbidden" }, SAMPLE)).toContain("the app needs API access with pay-per-use credits");
  expect(xProblem(400, { title: "Invalid Request", detail: "The 'query' parameter is required.", type: "https://api.x.com/2/problems/invalid-request" }, SAMPLE)).toBe("X returned HTTP 400 (Invalid Request: The 'query' parameter is required.).");
  // Should X ever echo the token, it doesn't pass through.
  expect(xProblem(401, { title: "Unauthorized", detail: `Bad token ${SAMPLE}` }, SAMPLE)).not.toContain(SAMPLE);
});

test("a refused key falls back to the next one; a 500 isn't logged as an account problem", async () => {
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
  let calls = 0;
  const seen = fakeX(() => (calls++ === 0 ? problem(401, UNAUTHORIZED)() : Response.json({ meta: { result_count: 0 } })));
  const out = await search([SECRET_SHAPED, SAMPLE]);
  expect(out.error).toBeUndefined();
  expect(seen.map((s) => s.auth)).toEqual([`Bearer ${SECRET_SHAPED}`, `Bearer ${SAMPLE}`]);
  expect(warnings.join("\n")).not.toContain(SECRET_SHAPED);

  warnings.length = 0;
  fakeX(problem(503, { title: "Service Unavailable" }));
  const down = await search([SAMPLE]);
  expect(down.error).toBe("X returned HTTP 503 (Service Unavailable).");
  expect(warnings).toEqual([]);
});
