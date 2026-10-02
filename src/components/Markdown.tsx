import { Check, Copy } from "lucide-react";
import { marked } from "marked";
import { memo, useMemo, useRef, useState, type ComponentProps } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { copyText, cx } from "../lib/ui";

const remarkPlugins: ComponentProps<typeof ReactMarkdown>["remarkPlugins"] = [remarkGfm, remarkMath];
const rehypePlugins: ComponentProps<typeof ReactMarkdown>["rehypePlugins"] = [
  [rehypeKatex, { throwOnError: false, strict: false }],
  [rehypeHighlight, { detect: false }],
];

function CodeBlock({ children, ...props }: ComponentProps<"pre">) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const child = Array.isArray(children) ? children[0] : children;
  const className: string = (child as { props?: { className?: string } })?.props?.className ?? "";
  const lang = /language-([\w+#-]+)/.exec(className)?.[1];
  const copy = async () => {
    await copyText(ref.current?.innerText.replace(/\n$/, "") ?? "");
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };
  return (
    <div className="code-block">
      <div className="code-head">
        <span>{lang ?? "text"}</span>
        <button type="button" className="code-copy" onClick={copy} aria-label="Copy code">
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre ref={ref} {...props}>
        {children}
      </pre>
    </div>
  );
}

const components: Components = {
  pre: ({ node: _node, ...props }) => <CodeBlock {...props} />,
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
  table: ({ node: _node, ...props }) => (
    <div className="table-wrap">
      <table {...props} />
    </div>
  ),
};

/**
 * Escape currency ("$20", "$5 and $10") so remark-math doesn't read it as inline math, while
 * keeping real math that happens to start with a digit ("$856 - 95 = 761$").
 * A "$<digit>" opens math only if a closing "$" follows on the same line that isn't itself a price.
 */
function escapeCurrency(line: string) {
  let out = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\") {
      out += line.slice(i, i + 2);
      i++;
      continue;
    }
    if (ch !== "$") {
      out += ch;
      continue;
    }
    if (line[i + 1] === "$") {
      // $$ … $$ — copy through to the closing pair.
      const end = line.indexOf("$$", i + 2);
      const stop = end < 0 ? line.length : end + 2;
      out += line.slice(i, stop);
      i = stop - 1;
      continue;
    }
    const close = line.indexOf("$", i + 1);
    const isPrice = /\d/.test(line[i + 1] ?? "") && (close < 0 || /\d/.test(line[close + 1] ?? "") || /\s/.test(line[close - 1] ?? ""));
    if (isPrice) {
      out += "\\$";
      continue;
    }
    // Inline math: copy through to the closing "$".
    const stop = close < 0 ? line.length : close + 1;
    out += line.slice(i, stop);
    i = stop - 1;
  }
  return out;
}

/**
 * Normalise LLM math syntax for remark-math outside of code:
 * \( … \) → $…$, \[ … \] and single-line $$ … $$ paragraphs → display math, currency escaped.
 */
export function prepare(md: string) {
  const parts = md.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part;
      return part
        .replace(/\\\[([\s\S]+?)\\\]/g, (_, m: string) => `\n$$\n${m.trim()}\n$$\n`)
        .replace(/\\\(([\s\S]+?)\\\)/g, (_, m: string) => `$${m.trim()}$`)
        .replace(/^[ \t]*\$\$([^\n$]+)\$\$[ \t]*$/gm, (_, m: string) => `$$\n${m.trim()}\n$$`)
        .split("\n")
        .map(escapeCurrency)
        .join("\n");
    })
    .join("");
}

const Block = memo(function Block({ source }: { source: string }) {
  return (
    <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
      {source}
    </ReactMarkdown>
  );
});

/** Split into top-level blocks so finished blocks stay memoised while the tail streams. */
function splitBlocks(md: string): string[] {
  try {
    const blocks: string[] = [];
    let pending = "";
    for (const token of marked.lexer(md)) {
      if (token.type === "space") {
        pending += token.raw;
        continue;
      }
      // Display math may contain blank lines that the lexer would split; keep $$ … $$ together.
      const open = (pending.match(/^\s*\$\$/gm)?.length ?? 0) % 2 === 1;
      if (open) pending += token.raw;
      else {
        if (pending) blocks.push(pending);
        pending = token.raw;
      }
    }
    if (pending) blocks.push(pending);
    return blocks;
  } catch {
    return [md];
  }
}

export const Markdown = memo(function Markdown({ content, className }: { content: string; className?: string }) {
  const blocks = useMemo(() => splitBlocks(prepare(content)), [content]);
  return (
    <div className={cx("markdown", className)}>
      {blocks.map((b, i) => (
        <Block key={i} source={b} />
      ))}
    </div>
  );
});
