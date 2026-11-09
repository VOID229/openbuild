// The startup popup for a server without Pi: OpenBots needs it, and with no supported harness at
// all OpenBuild can't run threads either. Detection is the connected server's own (/api/runtimes),
// asked once at startup; Install runs the same installer as Settings → Pi, only when clicked, and
// asks the server again afterwards. Pi installed but signed in nowhere is the bots chat's notice.
import { Check, CircleAlert, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { harnessNeed, installedHarnesses, installPiAndCheck, PI_SITE, rememberDismissed, SUPPORTED_HARNESSES, useHarnessSetupOpen, wasDismissed, type Availability, type HarnessNeed, type InstallPhase } from "../lib/harnessSetup";
import { installPi, runtimeAvailability } from "../lib/pi";
import { config } from "../lib/runtime";
import { loadRuntimeStatuses } from "../lib/runtimeStatus";
import { runtimeName } from "../lib/runtimes";
import { useStore, type SettingsSection } from "../lib/store";
import { usePresence } from "../lib/ui";
import { WebLink } from "./Linkify";
import { JobLog, useJob } from "./PiSettings";
import { IconButton, PiMark, Spinner } from "./primitives";

const PI_INSTALL = "curl -fsSL https://pi.dev/install.sh | sh";

/** "Codex", "Codex and Cursor", "Pi, Codex or Cursor". */
function phrase(items: string[], last: "and" | "or"): string {
  if (items.length < 2) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} ${last} ${items[items.length - 1]}`;
}

/** What the popup says, for each need. Exported for its tests. */
export function harnessSetupText(need: HarnessNeed, runtimes: Availability, machine?: string): { title: string; lead: string; detail: string } {
  const where = machine ?? "this server";
  const lead = "OpenBots needs Pi installed to work.";
  if (need === "pi") {
    const others = installedHarnesses(runtimes).map(runtimeName);
    return { title: "Pi isn't installed", lead, detail: `Threads can still run on ${phrase(others, "and")}; only OpenBots waits for Pi.` };
  }
  const hermes = runtimes.hermes?.installed ? " Hermes on its own isn't enough." : "";
  return {
    title: "No coding harness is installed",
    lead,
    detail: `OpenBuild also needs at least one of ${phrase(SUPPORTED_HARNESSES.map(runtimeName), "or")} to run threads, and none of them is installed on ${where}.${hermes} Installing Pi covers both.`,
  };
}

export interface HarnessSetupViewProps {
  need: HarnessNeed;
  runtimes: Availability;
  machine?: string;
  install: InstallPhase;
  job?: ReturnType<typeof useJob>;
  onInstall: () => void;
  onClose: () => void;
  onSettings: (section: SettingsSection) => void;
}

/** The dialog's content and buttons, without its portal or focus handling, so tests can render it. */
export function HarnessSetupView({ need, runtimes, machine, install, job, onInstall, onClose, onSettings }: HarnessSetupViewProps) {
  const id = useId();
  const text = harnessSetupText(need, runtimes, machine);
  const busy = install.phase === "installing" || install.phase === "checking";
  const command = runtimes.pi?.install ?? PI_INSTALL;
  return (
    <div className="modal hs" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-body`} aria-busy={busy || undefined} tabIndex={-1}>
      <IconButton className="modal-close" label="Close" tooltip={false} onClick={onClose}>
        <X size={16} />
      </IconButton>
      <div className="hs-mark" data-done={install.phase === "done" || undefined} aria-hidden>
        <PiMark size={64} />
        {install.phase === "done" && <span className="hs-mark-badge"><Check size={14} strokeWidth={3} /></span>}
      </div>
      {install.phase === "done" ? (
        <>
          <h2 id={`${id}-title`} className="hs-title">Pi is installed</h2>
          <div id={`${id}-body`} className="hs-body" role="status">
            <p>OpenBuild found Pi on {machine ?? "this server"}. Next, connect a provider so Pi has models to run OpenBots with.</p>
          </div>
          <div className="hs-actions">
            <button type="button" className="btn btn-primary" data-autofocus onClick={() => onSettings("keys")}>Connect a provider</button>
            <button type="button" className="btn" onClick={onClose}>Done</button>
          </div>
        </>
      ) : (
        <>
          <h2 id={`${id}-title`} className="hs-title">{text.title}</h2>
          <div id={`${id}-body`} className="hs-body">
            <p className="hs-lead">{text.lead}</p>
            <p>{text.detail}</p>
          </div>
          <div className="hs-status" role="status" aria-live="polite">
            {install.phase === "installing" && <><Spinner size={13} /> Installing Pi on {machine ?? "this server"}…</>}
            {install.phase === "checking" && <><Spinner size={13} /> Checking that Pi is installed…</>}
          </div>
          {install.phase === "failed" && (
            <p className="hs-error" role="alert">
              <CircleAlert size={15} aria-hidden />
              <span>{install.error}</span>
            </p>
          )}
          {/* Live output while it runs; after a failure the alert says why and the output folds under it. */}
          {job && busy && <JobLog job={job} />}
          {job && install.phase === "failed" && job.lines.length > 0 && (
            <details className="hs-log">
              <summary>Show the installer's output</summary>
              <pre className="pi-job-log">{job.lines.join("\n")}</pre>
            </details>
          )}
          <div className="hs-actions">
            <button type="button" className="btn btn-primary" data-autofocus disabled={busy} onClick={onInstall}>
              {busy ? <><Spinner size={13} /> Installing…</> : install.phase === "failed" ? "Try again" : "Install Pi"}
            </button>
            <button type="button" className="btn" onClick={onClose}>Not now</button>
          </div>
          <p className="hs-foot">
            Install runs Pi's installer on {machine ?? "this server"}:
            <code className="hs-command">{command}</code>
            New to Pi? <WebLink url={PI_SITE}>pi.dev</WebLink> has what it is.
            {need === "none" && (
              <>
                {" "}Prefer another harness? <button type="button" className="link-btn" onClick={() => onSettings("runtimes")}>See Settings → Harnesses</button>.
              </>
            )}
          </p>
        </>
      )}
    </div>
  );
}

const FOCUSABLE = 'button:not(:disabled), a[href], input:not([type="hidden"]), [tabindex]:not([tabindex="-1"])';

export function HarnessSetup() {
  const [runtimes, setRuntimes] = useState<Availability>({});
  const [need, setNeed] = useState<HarnessNeed>();
  const [server, setServer] = useState<{ id?: string; machine?: string }>({});
  const [closed, setClosed] = useState(false);
  const [install, setInstall] = useState<InstallPhase>({ phase: "idle" });
  const settingsOpen = useStore((s) => s.settingsOpen);
  const openSettings = useStore((s) => s.openSettings);
  const job = useJob(() => {});

  // Once, at startup: only a confirmed answer from this server counts. Loading or an error shows nothing.
  useEffect(() => {
    let live = true;
    void config.then(async (c) => {
      if (!live || c.mode === "hosted" || wasDismissed(c.serverId)) return;
      setServer({ id: c.serverId, machine: c.machine });
      const found = await runtimeAvailability().catch(() => undefined);
      if (!live || !found) return;
      setRuntimes(found);
      setNeed(harnessNeed({ state: "ready", runtimes: found }));
    });
    return () => { live = false; };
  }, []);

  // Back from Settings with the popup still waiting: Pi may have been installed there.
  const wasOpen = useRef(settingsOpen);
  useEffect(() => {
    const back = wasOpen.current && !settingsOpen;
    wasOpen.current = settingsOpen;
    if (!back || !need || closed || install.phase !== "idle") return;
    void runtimeAvailability().then((found) => {
      setRuntimes(found);
      if (!harnessNeed({ state: "ready", runtimes: found })) setClosed(true);
    }, () => {});
  }, [settingsOpen]);

  const open = !!need && !closed && !settingsOpen;
  const { mounted, visible } = usePresence(open, 220);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    useHarnessSetupOpen.setState({ open });
    if (!open) return;
    const restore = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      if (e.key === "Tab" && root.current) {
        // Keep focus inside the dialog.
        const items = root.current.querySelectorAll<HTMLElement>(FOCUSABLE);
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      useHarnessSetupOpen.setState({ open: false });
      restore?.focus?.();
    };
  }, [open]);

  // The main button takes focus on opening and after each step, so the keyboard follows the flow.
  useEffect(() => {
    if (open && mounted && install.phase !== "installing" && install.phase !== "checking") root.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus({ preventScroll: true });
  }, [open, mounted, install.phase]);

  function close() {
    setClosed(true);
    rememberDismissed(server.id);
  }

  const start = () =>
    void installPiAndCheck({
      start: () => installPi(),
      follow: (id) => job.follow(id),
      check: async () => {
        const found = await runtimeAvailability();
        setRuntimes(found);
        return found.pi?.installed === true;
      },
      onPhase: setInstall,
    }).then((end) => {
      if (end.phase !== "done") return;
      // Everything else that shows Pi's state: pickers, Settings and Home. The bots' welcome hears it
      // from the server, whose install drops Pi's model cache (server/bots/runner.ts).
      const s = useStore.getState();
      void loadRuntimeStatuses(true).catch(() => {});
      void s.loadPiStatus(true).catch(() => {});
      void s.refreshDetection();
    });

  if (!mounted || !need) return null;
  return createPortal(
    <div ref={root} className="modal-root hs-root" data-state={visible ? "open" : "closed"}>
      <div className="modal-backdrop" onClick={install.phase === "installing" ? undefined : close} aria-hidden />
      <HarnessSetupView
        need={need}
        runtimes={runtimes}
        machine={server.machine}
        install={install}
        job={job}
        onInstall={start}
        onClose={close}
        onSettings={(section) => {
          close();
          openSettings(section);
        }}
      />
    </div>,
    document.body,
  );
}
