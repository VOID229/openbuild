import { describe, expect, test } from "bun:test";
import { claudeArgs, claudeInput, claudeResult, codexArgs, cursorArgs, fxArgs, type CompleteRequest } from "../server/textGeneration";

const request: CompleteRequest = { runtime: "claude", model: "claude/haiku", effort: "low", system: "name it", prompt: "the prompt" };

describe("runtime commands", () => {
  test("Claude runs without tools, settings or a saved session", () => {
    const args = claudeArgs(request);
    expect(args).toContain("--no-session-persistence");
    expect(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2)).toEqual(["--tools", ""]);
    expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual(["--model", "haiku"]);
    expect(claudeArgs({ ...request, effort: "off" })).not.toContain("--effort");
  });

  test("Claude gets images as stream-json content", () => {
    const line = JSON.parse(claudeInput({ ...request, images: [{ data: "QUJD", mimeType: "image/png" }] }));
    expect(line.message.content[0].source).toEqual({ type: "base64", media_type: "image/png", data: "QUJD" });
    expect(line.message.content.at(-1)).toEqual({ type: "text", text: "the prompt" });
  });

  test("reads Claude's result and its failures", () => {
    expect(claudeResult('{"type":"system"}\n{"type":"result","is_error":false,"result":"A Title"}\n')).toBe("A Title");
    expect(() => claudeResult('{"type":"result","is_error":true,"result":"no credit"}')).toThrow("no credit");
    expect(() => claudeResult("")).toThrow();
  });

  test("Codex is ephemeral and read-only, with the prompt after its variadic image flag", () => {
    const args = codexArgs({ ...request, model: "codex/gpt", effort: "off" }, ["/t/a.png"]);
    expect(args).toContain("--ephemeral");
    expect(args).toContain("read-only");
    expect(args).toContain("--model");
    expect(args).toContain("gpt");
    expect(args).toContain('model_reasoning_effort="none"');
    expect(args.slice(-4)).toEqual(["--image", "/t/a.png", "--", "the prompt"]);
  });

  test("fx saves nothing and Cursor gets the system text in its prompt", () => {
    const fx = fxArgs({ ...request, model: "fx/grok" }, []);
    expect(fx).toContain("--no-save");
    expect(fx).toContain("grok");
    const cursor = cursorArgs(request, "slug", "/t");
    expect(cursor).toContain("ask");
    expect(cursor.at(-1)).toBe("name it\n\nthe prompt");
  });
});
