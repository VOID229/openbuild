// A reserved assistant-output fence lets runtimes without tool injection publish pages too.
// Convert before journaling: live viewers and replay consume identical html_render events.
import { HTML_LAYOUT_GUIDE, HTML_THEME_GUIDE, HTML_RENDER_MAX_BYTES, HTML_RENDER_MAX_TITLE, htmlProblem } from "../shared/htmlRender";
import type { StreamEvent } from "../shared/types";

export const HTML_DELIVERY_NOTE = `[OpenBuild display instructions: For charts, diagrams, mockups and interactive demos requested by the user, show a self-contained HTML document in a fenced block whose language is openbuild-html. This reserved block publishes a sandboxed interactive page in the thread. Ordinary html fences remain source code. Include a <title> for the page name. Inline styles and scripts work; CDN libraries work. Do not start a server or write a file just to display a page. Do not use this format when the user asks to see source code. ${HTML_LAYOUT_GUIDE} ${HTML_THEME_GUIDE}]\n\n`;

/** Line-based parsing keeps normal code fences intact, including quoted examples of this format.
 * Buffers at most one page; incomplete/invalid pages stay visible as source, never execute. */
export class HtmlDelivery {
  private line = "";
  private page = "";
  private opening = "";
  private outer = "";
  private passthrough = false;
  private pendingText = "";
  constructor(private send: (event: StreamEvent) => void, private id = () => `html-${crypto.randomUUID()}`) {}
  private text(v: string) { this.pendingText += v; }
  private drain() { if (this.pendingText) { this.send({ t: "text", v: this.pendingText }); this.pendingText = ""; } }
  private accept(line: string) {
    const bare = line.replace(/\r?\n$/, "");
    if (this.opening) {
      if (/^ {0,3}`{3,}\s*$/.test(bare) && bare.trim().length >= this.opening.trimStart().match(/^`+/)![0].length) {
        const html = this.page;
        const problem = htmlProblem(html);
        if (problem) this.text(this.opening + html + line);
        else {
          const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim().slice(0, HTML_RENDER_MAX_TITLE) || "Page";
          this.drain();
          this.send({ t: "tool", id: this.id(), name: "html_render", args: { html, title }, status: "done" });
        }
        this.opening = this.page = "";
      } else {
        this.page += line;
        if (this.page.length > HTML_RENDER_MAX_BYTES) {
          this.text(this.opening + this.page);
          this.outer = this.opening.trimStart().match(/^`+/)![0];
          this.opening = this.page = "";
        }
      }
      return;
    }
    const fence = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(bare);
    if (!this.outer && fence && fence[2]![0] === "`" && fence[3]!.trim() === "openbuild-html") {
      this.opening = line;
      return;
    }
    if (fence) {
      if (!this.outer) this.outer = fence[2]!;
      else if (fence[2]![0] === this.outer[0] && fence[2]!.length >= this.outer.length && !fence[3]!.trim()) this.outer = "";
    }
    this.text(line);
  }
  push(event: StreamEvent) {
    if (event.t !== "text") {
      // Text segments separated by tools/thinking are independent Markdown blocks.
      this.flush();
      this.send(event);
      return;
    }
    for (const char of event.v) {
      if (this.passthrough) {
        this.text(char);
        if (char === "\n") this.passthrough = false;
        continue;
      }
      this.line += char;
      if (char === "\n") { this.accept(this.line); this.line = ""; }
      else if (!this.opening && !/^ {0,3}(?:`.*|~.*)?$/.test(this.line)) {
        this.text(this.line); this.line = ""; this.passthrough = true;
      }
      else if (this.line.length > HTML_RENDER_MAX_BYTES) {
        this.text(this.opening + this.page + this.line);
        this.opening = this.page = this.line = "";
        this.passthrough = true;
      }
    }
    this.drain();
  }
  flush() {
    if (this.line) { this.accept(this.line); this.line = ""; }
    if (this.opening) { this.text(this.opening + this.page); this.opening = this.page = ""; }
    this.drain();
  }
}
