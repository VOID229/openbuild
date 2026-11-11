// Remote Control works differently in each vendor's CLI, so OpenBuild describes it per harness
// instead of offering one toggle. Only Claude Code takes a per-thread choice.
import type { ThreadRuntime } from "./types";

/** thread: opted into per session. machine: one daemon per device. account: set in the vendor's own settings. */
export type RemoteControlScope = "thread" | "machine" | "account";

export const REMOTE_CONTROL: Partial<Record<ThreadRuntime, { scope: RemoteControlScope; note: string }>> = {
  claude: {
    scope: "thread",
    note: "Off unless chosen when the thread starts. Continue it from claude.ai/code or the Claude app while OpenBuild keeps it open. Needs a claude.ai sign-in, not an API key or custom endpoint.",
  },
  codex: {
    scope: "machine",
    note: "Codex pairs one app-server daemon per machine (`codex remote-control start`, or the switch in OpenBuild's Settings → General). OpenBuild's Codex threads run in their own app-server, so the daemon can't drive them while they run.",
  },
  cursor: {
    scope: "account",
    note: "Cursor sets Remote Control in your Cursor account and team settings. Its CLI has no switch for it, so OpenBuild can't turn it on or off for a thread.",
  },
};

/** Whether a thread on this harness can be started with Remote Control on. */
export const remoteControlPerThread = (runtime: ThreadRuntime | undefined) => !!runtime && REMOTE_CONTROL[runtime]?.scope === "thread";
