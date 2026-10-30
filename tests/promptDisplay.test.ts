import { expect, test } from "bun:test";
import { userVisiblePrompt } from "../shared/promptDisplay";
import { withProfileContext } from "../src/lib/profile";
import { HTML_DELIVERY_NOTE } from "../server/htmlDelivery";

const prompt = "it also happens if i click on the filter then do esc";
const profile = { name: "gal", bio: "private preferences\nMultiple lines", location: "", language: "" };

test("recovered model prompts expose only the user's message, across stacked prefixes", () => {
  const injected = withProfileContext(prompt, profile);
  for (const text of [injected, HTML_DELIVERY_NOTE + injected, injected.replace(prompt, HTML_DELIVERY_NOTE + prompt)]) {
    expect(userVisiblePrompt(text)).toBe(prompt);
    expect(userVisiblePrompt(userVisiblePrompt(text))).toBe(prompt);
  }
});

test("partial context is hidden and context-only prompts are empty", () => {
  expect(userVisiblePrompt("[OpenBuild user profile context (current)]\nprivate")).toBe("");
  expect(userVisiblePrompt("[OpenBuild display instructions: private")).toBe("");
  expect(userVisiblePrompt(withProfileContext("", profile))).toBe("");
});

test("ordinary messages and quoted context examples stay intact", () => {
  for (const text of ["  hello\n\nworld", "Explain [OpenBuild user profile context (current)]", "```\n" + withProfileContext(prompt, profile) + "\n```", "[an ordinary bracketed message]"]) {
    expect(userVisiblePrompt(text)).toBe(text);
  }
});
