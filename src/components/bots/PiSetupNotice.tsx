// The primary bot's chat before Pi can run it. The server holds the welcome back until Pi is
// installed and has a provider with models (server/bots/service.ts greetOnFirstOpen), and says what's
// missing; this shows it, with the way to fix it, and asks again when the user comes back from there.
import { RefreshCw, Settings as SettingsIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { checkSetup, useRemoteWorkspace } from "../../lib/bots/store";
import { PI_SITE } from "../../lib/harnessSetup";
import type { Bot, PiSetup } from "../../lib/bots/types";
import { useStore } from "../../lib/store";
import { WebLink } from "../Linkify";
import { BotAvatar } from "./BotAvatar";

export { PI_SITE };

/** What the notice says for each missing piece. Exported for its tests. */
export function setupText(setup: PiSetup, botName: string, host?: string): { title: string; hint: string; action?: { label: string; section: "pi" | "keys" } } {
  const after = `${botName} will say hello once both are ready.`;
  const where = host ? ` Set it up on ${host}, where these bots run.` : "";
  if (setup.need === "missing")
    return {
      title: "Pi isn't installed",
      hint: `OpenBots needs Pi installed and a provider connected to work. ${host ? "" : "Install Pi from Settings → Pi, then connect a provider. "}${after}${where}`,
      action: host ? undefined : { label: "Install Pi in Settings", section: "pi" },
    };
  if (setup.need === "no-provider")
    return {
      title: "Pi is installed but no provider is connected yet",
      hint: `OpenBots needs Pi installed and a provider connected to work. ${host ? "" : "Sign in to an account or add an API key in Settings → Providers. "}${after}${where}`,
      action: host ? undefined : { label: "Connect a provider", section: "keys" },
    };
  return {
    title: "Pi is installed but OpenBots couldn't reach it",
    hint: `${setup.error} OpenBots needs Pi installed and a provider connected to work. ${after}${where}`,
    action: host ? undefined : { label: "Open Settings → Pi", section: "pi" },
  };
}

/** Looking again on every window focus would ask Pi for its models each time; once in a while is plenty. */
const FOCUS_GAP = 5_000;

export function PiSetupNotice({ setup, bot }: { setup: PiSetup; bot: Bot }) {
  const host = useRemoteWorkspace();
  const openSettings = useStore((s) => s.openSettings);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const [checking, setChecking] = useState(false);
  const wasOpen = useRef(settingsOpen);
  const lastLook = useRef(0);
  const look = () => {
    lastLook.current = Date.now();
    return checkSetup();
  };

  // Back from Settings, or from a terminal in another window: look again. Pi installed or signed in
  // from Settings tells the server by itself; this covers what it can't see happen.
  useEffect(() => {
    if (host) return;
    if (wasOpen.current && !settingsOpen) void look();
    wasOpen.current = settingsOpen;
    const onFocus = () => Date.now() - lastLook.current > FOCUS_GAP && void look();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [settingsOpen, host]);

  const text = setupText(setup, bot.name, host);
  return (
    <div className="bm-setup" role="status">
      <BotAvatar look={bot.look} size={44} alive={false} />
      <div className="bm-setup-title">{text.title}</div>
      <p className="bm-setup-hint">{text.hint}</p>
      <div className="bm-setup-actions">
        {text.action && (
          <button type="button" className="btn btn-sm btn-primary" onClick={() => openSettings(text.action!.section)}>
            <SettingsIcon size={14} />
            {text.action.label}
          </button>
        )}
        {!host && (
          <button
            type="button"
            className="btn btn-sm"
            disabled={checking}
            onClick={async () => {
              setChecking(true);
              await look();
              setChecking(false);
            }}
          >
            <RefreshCw size={14} className={checking ? "spin" : undefined} />
            {checking ? "Checking…" : "Check again"}
          </button>
        )}
      </div>
      <p className="bm-setup-foot">
        New to Pi? <WebLink url={PI_SITE}>pi.dev</WebLink> has what it is and how it works.
      </p>
    </div>
  );
}
