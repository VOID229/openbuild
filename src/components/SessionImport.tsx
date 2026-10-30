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

const answer = (runtimes: ImportRuntime[]) =>
  fetch(apiUrl(undefined, "/api/session-import"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runtimes }) })
    .then(async (r) => {
      const body = await r.json().catch(() => null);
      if (!r.ok) throw new Error(body?.error ?? `Request failed (HTTP ${r.status})`);
      return body as { imported: Partial<Record<ImportRuntime, number>>; errors: Partial<Record<ImportRuntime, string>> };
    });

const threads = (n: number) => `${n} thread${n === 1 ? "" : "s"}`;

export function SessionImport() {
  const [counts, setCounts] = useState<Partial<Record<ImportRuntime, number>>>();
  const [picked, setPicked] = useState<Set<ImportRuntime>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    let live = true;
    fetch(apiUrl(undefined, "/api/session-import"))
      .then((r) => (r.ok ? r.json() : undefined))
      .then((offer: { pending: boolean; runtimes: Partial<Record<ImportRuntime, number>> } | undefined) => {
        if (!live || !offer?.pending) return;
        setCounts(offer.runtimes);
        setPicked(new Set(ORDER.filter((r) => offer.runtimes[r])));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (counts && dialog.current && !dialog.current.open) dialog.current.showModal();
  }, [counts]);

  if (!counts) return null;
  const close = () => {
    dialog.current?.close();
    setCounts(undefined);
  };
  const submit = async (runtimes: ImportRuntime[]) => {
    setBusy(true);
    setError(undefined);
    try {
      const done = await answer(runtimes);
      const failed = Object.entries(done.errors).map(([r, e]) => `${runtimeName(r as ThreadRuntime)}: ${e}`);
      if (failed.length) {
        setError(`Some threads couldn't be imported. ${failed.join(" · ")}`);
        setCounts({});
      } else close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const runtimes = ORDER.filter((r) => counts[r]);
  const total = runtimes.filter((r) => picked.has(r)).reduce((n, r) => n + counts[r]!, 0);
  // After a partial failure the offer is already answered: only closing is left.
  const answered = !runtimes.length;

  return (
    <dialog
      ref={dialog}
      className="confirm-dialog session-import"
      aria-labelledby="session-import-title"
      aria-describedby="session-import-description"
      onCancel={(e) => e.preventDefault()}
    >
      <h2 id="session-import-title">Bring in your other threads?</h2>
      {answered ? (
        <p id="session-import-description" className="session-import-error">{error}</p>
      ) : (
        <>
          <p id="session-import-description">
            OpenBuild found threads you had in other coding agents on this computer. Imported threads show up in the sidebar, and you can keep going in them here. This is only asked once.
          </p>
          <ul className="pi-list session-import-list">
            {runtimes.map((r) => (
              <li key={r} className="rt-row">
                <div className="pi-row">
                  <span className="rt-icon" aria-hidden>
                    <RuntimeIcon runtime={r} size={16} />
                  </span>
                  <span className="pi-row-text">
                    <span className="pi-row-name">{runtimeName(r)}</span>
                    <span className="pi-row-desc">{threads(counts[r]!)}</span>
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
      )}
      <div className="confirm-actions">
        {answered ? (
          <button type="button" className="btn btn-sm btn-primary" onClick={close} autoFocus>
            Close
          </button>
        ) : (
          <>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void submit([])}>
              Skip
            </button>
            <button type="button" className="btn btn-sm btn-primary" disabled={busy || !total} onClick={() => void submit(runtimes.filter((r) => picked.has(r)))} autoFocus>
              {busy ? <><Spinner size={13} /> Importing…</> : total ? `Import ${threads(total)}` : "Import"}
            </button>
          </>
        )}
      </div>
    </dialog>
  );
}
