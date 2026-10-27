// The model picker's provider rail otherwise follows the order Pi lists models, so a second account
// (openai-codex-2, claude-code-2) can end up at the bottom, far from the first one. This plugin
// declares the group order outright: Codex → Claude → OpenCode → Grok → OpenRouter, with each
// "(2)" group beside its first account. Groups it doesn't name keep Pi's order after these, and
// Custom stays last.
//
// The ids are provider *groups*, so the groups move but their names and icons still come from the
// provider (and from plugins like pi-claude and codex-multi that define the second-account groups).
// styles.css carries the same order as a CSS fallback, so the rail looks right on the running
// server too (this host-side list only applies once OpenBuild restarts).
export default {
  providerOrder: [
    "openai-codex",
    "openai-codex-2",
    "claude",
    "claude-code-2",
    "opencode",
    "opencode-go",
    "xai",
    "openrouter",
  ],
};
