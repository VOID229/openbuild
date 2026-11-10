import { afterAll, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

// Run by cloneProject.test.ts in its own process, since cloning saves projects in the data directory.
if (!process.env.OPENBUILD_CLONE_SCENARIO) throw new Error("Run through cloneProject.test.ts: this saves projects.");
const data = process.env.OPENCHAT_DATA_DIR && realpathSync(process.env.OPENCHAT_DATA_DIR);
if (!data || dirname(data) !== realpathSync(tmpdir()) || !basename(data).startsWith("openbuild-clone-")) {
  throw new Error("The clone scenario requires a throwaway openbuild-clone-* data directory. Run cloneProject.test.ts.");
}
const projects = await import("../server/projects");

// A real repository, served over git's dumb HTTP transport (static files), since clones only take network URLs.
const root = realpathSync(mkdtempSync(join(tmpdir(), "openbuild-clone-src-")));
const work = join(root, "work");
mkdirSync(work);
execSync("git init -q -b main && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m init", { cwd: work });
execSync(`git clone -q --bare . ${join(root, "kodbot.git")} && git -C ${join(root, "kodbot.git")} update-server-info`, { cwd: work });
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const file = Bun.file(join(root, decodeURIComponent(new URL(req.url).pathname)));
    return (await file.exists()) ? new Response(file) : new Response("Not found", { status: 404 });
  },
});
const url = `http://127.0.0.1:${server.port}/kodbot.git`;
const dest = realpathSync(mkdtempSync(join(tmpdir(), "openbuild-clone-dest-")));
afterAll(() => {
  server.stop(true);
  rmSync(root, { recursive: true, force: true });
  rmSync(dest, { recursive: true, force: true });
});

const head = (dir: string) => execSync("git log -1 --format=%s", { cwd: dir }).toString().trim();

test("into an existing folder, the clone goes in a subfolder named after the repository", async () => {
  const active = join(dest, "active");
  mkdirSync(active);
  writeFileSync(join(active, "notes.txt"), "already here");
  const project = await projects.cloneProject(url, active);
  expect(project.path).toBe(join(active, "kodbot"));
  expect(project.name).toBe("kodbot");
  expect(head(join(active, "kodbot"))).toBe("init");
  // The folder itself is left as it was, not turned into the clone.
  expect(existsSync(join(active, ".git"))).toBe(false);
  // Again into the same folder: the subfolder is there now, with the clone in it.
  await expect(projects.cloneProject(url, active)).rejects.toThrow(/active\/kodbot already exists and isn't empty/);
});

test("a path that isn't there yet is the clone's own folder, parents made", async () => {
  const exact = join(dest, "new", "app");
  const project = await projects.cloneProject(url, exact);
  expect(project.path).toBe(exact);
  expect(head(exact)).toBe("init");
});

test("an empty subfolder of the repository's name takes the clone", async () => {
  const parent = join(dest, "parent");
  mkdirSync(join(parent, "kodbot"), { recursive: true });
  expect((await projects.cloneProject(url, parent)).path).toBe(join(parent, "kodbot"));
  expect(head(join(parent, "kodbot"))).toBe("init");
});

test("a file where the clone would land is refused, and nothing is cloned", async () => {
  const parent = join(dest, "files");
  mkdirSync(parent);
  writeFileSync(join(parent, "kodbot"), "a file");
  await expect(projects.cloneProject(url, parent)).rejects.toThrow(/already exists and isn't empty/);
});

test("the guard sees where the clone really lands", async () => {
  const parent = join(dest, "guarded");
  mkdirSync(parent);
  const seen: string[] = [];
  await expect(
    projects.cloneProject(url, parent, undefined, (r) => {
      seen.push(r);
      throw new Error("no");
    }),
  ).rejects.toThrow("no");
  expect(seen).toEqual([join(parent, "kodbot")]);
  expect(existsSync(join(parent, "kodbot"))).toBe(false);
});
