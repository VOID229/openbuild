import type { Profile } from "./types";

/** Only populated text fields are model context; avatars never leave the UI here. */
export function profileContext(profile: Profile): string {
  const lines: string[] = [];
  const { name, location, language, bio } = profile;
  if (name.trim()) lines.push(`The user's name is ${name.trim()}.`);
  if (location.trim()) lines.push(`The user is located in ${location.trim()}.`);
  if (language.trim()) lines.push(`The user speaks: ${language.trim()}. Reply in the language the user writes in.`);
  if (bio.trim()) lines.push(`About the user, including their preferences (follow them):\n${bio.trim()}`);
  return lines.join("\n");
}

/** A fresh snapshot on each turn, including steers, without replacing native agent instructions. */
export function withProfileContext(message: string, profile: Profile): string {
  const context = profileContext(profile);
  return context ? `[OpenBuild user profile context (current)]\n${context}\n[End OpenBuild user profile context]\n\n${message}` : message;
}
