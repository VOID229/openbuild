import { loadChats } from "../lib/db";
import { useStore } from "../lib/store";
import { adoptDiscoveredChats } from "../lib/chat";
// The one-time offer to bring in threads from the native runtimes (server/sessionImport.ts). The
// server decides whether to offer it and records the answer, so it shows once per OpenBuild, not per
// browser. It can't be dismissed without an answer: Skip is an answer too.
import { useEffect, useRef, useState } from "react";
import type { ThreadRuntime } from "../../shared/types";
import { apiUrl } from "../lib/devices";
import { runtimeName } from "../lib/runtimes";
import { Spinner, Toggle } from "./primitives";
import { RuntimeIcon } from "./Workspace";

type ImportRuntime = "claude" | "codex" | "cursor" | "opencode";
const ORDER: ImportRuntime[] = ["claude", "codex", "cursor", "opencode"];

const answer = (runtimes: ImportRuntime[], all: boolean) =>
  fetch(apiUrl(undefined, "/api/session-import"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runtimes, all }) })
    .then(async (r) => {
      const body = await r.json().catch(() => null);
      if (!r.ok) throw new Error(body?.error ?? `Request failed (HTTP ${r.status})`);
      return body as { imported: Partial<Record<ImportRuntime, number>>; errors: Partial<Record<ImportRuntime, string>> };
    });

const threads = (n: number) => `${n} thread${n === 1 ? "" : "s"}`;

export function SessionImport() {
  const [counts, setCounts] = useState<Partial<Record<ImportRuntime, number>>>();
  const [picked, setPicked] = useState<Set<ImportRuntime>>(new Set());
  const [scanning, setScanning] = useState(false);
  const [all, setAll] = useState(false);
  const stopped = useRef(false);
  const seenRuntimes = useRef(new Set<ImportRuntime>());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    let live = true;
    stopped.current = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const seen = seenRuntimes.current;
    const check = async () => {
      try {
        const res = await fetch(apiUrl(undefined, `/api/session-import?progress${all ? "&all" : ""}`));
        if (!res.ok) throw new Error("Import discovery unavailable");
        const offer = await res.json() as { pending: boolean; scanning?: boolean; errors?: Partial<Record<ImportRuntime, string>>; runtimes: Partial<Record<ImportRuntime, number>> };
        if (!live || stopped.current) return;
        setScanning(!!offer.scanning);
        const failures = Object.entries(offer.errors ?? {}).map(([r, message]) => `${runtimeName(r as ThreadRuntime)}: ${message}`);
        if (failures.length) setError(`Couldn't inspect some sessions. ${failures.join(" · ")}`);
        setCounts(offer.pending ? offer.runtimes : undefined);
        setPicked(previous => {
          const next = new Set(previous);
          for (const r of ORDER) if (offer.runtimes[r] && !seen.has(r)) { next.add(r); seen.add(r); }
          return next;
        });
        if (offer.scanning) timer = setTimeout(check, 750);
      } catch { if (live && !stopped.current) timer = setTimeout(check, 2000); }
    };
    void check();
    return () => { live = false; clearTimeout(timer); };
  }, [all]);

  useEffect(() => {
    if (counts && dialog.current && !dialog.current.open) dialog.current.showModal();
  }, [counts]);

  if (!counts) return null;
  const close = () => {
    dialog.current?.close();
    setCounts(undefined);
  };
  const submit = async (runtimes: ImportRuntime[]) => {
    stopped.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const done = await answer(runtimes, all);
      if (Object.values(done.imported).some(n => n > 0)) {
        const before = new Map(useStore.getState().chats.map(c => [c.id, c]));
        // Show imported rows now instead of waiting for the next five-second discovery poll.
        void loadChats().then(chats => adoptDiscoveredChats(chats, before)).catch(() => {});
      }
      const failed = Object.entries(done.errors).map(([r, e]) => `${runtimeName(r as ThreadRuntime)}: ${e}`);
      if (failed.length) {
        setError(`Some threads couldn't be imported. ${failed.join(" · ")}`);
      } else close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const runtimes = ORDER.filter((r) => counts[r]);
  const total = runtimes.filter((r) => picked.has(r)).reduce((n, r) => n + counts[r]!, 0);
  return (
    <dialog
      ref={dialog}
      className="confirm-dialog session-import"
      aria-labelledby="session-import-title"
      aria-describedby="session-import-description"
      onCancel={(e) => e.preventDefault()}
    >
      <h2 id="session-import-title">Bring in your other threads?</h2>
      <>
          <p id="session-import-description">
            Bring in threads from other coding agents on this computer. Imported threads show up in the sidebar, and you can keep going in them here. This is only asked once.
          </p>
          {scanning && <p role="status"><Spinner size={13} /> Looking for threads…</p>}
          <div className="pi-row">
            <span className="pi-row-text"><span className="pi-row-name">Include older threads</span><span className="pi-row-desc">{all ? "All available sessions" : "Newest 100 sessions per runtime. Older originals stay in their coding app."}</span></span>
            <Toggle checked={all} disabled={busy || scanning} label="Include older threads" onChange={setAll} />
          </div>
          <ul className="pi-list session-import-list">
            {runtimes.map((r) => (
              <li key={r} className="rt-row">
                <div className="pi-row">
                  <span className="rt-icon" aria-hidden>
                    <RuntimeIcon runtime={r} size={16} />
                  </span>
                  <span className="pi-row-text">
                    <span className="pi-row-name">{runtimeName(r)}</span>
                    <span className="pi-row-desc">Up to {threads(counts[r]!)}</span>
                  </span>
                  <Toggle
                    checked={picked.has(r)}
                    disabled={busy}
                    label={`Import ${runtimeName(r)} threads`}
                    onChange={(on) => setPicked((s) => { const next = new Set(s); if (on) next.add(r); else next.delete(r); return next; })}
                  />
                </div>
              </li>
            ))}
          </ul>
          {error && <p className="session-import-error">{error}</p>}
      </>
      <div className="confirm-actions">
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void submit([])}>
              Skip
            </button>
            <button type="button" className="btn btn-sm btn-primary" disabled={busy || scanning || !total} onClick={() => void submit(runtimes.filter((r) => picked.has(r)))} autoFocus>
              {busy ? <><Spinner size={13} /> Importing…</> : total ? `${error ? "Retry import" : "Import"} ${threads(total)}` : "Import"}
            </button>
      </div>
    </dialog>
  );
}
