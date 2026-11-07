import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";

// Settings → Devices → Pair device, clicked at in a DOM: the address field takes the code field's
// place and back, keeping both values, and Pair never goes out without a code. fetch is faked, so
// nothing is paired. Each test file runs in its own process (scripts/test.ts), so the globals stay here.
const win = new Window({ url: "http://localhost/" });
const g = globalThis as any;
for (const key of Object.getOwnPropertyNames(win)) if (!(key in g)) g[key] = (win as any)[key];
Object.assign(g, { window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage, getComputedStyle: win.getComputedStyle.bind(win) });
g.IS_REACT_ACT_ENVIRONMENT = true;
// Browsers mark an animation's finished promise as handled; happy-dom reports the spinner's cancel.
const animate = win.Element.prototype.animate;
win.Element.prototype.animate = function (this: any, ...args: any[]) {
  const animation = (animate as any).apply(this, args);
  animation.finished.catch(() => {});
  return animation;
} as any;

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { PairDevice } = await import("../src/components/PairDevice");

let requests: any[] = [];
let reply: () => Response;
let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
let paired: unknown[] = [];

beforeEach(async () => {
  requests = [];
  paired = [];
  reply = () => Response.json({ device: { id: "d1", name: "MacBook", mode: "tailscale", urls: [] } });
  globalThis.fetch = (async (path: string, init?: RequestInit) => {
    requests.push({ path, body: JSON.parse(String(init?.body)) });
    return reply();
  }) as unknown as typeof fetch;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(PairDevice, { onPaired: (d) => void paired.push(d), onClose: () => {} })));
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

const input = () => host.querySelector<HTMLInputElement>("label.pair-field input")!;
const label = () => host.querySelector("label.pair-field .pair-label")!.textContent;
const toggle = () => host.querySelector<HTMLButtonElement>(".pair-link")!;
const submit = () => host.querySelector<HTMLButtonElement>('button[type="submit"]')!;
const alert = () => host.querySelector('[role="alert"]')?.textContent ?? "";
const click = (el: Element) => act(async () => { el.dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as any); });
const type = (value: string) =>
  act(async () => {
    const el = input();
    Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new win.Event("input", { bubbles: true }) as any);
  });
const send = () => act(async () => { host.querySelector("form")!.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }) as any); });

test("the address takes the code field's place, and Enter code brings the code back, both kept", async () => {
  expect(label()).toBe("Pairing code");
  expect(host.querySelectorAll("label.pair-field input")).toHaveLength(1);
  await type("abcd-2345");
  await click(toggle());
  expect(label()).toBe("Its address");
  expect(host.querySelectorAll("label.pair-field input")).toHaveLength(1);
  expect(document.activeElement).toBe(input());
  expect(toggle().textContent).toBe("Enter code");
  await type("laptop.tailnet.ts.net");
  await click(toggle());
  expect(label()).toBe("Pairing code");
  expect(input().value).toBe("ABCD-2345");
  expect(document.activeElement).toBe(input());
  expect(toggle().textContent).toBe("Enter its address instead");
  expect(host.textContent).toContain("It looks for the device at laptop.tailnet.ts.net.");
  await click(toggle());
  expect(input().value).toBe("laptop.tailnet.ts.net");
});

test("from the address without a code, Pair goes to the code step and sends nothing", async () => {
  await click(toggle());
  await type("10.0.0.5");
  expect(submit().textContent).toBe("Next");
  expect(submit().disabled).toBe(false);
  await send();
  expect(requests).toEqual([]);
  expect(label()).toBe("Pairing code");
  expect(document.activeElement).toBe(input());
  expect(input().getAttribute("aria-invalid")).toBe("true");
  expect(alert()).toContain("Enter the pairing code");
  expect(submit().disabled).toBe(true);
  await type("abcd-2345");
  await send();
  expect(requests).toEqual([{ path: "/api/pair/connect", body: { mode: "tailscale", code: "ABCD-2345", address: "10.0.0.5" } }]);
  expect(paired).toHaveLength(1);
});

test("pairing from the address view sends the kept code with it; LAN is kept too", async () => {
  await click(host.querySelector('[data-mode="lan"]')!);
  await type("ABCD-2345");
  await click(toggle());
  await type("192.168.1.20:3100");
  expect(submit().textContent).toBe("Pair");
  await send();
  expect(requests[0].body).toEqual({ mode: "lan", code: "ABCD-2345", address: "192.168.1.20:3100" });
});

test("nobody found swaps in the address; a wrong code from there swaps the code back", async () => {
  reply = () => Response.json({ error: "No OpenBuild is waiting to pair on your tailnet.", reason: "not-found" }, { status: 404 });
  await type("ABCD-2345");
  await send();
  expect(label()).toBe("Its address");
  expect(document.activeElement).toBe(input());
  expect(submit().textContent).toBe("Try again");
  await type("laptop");
  reply = () => Response.json({ error: "The code didn't match.", reason: "rejected" }, { status: 403 });
  await send();
  expect(label()).toBe("Pairing code");
  expect(input().value).toBe("ABCD-2345");
  expect(input().getAttribute("aria-invalid")).toBe("true");
  expect(alert()).toContain("The code didn't match.");
});
