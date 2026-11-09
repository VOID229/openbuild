// Settings → Devices → Pair device: what `openbuild pair --client` does, from the app. The other
// device shows a code with `openbuild pair --host`; this server finds it (on the tailnet or LAN, or
// at a typed address), trades the code for a token and keeps it. The browser never sees the token.
import { CircleAlert } from "lucide-react";
import { useEffect, useId, useReducer, useRef, type KeyboardEvent } from "react";
import type { Device } from "../../shared/types";
import { PairError, pairDevice } from "../lib/pi";
import { cx } from "../lib/ui";
import { Spinner } from "./primitives";

export type PairMode = "tailscale" | "lan";

export interface PairState {
  mode: PairMode;
  code: string;
  address: string;
  /** The address field takes the code field's place once nothing was found, or when asked for. Both
   *  values are kept across the switch: the address only says where to look, the code is always needed. */
  showAddress: boolean;
  pairing: boolean;
  error?: string;
}

export type PairAction =
  | { type: "mode"; mode: PairMode }
  | { type: "code"; code: string }
  | { type: "address"; address: string }
  | { type: "show-address" }
  | { type: "show-code" }
  | { type: "need-code" }
  | { type: "start" }
  | { type: "cancelled" }
  | { type: "failed"; error: string; reason?: string };

export const initialPair = (): PairState => ({ mode: "tailscale", code: "", address: "", showAddress: false, pairing: false });

export function pairReducer(state: PairState, action: PairAction): PairState {
  // Nothing changes under a running search, except it ending.
  if (state.pairing && action.type !== "cancelled" && action.type !== "failed") return state;
  switch (action.type) {
    case "mode":
      return { ...state, mode: action.mode, error: undefined };
    case "code":
      return { ...state, code: action.code.toUpperCase().slice(0, 40), error: undefined };
    case "address":
      return { ...state, address: action.address.slice(0, 255), error: undefined };
    case "show-address":
      return { ...state, showAddress: true };
    case "show-code":
      return { ...state, showAddress: false };
    case "need-code":
      return { ...state, showAddress: false, error: "Enter the pairing code from the other device too." };
    case "start":
      return { ...state, pairing: true, error: undefined };
    case "cancelled":
      return { ...state, pairing: false, error: undefined };
    case "failed":
      // Nobody there: offer the address. A wrong code: back to the code.
      return { ...state, pairing: false, error: action.error, showAddress: action.reason === "not-found" || (state.showAddress && action.reason !== "rejected") };
  }
}

const NETWORK: Record<PairMode, string> = { tailscale: "tailnet", lan: "network" };

export const searchingLabel = (state: PairState) =>
  state.address.trim() ? `Looking for it at ${state.address.trim()}…` : `Looking for a device on your ${NETWORK[state.mode]}…`;

/** What Pair sends, or nothing while the code is missing: an address never stands in for it. */
export const pairRequest = (state: PairState) =>
  state.code.trim() ? { mode: state.mode, code: state.code.trim(), address: state.address.trim() || undefined } : undefined;

interface ViewProps {
  state: PairState;
  dispatch: (action: PairAction) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

/** The form itself, without effects, so every state renders the same in tests. */
export function PairDeviceView({ state, dispatch, onSubmit, onCancel }: ViewProps) {
  const id = useId();
  const field = useRef<HTMLInputElement>(null);
  const shownAddress = useRef(state.showAddress);
  // Move to whichever field just took the other's place.
  useEffect(() => {
    if (state.showAddress !== shownAddress.current) field.current?.focus();
    shownAddress.current = state.showAddress;
  }, [state.showAddress]);
  const needsCode = !state.code.trim();

  const modes: PairMode[] = ["tailscale", "lan"];
  const onModeKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    const next = modes[(modes.indexOf(state.mode) + 1) % modes.length]!;
    dispatch({ type: "mode", mode: next });
    (e.currentTarget.parentElement?.querySelector(`[data-mode="${next}"]`) as HTMLElement | null)?.focus();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLFormElement>) => {
    if (e.key !== "Escape") return;
    // Escape closes this form (or stops its search), not the whole Settings dialog.
    e.stopPropagation();
    e.preventDefault();
    onCancel();
  };

  return (
    <form
      className="pair-form"
      aria-labelledby={`${id}-title`}
      aria-busy={state.pairing}
      noValidate
      onKeyDown={onKeyDown}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <h4 id={`${id}-title`} className="pair-title">
        Pair a device
      </h4>
      <div className="pair-field">
        <span className="pair-label" id={`${id}-mode`}>
          Connect over
        </span>
        <div className="segmented" role="radiogroup" aria-labelledby={`${id}-mode`}>
          {modes.map((mode) => (
            <button
              type="button"
              key={mode}
              data-mode={mode}
              className="segment"
              role="radio"
              aria-checked={state.mode === mode}
              tabIndex={state.mode === mode ? 0 : -1}
              disabled={state.pairing}
              onKeyDown={onModeKey}
              onClick={() => dispatch({ type: "mode", mode })}
            >
              {mode === "lan" ? "LAN" : "Tailscale"}
            </button>
          ))}
        </div>
      </div>
      <p className="pair-help" id={`${id}-help`}>
        On the other device, run <code>openbuild pair --host</code> in a terminal and choose {state.mode === "lan" ? "LAN" : "Tailscale"} when it asks.
        It shows a code like <code>ABCD-2345</code>, valid for 15 minutes and for one device. Both devices need to be on the same{" "}
        {NETWORK[state.mode]}.
      </p>
      {state.showAddress ? (
        <label key="address" className="pair-field" htmlFor={`${id}-address`}>
          <span className="pair-label">Its address</span>
          <input
            ref={field}
            id={`${id}-address`}
            className="input"
            value={state.address}
            placeholder={state.mode === "lan" ? "192.168.1.20:3100" : "laptop.tailnet.ts.net"}
            aria-describedby={`${id}-address-help`}
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            inputMode="url"
            enterKeyHint="go"
            maxLength={255}
            readOnly={state.pairing}
            onChange={(e) => dispatch({ type: "address", address: e.target.value })}
          />
          <span className="pair-hint" id={`${id}-address-help`}>
            Host name or IP, with <code>:port</code> if not 3100. Leave empty to search again.
          </span>
        </label>
      ) : (
        <label key="code" className="pair-field" htmlFor={`${id}-code`}>
          <span className="pair-label">Pairing code</span>
          <input
            ref={field}
            id={`${id}-code`}
            className="input input-code"
            value={state.code}
            placeholder="ABCD-2345"
            aria-describedby={state.address.trim() ? `${id}-help ${id}-code-at` : `${id}-help`}
            aria-invalid={!!state.error}
            autoFocus
            autoComplete="off"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
            maxLength={40}
            readOnly={state.pairing}
            onChange={(e) => dispatch({ type: "code", code: e.target.value })}
          />
          {state.address.trim() && (
            <span className="pair-hint" id={`${id}-code-at`}>
              It looks for the device at <code>{state.address.trim()}</code>.
            </span>
          )}
        </label>
      )}
      <button type="button" className="pair-link" disabled={state.pairing} onClick={() => dispatch({ type: state.showAddress ? "show-code" : "show-address" })}>
        {state.showAddress ? "Enter code" : "Enter its address instead"}
      </button>
      {state.error && (
        <p className="pi-error pair-error" role="alert">
          <CircleAlert size={13} /> {state.error}
        </p>
      )}
      <p className={cx("pair-status", state.pairing && "is-shown")} role="status" aria-live="polite">
        {state.pairing && (
          <>
            <Spinner size={13} /> {searchingLabel(state)}
          </>
        )}
      </p>
      <div className="pair-actions">
        <button type="button" className="btn btn-sm" onClick={onCancel}>
          {state.pairing ? "Stop" : "Cancel"}
        </button>
        <button type="submit" className="btn btn-sm btn-primary" disabled={state.pairing || (needsCode && !state.showAddress)}>
          {state.pairing ? "Pairing…" : needsCode ? (state.showAddress ? "Next" : "Pair") : state.error ? "Try again" : "Pair"}
        </button>
      </div>
    </form>
  );
}

/** The form with its search: a running search is cancelled by Stop, Escape, or closing Settings. */
export function PairDevice({ onPaired, onClose }: { onPaired: (device: Device) => void | Promise<void>; onClose: () => void }) {
  const [state, dispatch] = useReducer(pairReducer, undefined, initialPair);
  const search = useRef<AbortController>(undefined);
  useEffect(() => () => search.current?.abort(), []);

  const submit = async () => {
    if (state.pairing) return;
    const request = pairRequest(state);
    // From the address, Pair without a code goes to the code first.
    if (!request) return dispatch({ type: "need-code" });
    const ctrl = new AbortController();
    search.current = ctrl;
    dispatch({ type: "start" });
    try {
      const device = await pairDevice(request, ctrl.signal);
      // Paired, even if Stop came too late: the device is saved on the server either way.
      await onPaired(device);
    } catch (err) {
      if (ctrl.signal.aborted) dispatch({ type: "cancelled" });
      else dispatch({ type: "failed", error: (err as Error).message || "Pairing failed", reason: err instanceof PairError ? err.reason : undefined });
    } finally {
      if (search.current === ctrl) search.current = undefined;
    }
  };

  const cancel = () => {
    if (search.current) search.current.abort();
    else onClose();
  };

  return <PairDeviceView state={state} dispatch={dispatch} onSubmit={() => void submit()} onCancel={cancel} />;
}
