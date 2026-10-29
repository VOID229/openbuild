import { expect, test } from "bun:test";
import { HtmlDelivery } from "../server/htmlDelivery";
import { HTML_RENDER_MAX_BYTES } from "../shared/htmlRender";
import type { StreamEvent } from "../shared/types";

function parse(text: string, chunk = text.length) {
  const events: StreamEvent[] = [];
  const delivery = new HtmlDelivery(e => events.push(e), () => "page-id");
  for (let i = 0; i < text.length; i += chunk) delivery.push({ t: "text", v: text.slice(i, i + chunk) });
  delivery.flush();
  return events.reduce<StreamEvent[]>((out, event) => {
    const last = out.at(-1);
    if (event.t === "text" && last?.t === "text") last.v += event.v;
    else out.push({ ...event });
    return out;
  }, []);
}
const source = 'Before\n```openbuild-html\n<title>Chart</title><script>console.log(1)</script><p>Hi</p>\n```\nAfter';
test("publishes the same sandbox input regardless of runtime stream chunk boundaries", () => {
  const expected = parse(source);
  for (const size of [1, 2, 7, 32]) expect(parse(source, size)).toEqual(expected);
  expect(expected).toEqual([
    { t: "text", v: "Before\n" },
    { t: "tool", id: "page-id", name: "html_render", args: { title: "Chart", html: '<title>Chart</title><script>console.log(1)</script><p>Hi</p>\n' }, status: "done" },
    { t: "text", v: "After" },
  ]);
});
test("source examples, incomplete documents and rejected pages never execute", () => {
  for (const text of [
    '```html\n<p>Source</p>\n```',
    '````markdown\n```openbuild-html\n<p>Example</p>\n```\n````',
    '```openbuild-html\n<p>Interrupted',
    '```openbuild-html\n<style>body{height:100vh}</style>\n```',
    '```openbuild-html\n' + 'x'.repeat(HTML_RENDER_MAX_BYTES + 2) + '\n```',
  ]) {
    const events = parse(text);
    expect(events.every(e => e.t === "text")).toBe(true);
    expect(events.map(e => e.t === "text" ? e.v : "").join("")).toBe(text);
  }
});
test("flushes interrupted pages before terminal and tool events", () => {
  const events: StreamEvent[] = [];
  const p = new HtmlDelivery(e => events.push(e));
  p.push({ t: "text", v: '```openbuild-html\n<p>partial' });
  p.push({ t: "done", finish: "aborted" });
  expect(events).toEqual([{ t: "text", v: '```openbuild-html\n<p>partial' }, { t: "done", finish: "aborted" }]);
});
