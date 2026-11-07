import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Browser shims and fetch overrides stay in a separate process.
if (process.env.OPENBUILD_PAIR_UI_CHILD !== "1") {
  test("pair device UI (isolated browser)", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, OPENBUILD_PAIR_UI_CHILD: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`${out}\n${err}`);
    expect(code).toBe(0);
  });
} else {
  await import("fake-indexeddb/auto" as string);
  const g = globalThis as any;
  g.window ??= globalThis;
  g.innerWidth = 390;
  g.document ??= { addEventListener() {}, visibilityState: "visible" };
  g.addEventListener ??= () => {};
  g.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const ls = new Map<string, string>();
  g.localStorage ??= { getItem: (k: string) => ls.get(k) ?? null, setItem: (k: string, v: string) => void ls.set(k, v), removeItem: (k: string) => void ls.delete(k) };

  const { PairDeviceView, initialPair, pairReducer, searchingLabel } = await import("../src/components/PairDevice");
  const { PairError, pairDevice } = await import("../src/lib/pi");
  const { DevicesSection } = await import("../src/components/DeviceSettings");
  const { useStore } = await import("../src/lib/store");
  type State = ReturnType<typeof initialPair>;

  const run = (...actions: Parameters<typeof pairReducer>[1][]) => actions.reduce(pairReducer, initialPair());
  const view = (state: State) => renderToStaticMarkup(createElement(PairDeviceView, { state, dispatch: () => {}, onSubmit: () => {}, onCancel: () => {} }));

  test("the form explains where the code comes from, for the chosen network", () => {
    const tailscale = view(initialPair());
    expect(tailscale).toContain("openbuild pair --host");
    expect(tailscale).toContain("choose Tailscale when it asks");
    expect(tailscale).toContain("same tailnet");
    expect(tailscale).toContain("15 minutes");
    const lan = view(run({ type: "mode", mode: "lan" }));
    expect(lan).toContain("choose LAN when it asks");
    expect(lan).toContain("same network");
  });

  test("keyboard and phone affordances: labelled fields, a radio group, Enter submits", () => {
    const html = view(run({ type: "code", code: "abcd-2345" }));
    expect(html).toMatch(/<label[^>]*for="[^"]+-code"/);
    expect(html).toContain('role="radiogroup"');
    expect(html).toMatch(/role="radio" aria-checked="true" tabindex="0"[^>]*>Tailscale/);
    expect(html).toMatch(/role="radio" aria-checked="false" tabindex="-1"[^>]*>LAN/);
    expect(html).toContain('autoComplete="off"');
    expect(html).toContain('autoCapitalize="characters"');
    expect(html).toContain('enterKeyHint="go"');
    expect(html).toContain('spellCheck="false"');
    expect(html).toContain('value="ABCD-2345"');
    expect(html).toMatch(/<button type="submit" class="btn btn-sm btn-primary">Pair<\/button>/);
    expect(html).toContain(">Cancel</button>");
    expect(html).toContain("Enter its address instead");
  });

  test("Pair is disabled until there is a code", () => {
    expect(view(initialPair())).toMatch(/<button type="submit"[^>]*disabled=""[^>]*>Pair</);
  });

  test("while searching: busy, fields locked, progress announced, and Stop instead of Cancel", () => {
    const state = run({ type: "code", code: "ABCD-2345" }, { type: "start" });
    const html = view(state);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Looking for a device on your tailnet…");
    expect(html).toMatch(/role="status" aria-live="polite"/);
    expect(html).toContain(">Stop</button>");
    expect(html).toMatch(/<button type="submit"[^>]*disabled=""[^>]*>Pairing…</);
    expect(html).toMatch(/readOnly=""/);
    // Typing or switching network does nothing until the search ends.
    expect(pairReducer(state, { type: "code", code: "OTHER" })).toBe(state);
    expect(pairReducer(state, { type: "mode", mode: "lan" })).toBe(state);
    expect(searchingLabel({ ...state, showAddress: true, address: " 10.0.0.5 " })).toBe("Looking for it at 10.0.0.5…");
  });

  test("nobody found: the error is shown and the address field appears for a retry", () => {
    const state = run({ type: "code", code: "ABCD-2345" }, { type: "start" }, { type: "failed", error: "No OpenBuild is waiting to pair on your tailnet.", reason: "not-found" });
    expect(state).toMatchObject({ pairing: false, showAddress: true });
    const html = view(state);
    expect(html).toMatch(/role="alert"[^>]*>.*No OpenBuild is waiting/);
    expect(html).toContain("Its address");
    expect(html).toContain('inputMode="url"');
    expect(html).toContain('autoCapitalize="none"');
    expect(html).toContain(">Try again</button>");
    expect(html).not.toContain("Enter its address instead");
  });

  test("a wrong code: the error stays until the code is edited, then Pair again", () => {
    const failed = run({ type: "code", code: "ABCD-2345" }, { type: "start" }, { type: "failed", error: "The code didn't match.", reason: "rejected" });
    expect(failed.showAddress).toBe(false);
    expect(view(failed)).toContain('aria-invalid="true"');
    expect(view(failed)).toContain(">Try again</button>");
    const edited = pairReducer(failed, { type: "code", code: "ABCD-2346" });
    expect(edited.error).toBeUndefined();
    expect(view(edited)).not.toContain('role="alert"');
  });

  test("cancelling a search returns to the form without an error", () => {
    const state = run({ type: "code", code: "ABCD-2345" }, { type: "start" }, { type: "cancelled" });
    expect(state).toMatchObject({ pairing: false, code: "ABCD-2345" });
    expect(state.error).toBeUndefined();
  });

  test("pairDevice sends the choice, passes the cancel signal, and keeps the server's reason", async () => {
    const original = globalThis.fetch;
    const calls: { url: string; init: RequestInit }[] = [];
    try {
      globalThis.fetch = (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return Response.json({ device: { id: "d1", name: "MacBook", mode: "tailscale", urls: [] } });
      }) as typeof fetch;
      const ctrl = new AbortController();
      expect(await pairDevice({ mode: "tailscale", code: "ABCD-2345" }, ctrl.signal)).toMatchObject({ name: "MacBook" });
      expect(calls[0]!.url).toBe("/api/pair/connect");
      expect(calls[0]!.init.signal).toBe(ctrl.signal);
      expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ mode: "tailscale", code: "ABCD-2345" });

      globalThis.fetch = (async () => Response.json({ error: "No OpenBuild is waiting to pair on your network.", reason: "not-found" }, { status: 404 })) as unknown as typeof fetch;
      const error = await pairDevice({ mode: "lan", code: "ABCD-2345" }).catch((e) => e);
      expect(error).toBeInstanceOf(PairError);
      expect(error).toMatchObject({ message: "No OpenBuild is waiting to pair on your network.", reason: "not-found" });

      globalThis.fetch = (async () => new Response("bad gateway", { status: 502 })) as unknown as typeof fetch;
      expect((await pairDevice({ mode: "lan", code: "ABCD-2345" }).catch((e) => e)).message).toBe("Pairing failed (HTTP 502)");
    } finally {
      globalThis.fetch = original;
    }
  });

  test("Settings → Devices offers Pair device, and the empty state mentions it", () => {
    const snapshot = useStore.getInitialState();
    const original = { ...snapshot };
    Object.assign(snapshot, useStore.getState(), { devices: [{ id: "local", name: "imac", local: true, mode: "lan", urls: [] }] });
    try {
      const html = renderToStaticMarkup(createElement(DevicesSection));
      expect(html).toMatch(/<button[^>]*class="btn btn-sm pair-open"[^>]*>.*Pair device<\/button>/);
      expect(html).toContain("then choose Pair device here");
      expect(html).toContain("openbuild pair --client");
    } finally {
      Object.assign(snapshot, original);
    }
  });
}
