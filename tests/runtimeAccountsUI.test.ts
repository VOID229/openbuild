import { expect, test } from "bun:test";

// Module mocks stay in a subprocess so they cannot replace other tests' real store.
test("runtime account settings keep store snapshots stable with no saved accounts", async () => {
  const script = `
    import { mock } from "bun:test";
    import { createElement } from "react";
    import { renderToStaticMarkup } from "react-dom/server";
    import { resolve } from "node:path";
    const state = { settings: {}, updateSettings() {} };
    let checks = 0;
    mock.module(resolve("src/lib/store.ts"), () => ({
      useStore(selector) {
        const first = selector(state);
        const second = selector(state);
        if (!Object.is(first, second)) throw new Error("Store snapshot changes without a state update");
        checks++;
        return first;
      },
      threadDevice: () => undefined,
    }));
    mock.module(resolve("src/components/ModelSelect.tsx"), () => ({ OptionSelect: () => null }));
    const { RuntimeAccounts } = await import(resolve("src/components/RuntimeAccounts.tsx"));
    for (const runtime of ["claude", "codex", "cursor"]) {
      const html = renderToStaticMarkup(createElement(RuntimeAccounts, { runtime }));
      if (!html.includes("Add account")) throw new Error(runtime + " account form did not render");
    }
    state.settings.runtimeAccounts = [{ id: "work", name: "Work", runtime: "claude", configDir: "/tmp/claude-work" }];
    const html = renderToStaticMarkup(createElement(RuntimeAccounts, { runtime: "claude" }));
    if (!html.includes("claude auth login")) throw new Error("Saved account did not render");
    if (checks < 8) throw new Error("Store selectors were not exercised");
    console.log("stable account snapshots");
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`${stdout}\n${stderr}`);
  expect(stdout.trim()).toBe("stable account snapshots");
});
