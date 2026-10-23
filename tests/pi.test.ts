import { describe, expect, test } from "bun:test";
import { compareVersions } from "../server/pi/install";
import type { ModelInfo } from "../shared/types";
import { matchCommands } from "../src/lib/commands";
import { providerGroups, searchProviderGroups } from "../src/lib/modelSearch";

const model = (provider: string, id: string, name: string): ModelInfo => ({
  id: `${provider}/${id}`,
  name,
  provider,
  protocol: "chat",
  reasoning: { efforts: [], mode: "effort", toggle: false },
  input: ["text"],
});

describe("Pi versions", () => {
  test("compares dotted versions numerically", () => {
    expect(compareVersions("1.10.0", "1.9.2")).toBe(1);
    expect(compareVersions("1.3.0", "1.3.0")).toBe(0);
    expect(compareVersions("1.2", "1.2.1")).toBe(-1);
  });
});

describe("Pi model search", () => {
  const models = [
    model("fireworks", "accounts/fireworks/models/deepseek-v4p1-flash", "DeepSeek V4.1 Flash"),
    model("xai", "grok-4.7", "Grok 4.7"),
    model("openai-codex", "gpt-6.1-sol", "GPT-6.1 Sol"),
  ];

  test("groups by provider in Pi's order", () => {
    expect(providerGroups(models).map((g) => g.provider)).toEqual(["fireworks", "xai", "openai-codex"]);
  });

  test("a provider word narrows to that provider", () => {
    const groups = searchProviderGroups(models, "xai grok");
    expect(groups.map((g) => g.provider)).toEqual(["xai"]);
    expect(groups[0]!.models[0]!.name).toBe("Grok 4.7");
  });

  test("providers Pi doesn't ship with share one Custom group, listed last", () => {
    const custom = [{ ...model("genesis", "code-fast", "Genesis code"), custom: true }, ...models, { ...model("glm-local", "glm-5.3", "GLM 5.3"), custom: true }];
    const groups = providerGroups(custom);
    expect(groups.map((g) => g.provider)).toEqual(["fireworks", "xai", "openai-codex", "custom"]);
    expect(groups[3]!.models.map((m) => m.name)).toEqual(["Genesis code", "GLM 5.3"]);
    expect(searchProviderGroups(custom, "custom glm").flatMap((g) => g.models.map((m) => m.name))).toEqual(["GLM 5.3"]);
  });

  test("without a query, lists only the selected provider", () => {
    expect(searchProviderGroups(models, "", "openai-codex").flatMap((g) => g.models.map((m) => m.name))).toEqual(["GPT-6.1 Sol"]);
  });
});

describe("slash commands", () => {
  const cmds = [
    { name: "commit", source: "extension" as const },
    { name: "compact", source: "openbuild" as const },
    { name: "skill:find-skills", source: "skill" as const },
  ];

  test("prefix matches come first", () => {
    expect(matchCommands(cmds, "com").map((c) => c.name)).toEqual(["commit", "compact"]);
  });

  test("an empty query lists everything", () => {
    expect(matchCommands(cmds, "")).toHaveLength(3);
  });
});
