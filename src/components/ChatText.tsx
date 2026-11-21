import { Fragment, useMemo, type ReactNode } from "react";
import { chatBlocks, type ChatAlign, type ChatBlock, type ChatToken } from "../lib/chatText";
import { WebLink } from "./Linkify";

type Render = (text: string) => ReactNode;

const same: Render = (text) => text;

function Tokens({ tokens, plain, code }: { tokens: ChatToken[]; plain: Render; code: Render }) {
  return (
    <>
      {tokens.map((t) =>
        t.kind === "code" ? (
          <code key={t.at}>{code(t.text)}</code>
        ) : t.kind === "bold" ? (
          <strong key={t.at}>
            <Tokens tokens={t.tokens} plain={plain} code={code} />
          </strong>
        ) : t.kind === "italic" ? (
          <em key={t.at}>
            <Tokens tokens={t.tokens} plain={plain} code={code} />
          </em>
        ) : t.kind === "link" ? (
          <WebLink key={t.at} url={t.url}>{t.text}</WebLink>
        ) : (
          <Fragment key={t.at}>{plain(t.text)}</Fragment>
        ),
      )}
    </>
  );
}

/** A table cell's alignment, as its column's text-align. */
const alignStyle = (align: ChatAlign) => (align ? { textAlign: align } : undefined);

function Block({ block: b, plain, code }: { block: ChatBlock; plain: Render; code: Render }) {
  if (b.kind === "fence")
    return (
      <pre className="chat-code">
        <code>{code(b.text)}</code>
      </pre>
    );
  if (b.kind === "item")
    return (
      <span className="chat-item">
        <span className="chat-item-mark">{b.marker}</span>
        <span className="chat-item-body">
          <Tokens tokens={b.tokens} plain={plain} code={code} />
        </span>
      </span>
    );
  if (b.kind === "heading")
    return (
      <div className="chat-h">
        <Tokens tokens={b.tokens} plain={plain} code={code} />
      </div>
    );
  if (b.kind === "rule") return <div className="chat-rule" role="separator" />;
  if (b.kind === "quote")
    return (
      <blockquote className="chat-quote">
        <Blocks blocks={b.blocks} plain={plain} code={code} />
      </blockquote>
    );
  if (b.kind === "table")
    // Wide tables scroll sideways inside the bubble; the bubble itself keeps its width.
    return (
      <div className="chat-table-wrap">
        <table className="chat-table">
          <thead>
            <tr>
              {b.head.map((cell, c) => (
                <th key={c} style={alignStyle(b.align[c])}>
                  <Tokens tokens={cell} plain={plain} code={code} />
                </th>
              ))}
            </tr>
          </thead>
          {b.rows.length ? (
            <tbody>
              {b.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c} style={alignStyle(b.align[c])}>
                      <Tokens tokens={cell} plain={plain} code={code} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          ) : null}
        </table>
      </div>
    );
  return (
    <span className="chat-p">
      <Tokens tokens={b.tokens} plain={plain} code={code} />
    </span>
  );
}

function Blocks({ blocks, plain, code }: { blocks: ChatBlock[]; plain: Render; code: Render }) {
  return (
    <>
      {blocks.map((b) => (
        <Block key={b.at} block={b} plain={plain} code={code} />
      ))}
    </>
  );
}

export function ChatText({ text, plain = same, code = same }: { text: string; plain?: Render; code?: Render }) {
  const blocks = useMemo(() => chatBlocks(text), [text]);
  if (blocks.length === 1 && blocks[0]!.kind === "text") return <Tokens tokens={blocks[0]!.tokens} plain={plain} code={code} />;
  return <Blocks blocks={blocks} plain={plain} code={code} />;
}
