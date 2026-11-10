// The startup popup for a server without Pi: what counts as missing, what it says, and Pi's install
// from it (fakes only: nothing here installs anything or asks the real server).
import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ThreadRuntime } from "../shared/types";

// Browser shims and the store stay in a separate process.
if (process.env.OPENBUILD_HARNESS_SETUP_CHILD !== "1") {
  test("harness setup popup (isolated process)", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, OPENBUILD_HARNESS_SETUP_CHILD: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`${out}\n${err}`);
    expect(code).toBe(0);
  }, 60_000);
} else {
  await import("fake-indexeddb/auto" as string);
  const g = globalThis as any;
  g.window ??= globalThis;
  g.innerWidth = 1280;
  g.document ??= { addEventListener() {}, visibilityState: "visible" };
  g.addEventListener ??= () => {};
  g.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const storage = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
  };
  g.localStorage ??= storage();
  g.sessionStorage ??= storage();

  const { harnessNeed, installPiAndCheck, rememberDismissed, wasDismissed, SUPPORTED_HARNESSES } = await import("../src/lib/harnessSetup");
  type Phase = Parameters<typeof installPiAndCheck>[0] extends { onPhase: (p: infer P) => void } ? P : never;
  const { HarnessSetupView, harnessSetupText } = await import("../src/components/HarnessSetup");

  const ALL: ThreadRuntime[] = ["pi", "durable", "claude", "codex", "cursor", "fx", "opencode", "hermes", "grok"];
  /** /api/runtimes as the server answers it, with only `on` installed. */
  const only = (...on: ThreadRuntime[]) => Object.fromEntries(ALL.map((r) => [r, { installed: on.includes(r), install: `install ${r}` }]));
  const ready = (...on: ThreadRuntime[]) => ({ state: "ready" as const, runtimes: only(...on) });
  const view = (props: Partial<Parameters<typeof HarnessSetupView>[0]> & Pick<Parameters<typeof HarnessSetupView>[0], "need" | "runtimes">) =>
    renderToStaticMarkup(createElement(HarnessSetupView, { machine: "imac", install: { phase: "idle" }, onInstall() {}, onClose() {}, onSettings() {}, ...props }));

  test("no harness at all: both OpenBots and OpenBuild are blocked", () => {
    expect(harnessNeed(ready())).toBe("none");
    const text = harnessSetupText("none", only(), "imac");
    expect(text.lead).toBe("OpenBots needs Pi installed to work.");
    expect(text.detail).toContain("OpenBuild also needs at least one of Pi, Codex, Claude Code, OpenCode, Grok or Cursor");
    expect(text.detail).toContain("none of them is installed on imac");
    expect(text.detail).not.toContain("Hermes");
  });

  test("Hermes alone doesn't count, and the popup says so", () => {
    expect(harnessNeed(ready("hermes"))).toBe("none");
    expect(harnessSetupText("none", only("hermes")).detail).toContain("Hermes on its own isn't enough.");
    // Nor do fx or Durable (which is Pi's own package) stand in for a supported harness.
    expect(harnessNeed(ready("fx"))).toBe("none");
    expect(harnessNeed(ready("durable", "hermes", "fx"))).toBe("none");
  });

  test("each supported harness other than Pi: only OpenBots is warned about", () => {
    expect([...SUPPORTED_HARNESSES]).toEqual(["pi", "codex", "claude", "opencode", "grok", "cursor"]);
    for (const r of SUPPORTED_HARNESSES.filter((r) => r !== "pi")) {
      expect(harnessNeed(ready(r))).toBe("pi");
      expect(harnessNeed(ready(r, "hermes"))).toBe("pi");
      const text = harnessSetupText("pi", only(r));
      expect(text.lead).toBe("OpenBots needs Pi installed to work.");
      expect(text.detail).not.toContain("OpenBuild also needs");
    }
    expect(harnessSetupText("pi", only("codex", "claude")).detail).toBe("Threads can still run on Codex and Claude Code; only OpenBots waits for Pi.");
  });

  test("Pi installed: no popup, whatever else is or isn't (a missing provider is the bots chat's notice)", () => {
    expect(harnessNeed(ready("pi"))).toBeUndefined();
    expect(harnessNeed(ready("pi", "durable"))).toBeUndefined();
    expect(harnessNeed(ready(...ALL))).toBeUndefined();
  });

  test("unknown is not missing: loading, a failed request, or no answer for Pi show nothing", () => {
    expect(harnessNeed({ state: "loading" })).toBeUndefined();
    expect(harnessNeed({ state: "error", error: "Failed to fetch" })).toBeUndefined();
    // An answer that doesn't mention Pi says nothing about it either.
    expect(harnessNeed({ state: "ready", runtimes: {} })).toBeUndefined();
    expect(harnessNeed({ state: "ready", runtimes: { codex: { installed: true } } })).toBeUndefined();
  });

  test("the dialog: labelled, described, the Pi mark, Install and Not now, the installer it runs", () => {
    const html = view({ need: "pi", runtimes: only("claude") });
    expect(html).toMatch(/role="dialog" aria-modal="true" aria-labelledby="([^"]+)-title" aria-describedby="\1-body"/);
    expect(html).toMatch(/<h2 id="[^"]+-title" class="hs-title">Pi isn&#x27;t installed<\/h2>/);
    expect(html).toContain('<svg viewBox="-47 -47 654 654" width="64" height="64"');
    expect(html).toMatch(/<button type="button" class="btn btn-primary" data-autofocus="true">Install Pi<\/button>/);
    expect(html).toContain(">Not now</button>");
    expect(html).toMatch(/aria-label="Close"/);
    expect(html).toContain('<code class="hs-command">install pi</code>');
    expect(html).toContain("https://pi.dev");
    // Another harness is there, so the Settings → Harnesses way out is only for "none".
    expect(html).not.toContain("Settings → Harnesses");
    const none = view({ need: "none", runtimes: only() });
    expect(none).toContain("No coding harness is installed");
    expect(none).toContain("See Settings → Harnesses");
  });

  test("while installing: busy, the button locked, and progress announced", () => {
    const html = view({ need: "none", runtimes: only(), install: { phase: "installing" } });
    expect(html).toContain('aria-busy="true"');
    expect(html).toMatch(/role="status" aria-live="polite">.*Installing Pi on imac…/);
    expect(html).toMatch(/<button type="button" class="btn btn-primary" data-autofocus="true" disabled="">.*Installing…<\/button>/);
    expect(view({ need: "none", runtimes: only(), install: { phase: "checking" } })).toContain("Checking that Pi is installed…");
  });

  test("a failure says why and offers Try again; success says next is a provider", () => {
    const failed = view({ need: "pi", runtimes: only("codex"), install: { phase: "failed", error: "Pi's installer failed (exit code 1)." } });
    expect(failed).toMatch(/role="alert">.*Pi&#x27;s installer failed \(exit code 1\)\./);
    expect(failed).toMatch(/data-autofocus="true">Try again<\/button>/);
    const done = view({ need: "none", runtimes: only("pi"), install: { phase: "done" } });
    expect(done).toContain("Pi is installed");
    expect(done).toContain("connect a provider");
    expect(done).toContain(">Connect a provider</button>");
    expect(done).toContain(">Done</button>");
    expect(done).not.toContain("Install Pi");
  });

  /** Runs the install with scripted answers; returns every phase it went through. */
  async function run(steps: { start?: () => Promise<{ job: string }>; code?: number | "gone"; installed: boolean | (() => Promise<boolean>) }) {
    const phases: Phase[] = [];
    let started = 0;
    const end = await installPiAndCheck({
      start: steps.start ?? (async () => (started++, { job: "job-1" })),
      follow: async (id) => {
        expect(id).toBe("job-1");
        return steps.code === "gone" ? undefined : { code: steps.code ?? 0 };
      },
      check: typeof steps.installed === "function" ? steps.installed : async () => steps.installed as boolean,
      onPhase: (p) => phases.push(p),
    });
    return { end, phases: phases.map((p) => p.phase), started };
  }

  test("install recovery: a failure, then Try again, ends installed and checked", async () => {
    const first = await run({ code: 1, installed: false });
    expect(first.end).toEqual({ phase: "failed", error: "Pi's installer failed (exit code 1)." });
    expect(first.phases).toEqual(["installing", "checking", "failed"]);
    const retry = await run({ code: 0, installed: true });
    expect(retry.end).toEqual({ phase: "done" });
    expect(retry.phases).toEqual(["installing", "checking", "done"]);
  });

  test("install: only the server finding pi counts, whatever the installer says", async () => {
    // Exit 0, but no pi where OpenBuild looks: not done.
    expect((await run({ code: 0, installed: false })).end).toMatchObject({ phase: "failed", error: expect.stringContaining("still can't find the pi program") });
    // The installer failed but Pi is there anyway (installed from a terminal meanwhile): done.
    expect((await run({ code: 1, installed: true })).end).toEqual({ phase: "done" });
    // The job stream is gone: the check decides.
    expect((await run({ code: "gone", installed: true })).end).toEqual({ phase: "done" });
  });

  test("install: a refused start says the server's reason, and an already-installed Pi is done", async () => {
    const busy = await run({ start: async () => { throw new Error("A maintenance job is already running"); }, installed: false });
    expect(busy.end).toEqual({ phase: "failed", error: "A maintenance job is already running" });
    const already = await run({ start: async () => { throw new Error("Pi is already installed"); }, installed: true });
    expect(already.end).toEqual({ phase: "done" });
    const unreachable = await run({ installed: async () => { throw new Error("Failed to fetch"); } });
    expect(unreachable.end).toEqual({ phase: "failed", error: "Couldn't check whether Pi is installed now: Failed to fetch" });
  });

  test("closing it is remembered per server for this tab, so it doesn't come back in a loop", () => {
    expect(wasDismissed("server-a")).toBe(false);
    rememberDismissed("server-a");
    expect(wasDismissed("server-a")).toBe(true);
    expect(wasDismissed("server-b")).toBe(false);
  });
}
