// OpenBuild: the entry bots' Pi loads. OpenBuild writes a one-line wrapper per set of Claude logins
// (see ../claude.ts) that calls this with them, so every login is its own provider.
import { getClaudeStatus } from "./claude-cli.ts";
import { claudeCodeEnv, createClaudeCodeProvider, type ClaudeCodeProfile } from "./provider.ts";

/** The part of Pi's ExtensionAPI this uses; pi-coding-agent itself isn't an OpenBuild dependency. */
interface ExtensionApi {
  registerProvider(provider: ReturnType<typeof createClaudeCodeProvider>): void;
  registerCommand(
    name: string,
    command: { description: string; handler: (args: string, ctx: { signal?: AbortSignal; ui: { notify(text: string, level: "info" | "warning" | "error"): void } }) => Promise<void> },
  ): void;
}

export default function claudeCodeExtension(pi: ExtensionApi, profiles: ClaudeCodeProfile[] = [{}]): void {
  const seen = new Set<string>();
  const unique = profiles.filter((p) => {
    const id = p.id ?? "claude-code";
    return !seen.has(id) && !!seen.add(id);
  });
  for (const profile of unique) pi.registerProvider(createClaudeCodeProvider(profile));

  pi.registerCommand("claude-code-status", {
    description: "Check the Claude Code executable and each subscription login",
    handler: async (_args, ctx) => {
      for (const profile of unique) {
        const env = profile.configDir || profile.command
          ? { ...process.env, ...(profile.configDir ? { PI_CLAUDE_CODE_CONFIG_DIR: profile.configDir, CLAUDE_CONFIG_DIR: profile.configDir } : {}), ...(profile.command ? { PI_CLAUDE_CODE_COMMAND: profile.command } : {}) }
          : claudeCodeEnv();
        const status = await getClaudeStatus(env, ctx.signal);
        const name = profile.name ?? "Claude Code";
        if (!status.available || !status.loggedIn) ctx.ui.notify(`${name}: ${status.detail ?? "not ready"}`, "warning");
        else ctx.ui.notify(`${name}: logged in${status.plan ? ` (${status.plan})` : ""}`, "info");
      }
    },
  });
}

export { createClaudeCodeProvider } from "./provider.ts";
export { streamClaudeCode } from "./stream.ts";
