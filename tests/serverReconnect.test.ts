import { expect, test } from "bun:test";
import { Window } from "happy-dom";

// After a restart the open app is back within a probe or two, and everything waiting out the
// outage on a backoff goes at once. Its own process (scripts/test.ts), so the globals stay here.
const win = new Window({ url: "http://localhost/" });
const g = globalThis as any;
for (const key of Object.getOwnPropertyNames(win)) if (!(key in g)) g[key] = (win as any)[key];
Object.assign(g, { window: win, Event: win.Event, document: win.document, navigator: win.navigator, localStorage: win.localStorage, getComputedStyle: win.getComputedStyle.bind(win) });
// Real timers drive this, so React schedules as it does in a browser rather than inside act().
g.IS_REACT_ACT_ENVIRONMENT = false;

let up = true;
let probes: number[] = [];
(win as any).fetch = g.fetch = (async (input: string) => {
  const url = String(input);
  if (url.endsWith("/api/auth/status")) probes.push(performance.now());
  if (!up) throw new TypeError("Failed to fetch");
  if (url.endsWith("/api/auth/status")) return Response.json({ configured: false, authenticated: true });
  return Response.json({});
}) as typeof fetch;

const { createElement: h } = await import("react");
const { createRoot } = await import("react-dom/client");
const { LocalAccess } = await import("../src/components/LocalAccess");
const { SERVER_BACK, useServerOutage, waitForServer } = await import("../src/lib/serverOutage");

test("the app sees a restarted server within a fast probe, and wakes what's waiting on it", async () => {
  const backs: number[] = [];
  win.addEventListener(SERVER_BACK, () => backs.push(performance.now()));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  root.render(h(LocalAccess, { load: async () => h("main", { className: "app" }, "OpenBuild") }));
  await Bun.sleep(100);
  expect(host.querySelector(".app")).toBeTruthy();
  // The first answer is just the server being there, not it coming back.
  expect(backs).toEqual([]);

  // The server goes away (a restart): an API call failing is the first sign.
  up = false;
  probes = [];
  await win.fetch("/api/state").catch(() => {});
  await Bun.sleep(2000);
  // Looked for often while it's away, and the app stays up, saying so.
  expect(probes.length).toBeGreaterThanOrEqual(6);
  expect(useServerOutage.getState().outage).toBe(true);
  expect(host.querySelector(".app")).toBeTruthy();

  // A retry loop waiting out the outage on a long backoff…
  let woke = 0;
  const waiting = waitForServer(30_000).then(() => (woke = performance.now()));
  up = true;
  const back = performance.now();
  await waiting;
  await Bun.sleep(100);
  // …goes as soon as a probe finds the server, well before its own timer.
  expect(backs.length).toBe(1);
  expect(backs[0]! - back).toBeLessThan(600);
  expect(woke - back).toBeLessThan(600);
  expect(useServerOutage.getState().outage).toBe(false);
  root.unmount();
}, 10_000);

test("a long-lived connection dropping has the app look for the server at once", async () => {
  const { suspectOutage } = await import("../src/lib/serverOutage");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  root.render(h(LocalAccess, { load: async () => h("main", { className: "app" }, "OpenBuild") }));
  await Bun.sleep(100);
  const backs: number[] = [];
  const onBack = () => backs.push(performance.now());
  win.addEventListener(SERVER_BACK, onBack);
  // The server restarts while nothing else is asking it anything: only the dropped stream says so.
  up = false;
  probes = [];
  suspectOutage();
  await Bun.sleep(700);
  expect(probes.length).toBeGreaterThanOrEqual(2);
  up = true;
  const back = performance.now();
  await Bun.sleep(500);
  expect(backs.length).toBe(1);
  expect(backs[0]! - back).toBeLessThan(400);
  win.removeEventListener(SERVER_BACK, onBack);
  root.unmount();
});

test("waiting for the server ends on its own timer, or when called off", async () => {
  const start = performance.now();
  await waitForServer(30);
  expect(performance.now() - start).toBeGreaterThanOrEqual(25);
  const ctrl = new AbortController();
  const waiting = waitForServer(30_000, ctrl.signal);
  ctrl.abort();
  await waiting;
  expect(performance.now() - start).toBeLessThan(1000);
});
