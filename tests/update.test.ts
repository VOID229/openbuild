import { describe, expect, test } from "bun:test";
import { buildOf, buildPath } from "../src/lib/update";

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
