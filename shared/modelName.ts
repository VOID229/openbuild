// A model's name read from its id, for when no listing names it: Pi failing, a listing that no longer
// has it, a screen that never got one. "vercel-ai-gateway/zai/glm-5.3-flash" reads "GLM 5.3 Flash",
// never the raw id. A listing's own name always wins over this (src/lib/bots/models.ts).

/** Words a model's id spells in lower case that its makers write in capitals. */
const CAPITALS = new Set(["ai", "api", "gpt", "glm", "llm", "moe", "oss", "qwq", "vl"]);

const word = (w: string) => (CAPITALS.has(w.toLowerCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1));

/**
 * "openrouter/anthropic/claude-sonnet-5-5" → "Claude Sonnet 5.5", "openai-codex/gpt-6.1-sol" →
 * "GPT 6.1 Sol", "openrouter/deepseek/deepseek-r1:free" → "Deepseek R1 (free)". Only the model's
 * own part counts: the provider and the maker before it are its icon's and provider line's to say.
 */
export function readableModelName(id: string): string {
  const own = id.slice(id.lastIndexOf("/") + 1).trim();
  const [base = "", ...tags] = own.split(":");
  const words: string[] = [];
  for (const w of base.split(/[-_\s]+/).filter(Boolean)) {
    // A version split by dashes ("5-5") reads as one ("5.5"); a long number (a date) stays apart.
    const last = words.at(-1);
    if (last && /^\d{1,2}(\.\d+)*$/.test(last) && /^\d{1,2}$/.test(w)) words[words.length - 1] = `${last}.${w}`;
    else words.push(w);
  }
  const name = words.map(word).join(" ");
  const tag = tags.filter(Boolean).join(":");
  return (tag ? `${name} (${tag})` : name) || own || id;
}
