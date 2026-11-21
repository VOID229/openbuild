// The sidebar's edge, on a desktop: drag it (or use the arrow keys, Home and End) to make the sidebar
// wider or narrower, double-click it for the sidebar's own width. It serves whichever sidebar is open,
// OpenBuild's threads or OpenBots' list: they're one width. The line itself doesn't change: over it,
// only the cursor says it can be dragged.
//
// It comes after the main pane, laid over the line between the two (the pane clips what overflows it).
import { useEffect, useState } from "react";
import { applySidebarWidth, clampSidebarWidth, loadSidebarWidth, SIDEBAR_MIN, saveSidebarWidth, sidebarMax } from "../lib/sidebarWidth";
import { trackDrag } from "../lib/ui";

// Before the first paint, so a dragged width never shows the default first.
applySidebarWidth(loadSidebarWidth());

/** The sidebar that's open: the other one is hidden, and so has no box. */
const sidebar = () => [...document.querySelectorAll<HTMLElement>(".sidebar.sidebar-open")].find((el) => el.getBoundingClientRect().width > 0);

export function SidebarGrip() {
  // What it is now, for a screen reader: the saved width, or the sidebar's own as measured.
  const [width, setWidth] = useState(loadSidebarWidth);
  const [room, setRoom] = useState(() => window.innerWidth);
  const measure = () => {
    setRoom(window.innerWidth);
    const w = sidebar()?.getBoundingClientRect().width;
    if (w) setWidth(Math.round(w));
  };
  useEffect(() => {
    measure();
    // It shows as the sidebar opens, which eases to its width.
    const aside = sidebar();
    aside?.addEventListener("transitionend", measure);
    window.addEventListener("resize", measure);
    return () => {
      aside?.removeEventListener("transitionend", measure);
      window.removeEventListener("resize", measure);
    };
  }, []);

  const set = (w: number | undefined) => {
    const next = w === undefined ? undefined : clampSidebarWidth(w, window.innerWidth);
    applySidebarWidth(next);
    saveSidebarWidth(next);
    if (next !== undefined) setWidth(next);
    // Back to its own width, the sidebar eases there (--sidebar-ms): read it once it has.
    else setTimeout(measure, 360);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    const startX = e.clientX;
    const start = sidebar()?.getBoundingClientRect().width ?? width ?? SIDEBAR_MIN;
    trackDrag(e, "sidebar-dragging", (ev) => set(start + (ev.clientX - startX)));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const now = width ?? SIDEBAR_MIN;
    const step = e.shiftKey ? 64 : 16;
    const to = e.key === "ArrowRight" ? now + step
      : e.key === "ArrowLeft" ? now - step
      : e.key === "Home" ? SIDEBAR_MIN
      : e.key === "End" ? sidebarMax(window.innerWidth)
      : undefined;
    if (to === undefined) return;
    e.preventDefault();
    set(to);
  };

  return (
    <div
      className="sidebar-grip"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the sidebar"
      aria-valuenow={width}
      aria-valuemin={SIDEBAR_MIN}
      aria-valuemax={sidebarMax(room)}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onDoubleClick={() => set(undefined)}
      onKeyDown={onKeyDown}
    />
  );
}
