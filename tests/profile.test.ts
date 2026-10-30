import { expect, test } from "bun:test";
import { profileContext, withProfileContext } from "../src/lib/profile";

const empty = { name: "", bio: "", location: "", language: "" };

test("empty and whitespace-only profiles add no context", () => {
  for (const profile of [empty, { name: "  ", bio: "\n", location: "\t", language: " " }]) {
    expect(profileContext(profile)).toBe("");
    expect(withProfileContext("hello", profile)).toBe("hello");
  }
});

test("all profile text fields are trimmed and shared, without the avatar", () => {
  const profile = { name: " Gal ", bio: " Keep it concise.\nUse examples. ", location: " Israel ", language: " Hebrew ", avatar: "private-image" };
  const context = profileContext(profile);
  expect(context).toContain("The user's name is Gal.");
  expect(context).toContain("The user is located in Israel.");
  expect(context).toContain("The user speaks: Hebrew.");
  expect(context).toContain("Keep it concise.\nUse examples.");
  expect(context).not.toContain("private-image");
  expect(withProfileContext("hello", profile)).toEndWith("\n\nhello");
});

test("individual populated fields do not add instructions for empty fields", () => {
  expect(profileContext({ ...empty, name: "Gal" })).toBe("The user's name is Gal.");
  expect(profileContext({ ...empty, location: "Israel" })).toBe("The user is located in Israel.");
  expect(profileContext({ ...empty, bio: "Be brief" })).toBe("About the user, including their preferences (follow them):\nBe brief");
});
