import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareUserPlugins } from "../server/pluginFiles";

test("plugin migration preserves custom copies and never refreshes them after updates", () => {
  const temp = mkdtempSync(join(tmpdir(), "ob-user-plugins-"));
  const bundled = join(temp, "app", "plugins"), user = join(temp, "data", "plugins");
  const plugin = (base: string, name: string, contents: string) => {
    mkdirSync(join(base, name), { recursive: true });
    writeFileSync(join(base, name, "plugin.json"), contents);
  };
  try {
    plugin(bundled, "example", "customized example");
    plugin(bundled, "mine", "my plugin");
    plugin(bundled, "existing", "bundled version");
    plugin(user, "existing", "user version");
    expect(prepareUserPlugins(bundled, user)).toBe(user);
    expect(readFileSync(join(user, "example", "plugin.json"), "utf8")).toBe("customized example");
    expect(readFileSync(join(user, "existing", "plugin.json"), "utf8")).toBe("user version");
    plugin(bundled, "example", "new app version");
    plugin(bundled, "new-example", "new bundled plugin");
    rmSync(join(user, "mine"), { recursive: true });
    prepareUserPlugins(bundled, user);
    expect(readFileSync(join(user, "example", "plugin.json"), "utf8")).toBe("customized example");
    expect(existsSync(join(user, "mine"))).toBe(false);
    expect(existsSync(join(user, "new-example"))).toBe(false);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("a fresh install starts with no plugins", () => {
  const temp = mkdtempSync(join(tmpdir(), "ob-user-plugins-"));
  const user = join(temp, "data", "plugins");
  try {
    prepareUserPlugins(join(temp, "app", "plugins"), user);
    expect(readdirSync(user)).toEqual([".openbuild-initialized"]);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
