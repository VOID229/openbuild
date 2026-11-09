import { expect, test } from "bun:test";

// Rendered in a subprocess so the component's module graph cannot leak into other tests.
test("Pi settings offer New for skills and prompts but not extensions, keeping extension row controls", async () => {
  const script = `
    import { createElement } from "react";
    import { renderToStaticMarkup } from "react-dom/server";
    import { resolve } from "node:path";
    const { ResourceList } = await import(resolve("src/components/PiSettings.tsx"));
    const item = (kind) => ({ id: kind + "-a", kind, name: "my-" + kind, description: "", enabled: true, builtin: false, files: ["/x/index.ts"] });
    const render = (kind) => renderToStaticMarkup(createElement(ResourceList, { kind, items: [item(kind)], onChanged() {}, onEdit() {}, busy: false }));
    console.log(JSON.stringify({ extension: render("extension"), skill: render("skill"), prompt: render("prompt") }));
    process.exit(0);
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`${stdout}\n${stderr}`);
  const html = JSON.parse(stdout.trim().split("\n").at(-1)!) as Record<string, string>;

  expect(html.extension).not.toContain("New extension");
  // The list is a page of its own (Pi agent / Extensions): its title is the page's, the list says what they are.
  expect(html.extension).toContain("Tools, commands and providers Pi loads.");
  expect(html.extension).toContain("my-extension");
  expect(html.extension).toContain("Edit my-extension");
  expect(html.extension).toContain("Remove my-extension");
  expect(html.extension).toContain("Turn off my-extension");

  expect(html.skill).toContain("New skill");
  expect(html.prompt).toContain("New prompt template");
});
