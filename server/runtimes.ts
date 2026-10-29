// Which thread runtimes this device can run: a quick look for each one's installed program (no
// spawning), so the new-thread runtime picker can grey out the ones a device doesn't have.
import type { RuntimeAvailability, ThreadRuntime } from "../shared/types";
import { packageRoot, piBin } from "./pi/install";
import { FX_INSTALL, fxBin } from "./fx/install";
import { CODEX_INSTALL, codexBin } from "./codex/install";
import { CURSOR_INSTALL, cursorBin } from "./cursor/install";
import { CLAUDE_INSTALL, claudeBin } from "./claude/install";
import { OPENCODE_INSTALL, opencodeBin } from "./opencode-agent/install";

const PI_INSTALL = "curl -fsSL https://pi.dev/install.sh | sh";

export function runtimes(): Record<ThreadRuntime, RuntimeAvailability> {
  const pi = !!piBin();
  return {
    pi: { installed: pi, install: PI_INSTALL },
    // Durable runs Pi's SDK in-process, so it needs Pi's package, not just a `pi` on PATH.
    durable: { installed: pi && !!packageRoot(), install: PI_INSTALL },
    claude: { installed: !!claudeBin(), install: CLAUDE_INSTALL },
    codex: { installed: !!codexBin(), install: CODEX_INSTALL },
    cursor: { installed: !!cursorBin(), install: CURSOR_INSTALL },
    fx: { installed: !!fxBin(), install: FX_INSTALL },
    opencode: { installed: !!opencodeBin() || !!process.env.OPENCODE_SERVER_URL, install: OPENCODE_INSTALL },
  };
}
