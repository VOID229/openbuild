import { afterEach, describe, expect, test } from "bun:test";
import { buildOf, buildPath, watchBuild } from "../src/lib/update";

const base = "http://127.0.0.1:3100/thread-abc";

describe("buildOf", () => {
  test("reads a production build's script", () => {
    expect(buildOf('<script>x</script><script type="module" crossorigin src="/../chunk-z4krfn4n.js"></script>', base)).toBe("/chunk-z4krfn4n.js");
  });

  test("ignores dev builds, which update themselves", () => {
    expect(buildOf('<script type="module" src="/_bun/client/index-0000000091fc9ba6.js"></script>', base)).toBeUndefined();
  });

  test("ignores a page without an app script", () => {
    expect(buildOf("<p>Not found</p>", base)).toBeUndefined();
    expect(buildPath(null, base)).toBeUndefined();
  });
});

describe("watchBuild", () => {
  const page = (build: string) => new Response(`<script type="module" src="/chunk-${build}.js"></script>`);
  const globals = globalThis as unknown as Record<string, unknown>;
  const saved = { document: globals.document, location: globals.location, fetch: globals.fetch, addEventListener: globals.addEventListener, removeEventListener: globals.removeEventListener };
  afterEach(() => { Object.assign(globals, saved); });

  /** A visible tab: returns a way to come back to it, and how many checks it made. */
  function tab(answer: () => Promise<Response>) {
    const listeners = new Set<() => void>();
    let checks = 0;
    Object.assign(globals, {
      document: { visibilityState: "visible", addEventListener: (_: string, fn: () => void) => listeners.add(fn), removeEventListener: (_: string, fn: () => void) => listeners.delete(fn) },
      location: { href: base },
      fetch: () => { checks++; return answer(); },
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    return { comeBack: () => listeners.forEach((fn) => fn()), checks: () => checks };
  }

  test("coming back to a tab mid-restart still finds the new build", async () => {
    let up = false;
    const { comeBack } = tab(async () => { if (!up) throw new TypeError("refused"); return page("new"); });
    let newer = 0;
    const stop = watchBuild("/chunk-old.js", () => newer++, 5);
    comeBack();
    await Bun.sleep(20);
    expect(newer).toBe(0);
    up = true;
    await Bun.sleep(30);
    stop();
    expect(newer).toBe(1);
  });

  test("an answering server is not asked again until the next check", async () => {
    const { comeBack, checks } = tab(async () => page("old"));
    let newer = 0;
    const stop = watchBuild("/chunk-old.js", () => newer++, 5);
    comeBack();
    await Bun.sleep(30);
    stop();
    expect(checks()).toBe(1);
    expect(newer).toBe(0);
  });

  test("stopping ends the retries", async () => {
    const { comeBack, checks } = tab(async () => { throw new TypeError("refused"); });
    const stop = watchBuild("/chunk-old.js", () => {}, 5);
    comeBack();
    await Bun.sleep(1);
    stop();
    const after = checks();
    await Bun.sleep(30);
    expect(checks()).toBe(after);
  });
});
