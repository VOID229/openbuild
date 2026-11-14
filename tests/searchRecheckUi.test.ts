import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";

// Settings → Bots → Web search: every Retry press checks the key (or SearXNG address) again with the
// provider itself. After the user fixes the account (buys X credits, raises a cap), the next press
// shows what the provider says now, never a cached answer or that of an older check still running.
// The page runs for real down to the provider: its requests reach the server's own check
// (handleSearchCheck → checkSearch), and only the provider's API is a stand-in.
// Each test file runs in its own process (scripts/test.ts), so the globals stay here.
const win = new Window({ url: "http://localhost/" });
const g = globalThis as any;
for (const key of Object.getOwnPropertyNames(win)) if (!(key in g)) g[key] = (win as any)[key];
Object.assign(g, { window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage, getComputedStyle: win.getComputedStyle.bind(win) });
g.window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
g.matchMedia = g.window.matchMedia;
g.IS_REACT_ACT_ENVIRONMENT = true;

const { handleSearchCheck } = await import("../server/handlers");
const { SEARCH_ORDER, SEARCH_PROVIDERS } = await import("../shared/types");
type Provider = (typeof SEARCH_ORDER)[number];

/** What the provider's API answers next, in order: a status code, and how long it takes. */
let answers: { status: number; delay?: number }[] = [];
/** Calls that reached a provider's API. */
let providerCalls = 0;
const NO_CREDITS = { title: "CreditsDepleted", detail: "Your enrolled account does not have any credits to fulfill this request." };
const aborted = () => new DOMException("The operation was aborted.", "AbortError");

// Installed before the stores load: their saved-state reads start on import.
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost/");
  if (url.origin === "http://localhost") {
    if (url.pathname !== "/api/verify-search") return Response.json({});
    // The local server: a saved key is looked up by id (here the id is the key), an address comes as is.
    const body = JSON.parse(String(init?.body));
    const res = await handleSearchCheck(body.provider, body.url ?? body.id);
    // Like a browser's fetch, a request the page gave up on rejects rather than answering.
    if (init?.signal?.aborted) throw aborted();
    return res;
  }
  providerCalls++;
  const next = answers.shift() ?? { status: 200 };
  if (next.delay) await new Promise((r) => setTimeout(r, next.delay));
  return next.status === 200 ? Response.json({}) : new Response(JSON.stringify(NO_CREDITS), { status: next.status, headers: { "content-type": "application/problem+json" } });
}) as unknown as typeof fetch;

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useStore } = await import("../src/lib/store");
const { useBots } = await import("../src/lib/bots/store");
const { BotWebSearch } = await import("../src/components/bots/BotWebSearch");

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;

beforeAll(async () => {
  if (!useStore.persist.hasHydrated()) await new Promise<void>((resolve) => useStore.persist.onFinishHydration(() => resolve()));
});
beforeEach(() => {
  answers = [];
  providerCalls = 0;
  useStore.setState((s) => ({ settings: { ...s.settings, search: {} }, searchStatus: {} }));
  useBots.setState({ searxng: [] });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

const settle = (ms = 30) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
const SEARXNG = "http://10.0.0.5:8080";
const isUrl = (p: Provider) => SEARCH_PROVIDERS[p].credential === "url";
const works = (p: Provider) => (isUrl(p) ? "Reachable" : "Works");
const rowOf = (p: Provider) => [...host.querySelectorAll<HTMLElement>(".key-row")].find((r) => r.querySelector(".key-label span")?.textContent === SEARCH_PROVIDERS[p].label)!;
const said = (p: Provider) => [...rowOf(p).querySelectorAll(".key-badge, .key-status")].map((e) => e.textContent).join(" ").trim();
const button = (p: Provider, text: string) => [...rowOf(p).querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text || b.getAttribute("aria-label") === text);
const press = (p: Provider, text: string) => act(async () => button(p, text)!.click());

/** Type an address into SearXNG's empty field and save it, as the user does. */
async function addAddress(url: string) {
  const input = rowOf("searxng").querySelector<HTMLInputElement>("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!.call(input, url);
    input.dispatchEvent(new win.Event("input", { bubbles: true }) as any);
  });
  await press("searxng", "Save");
}

/** The page with this provider's key (or address) saved, after its check found no credits. */
async function showNoCredits(p: Provider) {
  answers = [{ status: 402 }];
  if (isUrl(p)) {
    await act(async () => root.render(createElement(BotWebSearch)));
    await addAddress(SEARXNG);
  } else {
    // Saving a key checks it (setSearchKeys → verifySearch); the vault itself isn't under test here.
    useStore.setState((s) => ({ settings: { ...s.settings, search: { [p]: [`${p}-key`] } } }));
    await act(async () => root.render(createElement(BotWebSearch)));
    await act(() => useStore.getState().verifySearch(p));
  }
  await settle();
  expect(said(p)).toContain("402");
  expect(button(p, "Retry")).toBeDefined();
  providerCalls = 0;
}

for (const p of SEARCH_ORDER) {
  test(`${p}: every Retry asks the provider again and shows its answer now`, async () => {
    await showNoCredits(p);
    // Still out of credit: the press reaches the provider, which says so again.
    answers = [{ status: 402, delay: 60 }];
    await press(p, "Retry");
    expect(said(p)).toContain("Checking");
    await settle(120);
    expect(providerCalls).toBe(1);
    expect(said(p)).toContain("402");
    // Credits bought: the very next press reaches the provider and shows the key works.
    answers = [{ status: 200 }];
    await press(p, "Retry");
    await settle();
    expect(providerCalls).toBe(2);
    expect(said(p)).toBe(works(p));
  });
}

test("searxng: an older check still running when the address is checked again never replaces the newer answer", async () => {
  await act(async () => root.render(createElement(BotWebSearch)));
  // The first check is slow and finds the instance refusing; it's fixed meanwhile, and the user
  // removes the address and adds it again, which checks it again, quickly this time.
  answers = [{ status: 402, delay: 200 }, { status: 200 }];
  await addAddress(SEARXNG);
  await settle();
  expect(said("searxng")).toContain("Checking");
  await press("searxng", "Remove address");
  await addAddress(SEARXNG);
  await settle();
  expect(said("searxng")).toBe("Reachable");
  // The first check's answer arrives last: it's stale and must not show.
  await settle(250);
  expect(providerCalls).toBe(2);
  expect(said("searxng")).toBe("Reachable");
});

test("key providers: a check started again while one is running shows the newer answer", async () => {
  useStore.setState((s) => ({ settings: { ...s.settings, search: { x: ["x-key"] } } }));
  await act(async () => root.render(createElement(BotWebSearch)));
  answers = [{ status: 402, delay: 200 }, { status: 200 }];
  await act(async () => void useStore.getState().verifySearch("x"));
  await settle();
  await act(() => useStore.getState().verifySearch("x", ["x-key"]));
  await settle();
  expect(said("x")).toBe("Works");
  await settle(250);
  expect(providerCalls).toBe(2);
  expect(said("x")).toBe("Works");
});
