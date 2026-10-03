// A convex-test instance of the app with its components registered. The components ship
// registration helpers that rely on Vite's import.meta.glob; under Bun, glob their sources here.
import { Glob } from "bun";
import { convexTest } from "convex-test";
import { dirname, join } from "node:path";

const appModules = Object.fromEntries(
  [...new Glob("**/*.ts").scanSync(join(import.meta.dir, "../convex"))].map((f) => [`../convex/${f}`, () => import(`../convex/${f}`)]),
);

function componentModules(pkg: string) {
  const dir = join(dirname(require.resolve(`${pkg}/package.json`)), "src/component");
  const files = [...new Glob("**/*.ts").scanSync(dir)].filter((f) => !f.endsWith(".test.ts"));
  return { dir, modules: Object.fromEntries(files.map((f) => [`./component/${f}`, () => import(join(dir, f))])) };
}

export async function appTest() {
  const schema = (await import("../convex/schema")).default;
  const t = convexTest(schema, appModules);
  for (const [name, pkg] of [
    ["rateLimiter", "@convex-dev/rate-limiter"],
    ["rateLimiter/batchWorker", "@convex-dev/batch-worker"],
  ] as const) {
    const { dir, modules } = componentModules(pkg);
    t.registerComponent(name, (await import(join(dir, "schema.ts"))).default, modules);
  }
  return t;
}
