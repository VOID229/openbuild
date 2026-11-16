// Updating OpenBuild from the sidebar: the small button beside the running release in either footer.
//
//   ↻ refresh    nothing newer is known. A click checks the installation's track, the wheel turning
//                while it does; the app also checks on its own every few minutes.
//   ↓ download   a newer release is out. Hovering shows what it changes; a click installs it (the
//                server runs `ob update`), the arrow falling and a ring filling step by step.
//   ⟳ restart    it's installed and waits for the server to restart, with a slow halo to say so. A
//                click restarts the server and reloads the page when it's back.
//
// The card over the button says the same in words: the changelog, the step, what went wrong. With a
// mouse it's a tooltip and the click acts. A touch screen has no hover, so there a tap opens the card
// first (so the changelog can be read before installing) and the card carries the button that acts.
// A changelog that doesn't all fit says where it's cut ("…"), and "Show more" opens the card out,
// taller and a bit wider, to the whole of it (scrolling past what the window can hold).
// State and requests are lib/releaseUpdate.ts; the styles are styles.css (.release-update, .release-card).
import { Download, RefreshCw, RotateCw } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { changeText, tagLabel, tagVersion, UPDATE_STEPS, UPDATE_STEP_LABEL } from "../../shared/releaseUpdate";
import { checkRelease, dismissUpdateFailure, installRelease, restartServer, updateView, useReleaseUpdate, useReleaseWatch, type UpdateView } from "../lib/releaseUpdate";
import { GAP, MARGIN, place } from "./Tooltip";

/** As long as any other tooltip waits (Tooltip.tsx). */
const HOVER_DELAY = 450;
/** Long enough to cross from the button to its card. */
const LEAVE_DELAY = 140;
/** How long "You're up to date" stays after a check, unless it's being read. */
const ANSWER_MS = 2600;
/** The most changes a card lists until it's shown more; the rest are counted. */
const CHANGES_LISTED = 6;
const SPIN_MS = 800;
/** The slope a `SPIN_EASE` curve starts with: how much longer than a steady turn a turn that eases to rest takes. */
const SPIN_EASE = "cubic-bezier(0.25, 0.46, 0.45, 0.94)", SPIN_EASE_SLOPE = 0.46 / 0.25;

const ICONS = ["check", "download", "restart"] as const;
const ICON_OF: Record<UpdateView, (typeof ICONS)[number]> = { idle: "check", checking: "check", available: "download", installing: "download", ready: "restart", restarting: "restart" };

/**
 * Turns `ref` while `active`. When that ends it doesn't snap back: it eases through what is left of
 * the turn and comes to rest where it looks as it did before (`symmetry`: every 180° for the two
 * arrows of the refresh icon, a whole turn for one). Nothing turns with reduced motion.
 */
function useSpin(ref: RefObject<HTMLElement | null>, active: boolean, symmetry: 180 | 360) {
  const spin = useRef<Animation | undefined>(undefined);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (active) {
      if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      spin.current?.cancel();
      spin.current = el.animate([{ rotate: "0deg" }, { rotate: "360deg" }], { duration: SPIN_MS, iterations: Infinity });
      return;
    }
    const turning = spin.current;
    if (!turning) return;
    const at = (Number(turning.effect?.getComputedTiming().progress ?? 0) * 360) % symmetry;
    turning.cancel();
    const rest = el.animate([{ rotate: `${at}deg` }, { rotate: `${symmetry}deg` }], { duration: Math.max(1, ((symmetry - at) / 360) * SPIN_MS * SPIN_EASE_SLOPE), easing: SPIN_EASE });
    spin.current = rest;
    rest.onfinish = () => { if (spin.current === rest) spin.current = undefined; };
  }, [active]);
  useEffect(() => () => spin.current?.cancel(), []);
}

interface Card {
  title: string;
  /** Under the title, quieter. */
  sub?: string;
  body?: ReactNode;
  /** What a click on the button does now, as the card says it: "Click to install" with a mouse, a button on a touch screen. */
  action?: { hint: string; label: string };
}

/** The button beside the sidebar's release label. */
export function ReleaseUpdate() {
  useReleaseWatch();
  const info = useReleaseUpdate((s) => s.info);
  const phase = useReleaseUpdate((s) => s.phase);
  const step = useReleaseUpdate((s) => s.step);
  const failure = useReleaseUpdate((s) => s.failure);
  const checkedAt = useReleaseUpdate((s) => s.checkedAt);
  const view = updateView({ info, phase });
  const icon = ICONS.indexOf(ICON_OF[view]);

  const button = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const wheel = useRef<HTMLSpanElement>(null);
  const turn = useRef<HTMLSpanElement>(null);
  useSpin(wheel, view === "checking", 180);
  useSpin(turn, view === "restarting", 360);

  // The card shows while the pointer rests on the button or the card, while the button has keyboard
  // focus, or pinned: opened by a tap, by a check's answer, or by something going wrong.
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [touch, setTouch] = useState(false);
  const open = hovered || focused || pinned;
  // The changelog in full ("Show more"), and whether the short one is cut: changes left out, or one
  // that doesn't fit its two lines. Shown short again each time the card opens.
  const [more, setMore] = useState(false);
  const [clamped, setClamped] = useState(false);
  useEffect(() => { if (!open) setMore(false); }, [open]);
  const id = useId();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hover = (on: boolean) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setHovered(on), on ? HOVER_DELAY : LEAVE_DELAY);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  const over = { onPointerEnter: (e: React.PointerEvent) => { if (e.pointerType !== "touch") hover(true); }, onPointerLeave: (e: React.PointerEvent) => { if (e.pointerType !== "touch") hover(false); } };

  /** Whether the button is on screen: not in a sidebar that is put away. */
  const shown = () => {
    const rect = button.current?.getBoundingClientRect();
    return !!rect && rect.width > 0 && rect.right > 0 && rect.left < innerWidth;
  };
  // Something went wrong: say so without waiting to be asked.
  useEffect(() => { if (failure && shown()) setPinned(true); }, [failure]);
  // A check that was asked for answers in the card, which then leaves by itself: "up to date" soon, an
  // update's changelog after a while longer. On a touch screen the changelog stays until it's put away,
  // since nothing there says it's still being read.
  useEffect(() => {
    if (!checkedAt || !shown()) return;
    setPinned(true);
    if (touch && view !== "idle") return;
    const leave = setTimeout(() => setPinned(false), view === "idle" ? ANSWER_MS : 2 * ANSWER_MS);
    return () => clearTimeout(leave);
  }, [checkedAt]);
  // A pinned card goes with a press anywhere else, or Escape. A failed check is said once.
  useEffect(() => {
    if (!pinned) return;
    const close = () => {
      setPinned(false);
      if (useReleaseUpdate.getState().failure?.during === "check") dismissUpdateFailure();
    };
    const away = (e: PointerEvent) => { if (!button.current?.contains(e.target as Node) && !card.current?.contains(e.target as Node)) close(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", away, true); document.removeEventListener("keydown", key); };
  }, [pinned]);

  // Above the button, kept on screen, and placed again whenever what it says changes: in the same
  // commit, so it's never a frame over the button it belongs to. Shown by hand rather than by state:
  // a sidebar that is put away (a hidden Activity) runs this cleanup, and its card goes with it.
  useLayoutEffect(() => {
    const el = card.current, anchor = button.current;
    if (!open || !el || !anchor) return;
    const put = () => {
      if (!shown()) return void delete el.dataset.state;
      const rect = anchor.getBoundingClientRect();
      // No taller than the room above the button, or below it if there's more there: it never covers it.
      el.style.setProperty("--room", `${Math.max(rect.top, innerHeight - rect.bottom) - GAP - MARGIN}px`);
      if (!el.hasAttribute("data-more")) setClamped([...el.querySelectorAll(".release-card-changes li")].some((li) => li.scrollHeight > li.clientHeight + 1));
      const at = place({ side: "top", rect }, el.offsetWidth, el.offsetHeight);
      el.style.left = `${at.left}px`;
      el.style.top = `${at.top}px`;
      el.dataset.side = at.side;
      el.dataset.state = "open";
    };
    put();
    // Its size can also change without a render (a font arriving), and so can the window's.
    const resized = new ResizeObserver(put);
    resized.observe(el);
    window.addEventListener("resize", put);
    return () => { resized.disconnect(); window.removeEventListener("resize", put); };
  });
  useLayoutEffect(() => () => { delete card.current?.dataset.state; }, [open]);

  const act = () => {
    if (view === "idle") { setPinned(true); void checkRelease(true); }
    else if (view === "available") void installRelease();
    else if (view === "ready") void restartServer();
  };
  const latest = info?.latest ? tagLabel(info.latest) : "the update";
  const failed = failure && (failure.during === "check" ? view === "idle" : failure.during === "install" ? view === "available" : view === "ready") ? failure : undefined;
  const says = ((): Card => {
    if (failed) {
      return {
        title: failed.during === "check" ? "Couldn't check for updates" : failed.during === "install" ? "The update didn't install" : "OpenBuild couldn't restart",
        body: <p className="release-card-error" role="alert">{failed.message}</p>,
        action: { hint: "Click to try again", label: "Try again" },
      };
    }
    switch (view) {
      case "checking": return { title: "Checking for updates…" };
      case "available": {
        const changes = info?.changes;
        const listed = (more ? changes?.changes : changes?.changes.slice(0, CHANGES_LISTED)) ?? [];
        const left = (changes?.total ?? 0) - listed.length;
        // Cut short: what's left out is counted after an ellipsis, and a change too long for its two
        // lines ends in one of its own.
        const cut = !more && (left > 0 || clamped);
        return {
          title: `${latest} is available`,
          sub: listed.length && info?.current ? `What's new since ${tagVersion(info.current)}` : undefined,
          body: listed.length > 0 && (
            <>
              <ul className="release-card-changes">
                {listed.map((change, i) => <li key={i}>{changeText(change)}</li>)}
                {left > 0 && <li className="release-card-more">{more ? "" : "… "}and {left} more</li>}
              </ul>
              {(cut || more) && (
                <button type="button" className="release-card-more-toggle" aria-expanded={more} onClick={() => {
                  setMore(!more);
                  // Being read, it stays until put away (a press elsewhere, Escape), like a card a tap opened.
                  setPinned(true);
                }}>
                  {more ? "Show less" : "Show more"}
                </button>
              )}
            </>
          ),
          action: { hint: "Click to install", label: "Install update" },
        };
      }
      case "installing": {
        const at = UPDATE_STEPS.indexOf(step ?? "check");
        return {
          title: `Updating to ${latest}`,
          sub: `${UPDATE_STEP_LABEL[UPDATE_STEPS[at]!]}…`,
          body: (
            <div className="release-card-steps" role="progressbar" aria-label="Update progress" aria-valuemin={0} aria-valuemax={UPDATE_STEPS.length} aria-valuenow={at}>
              {UPDATE_STEPS.map((s, i) => <span key={s} data-step={i < at ? "done" : i === at ? "now" : undefined} />)}
            </div>
          ),
        };
      }
      case "ready": return {
        title: info?.current ? `${tagLabel(info.current)} is installed` : "The update is installed",
        sub: "Restart OpenBuild to start using it. Running turns carry on.",
        action: { hint: "Click to restart", label: "Restart now" },
      };
      case "restarting": return { title: "Restarting OpenBuild…", sub: "This page reloads when it's back." };
      default: return checkedAt && pinned
        ? { title: "You're up to date", sub: info?.track ? `No newer ${info.track} release.` : undefined }
        : { title: "Check for updates" };
    }
  })();
  const name = failed ? `${says.title}. Try again`
    : view === "available" ? `Install ${latest}`
    : view === "ready" ? "Restart OpenBuild to finish updating"
    : view === "idle" ? "Check for updates"
    : says.title.replace(/…$/, "");

  return (
    <>
      <button
        ref={button}
        type="button"
        className="release-update"
        data-view={view}
        data-step={view === "installing" ? step ?? "check" : undefined}
        data-failed={failed ? "" : undefined}
        aria-label={name}
        aria-describedby={open ? id : undefined}
        aria-busy={view === "checking" || view === "installing" || view === "restarting" || undefined}
        {...over}
        onFocus={(e) => setFocused(e.currentTarget.matches(":focus-visible"))}
        onBlur={() => setFocused(false)}
        onClick={(e) => {
          const byTouch = (e.nativeEvent as PointerEvent).pointerType === "touch";
          setTouch(byTouch);
          // On a touch screen the card comes first, and its button acts. A check has nothing to read first.
          if (byTouch && view !== "idle") return setPinned((p) => !p);
          act();
        }}
      >
        <svg className="release-update-ring" viewBox="0 0 22 22" aria-hidden>
          <circle cx="11" cy="11" r="9.75" />
          <circle cx="11" cy="11" r="9.75" pathLength={1} />
        </svg>
        <span className="release-update-icon" data-icon="check" data-at={Math.sign(0 - icon)} aria-hidden><span ref={wheel}><RefreshCw size={13} /></span></span>
        <span className="release-update-icon" data-icon="download" data-at={Math.sign(1 - icon)} aria-hidden><Download size={13} /></span>
        <span className="release-update-icon" data-icon="restart" data-at={Math.sign(2 - icon)} aria-hidden><span ref={turn}><RotateCw size={13} /></span></span>
        <span className="release-update-dot" aria-hidden />
      </button>
      {open && createPortal(
        <div ref={card} id={id} className="release-card" role="status" data-view={view} data-failed={failed ? "" : undefined} data-more={more && view === "available" ? "" : undefined} {...over}>
          <p className="release-card-title">{says.title}</p>
          {says.sub && <p className="release-card-sub">{says.sub}</p>}
          {says.body}
          {says.action && (touch
            ? <button type="button" className="release-card-action" onClick={act}>{says.action.label}</button>
            : <p className="release-card-hint">{says.action.hint}</p>)}
        </div>,
        document.body,
      )}
    </>
  );
}
