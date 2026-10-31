import { describe, expect, test } from "bun:test";
import { generateText, promptImages, threadTranscript } from "../src/lib/naming";
import { useStore } from "../src/lib/store";
import type { Attachment } from "../shared/types";
import type { Detection, Message } from "../src/lib/types";

const message = (id: number, role: Message["role"], content: string): Message => ({ id: String(id), role, content, createdAt: id });

describe("threadTranscript", () => {
  test("is empty for a thread with nothing to read", () => {
    expect(threadTranscript({ messages: [] })).toBe("");
    expect(threadTranscript({ messages: [message(1, "assistant", "  ")] })).toBe("");
  });

  test("labels turns in order, with shell commands and attachment-only prompts", () => {
    const attached = { ...message(3, "user", ""), attachments: [{ name: "shot.png" }] } as Message;
    const messages = [message(1, "user", "fix the build"), message(2, "assistant", "done"), attached, message(4, "shell", "bun test")];
    expect(threadTranscript({ messages })).toBe("User: fix the build\n\nAssistant: done\n\nUser: shot.png\n\nUser: $ bun test");
  });

  test("keeps the opening prompt and the latest messages when the budget runs out", () => {
    const messages = [message(1, "user", "start"), ...[2, 3, 4, 5].map((i) => message(i, "assistant", `reply ${i}`.padEnd(90, ".")))];
    const out = threadTranscript({ messages }, 220);
    expect(out.startsWith("User: start\n\n[…]\n\nAssistant: reply 4")).toBe(true);
    expect(out).toContain("reply 5");
    expect(out).not.toContain("reply 3");
  });

  test("clips a long message so it can't take the whole budget", () => {
    const messages = [message(1, "user", "start"), message(2, "assistant", "x".repeat(5000)), message(3, "user", "latest")];
    const out = threadTranscript({ messages });
    expect(out).toContain("…");
    expect(out).toContain("latest");
    expect(out.length).toBeLessThan(1600);
  });
});

const image = (name: string): Attachment => ({ id: name, name, mime: "image/png", dataUrl: "data:image/png;base64,QUJD", size: 3 });

describe("promptImages", () => {
  test("picks images when the prompt says little or nothing", () => {
    expect(promptImages({ content: "", attachments: [image("a.png")] }).map((a) => a.name)).toEqual(["a.png"]);
    expect(promptImages({ content: "  fix this?\n", attachments: [image("a.png")] })).toHaveLength(1);
  });

  test("skips them when the prompt can name the thread", () => {
    expect(promptImages({ content: "make the sidebar collapse on narrow windows", attachments: [image("a.png")] })).toEqual([]);
  });

  test("keeps only readable images, and a few of them", () => {
    const file: Attachment = { id: "n", name: "notes.txt", mime: "text/plain", dataUrl: "", text: "hi", size: 2 };
    const stripped = { ...image("gone.png"), dataUrl: "" };
    expect(promptImages({ content: "", attachments: [file, stripped, image("a.png")] }).map((a) => a.name)).toEqual(["a.png"]);
    expect(promptImages({ content: "", attachments: ["a", "b", "c", "d"].map(image) })).toHaveLength(3);
  });
});

describe("generateText with images", () => {
  test("asks a model that can see first, and gives it the images", async () => {
    const reasoning = { efforts: [] };
    const models = [{ id: "a/text", input: ["text"], reasoning }, { id: "a/vision", input: ["text", "image"], reasoning }] as unknown as Detection["models"];
    const before = useStore.getState();
    useStore.setState({
      detection: { pi: { models } as Detection },
      settings: { ...before.settings, naming: { enabled: true, models: [{ plan: "pi", id: "a/text", effort: "low" }, { plan: "pi", id: "a/vision", effort: "low" }] } },
    });
    const bodies: any[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return Response.json({ text: "Terminal Screenshot" });
    }) as unknown as typeof fetch;
    try {
      const title = await generateText({ system: "s", content: "image.png", images: [image("image.png")], sessionId: "t", clean: (s) => s });
      expect(title).toBe("Terminal Screenshot");
      expect(bodies).toHaveLength(1);
      expect(bodies[0].model).toBe("a/vision");
      expect(bodies[0].images).toEqual([{ data: "QUJD", mimeType: "image/png" }]);
      expect(bodies[0].prompt).toContain("attached images");
    } finally {
      globalThis.fetch = realFetch;
      useStore.setState({ detection: before.detection, settings: before.settings });
    }
  });
});

describe("generateText on other runtimes", () => {
  test("sends the runtime, its model and a supported effort", async () => {
    const before = useStore.getState();
    const codex = { plan: "codex", status: "valid", checkedAt: 1, models: [{ id: "codex/gpt", input: ["text"], reasoning: { efforts: ["low", "high"] } }] } as unknown as Detection;
    useStore.setState({ codexModels: { "": codex }, settings: { ...before.settings, naming: { enabled: true, models: [{ plan: "codex", id: "codex/gpt", effort: "off" }] } } });
    const bodies: any[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return Response.json({ text: "Named" });
    }) as unknown as typeof fetch;
    try {
      expect(await generateText({ system: "s", content: "c", sessionId: "t", clean: (s) => s })).toBe("Named");
      expect(bodies[0]).toMatchObject({ runtime: "codex", model: "codex/gpt", effort: "low" });
    } finally {
      globalThis.fetch = realFetch;
      useStore.setState({ codexModels: before.codexModels, settings: before.settings });
    }
  });
});
