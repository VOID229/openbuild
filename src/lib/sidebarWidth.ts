// How wide the sidebar is on a desktop (SidebarGrip.tsx drags its edge). OpenBuild's thread list and
// OpenBots' list are one width, so one saved width serves both. Until it's dragged the sidebar takes
// styles.css's own width (--threads-sidebar-w); once dragged, that width is kept on this device, held
// between a smallest sidebar and one that leaves the pane beside it its room.

export const SIDEBAR_MIN = 280;
export const SIDEBAR_MAX = 560;
/** The least the pane beside the sidebar keeps. */
export const PANE_MIN = 440;
const KEY = "openbuild:sidebar-width";

/** The widest the sidebar can be in a window `room` pixels wide. */
export const sidebarMax = (room: number) => Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.round(room) - PANE_MIN));

export const clampSidebarWidth = (width: number, room: number) => Math.min(sidebarMax(room), Math.max(SIDEBAR_MIN, Math.round(width)));

/** The width last dragged to, or undefined for the sidebar's own. */
export function loadSidebarWidth(): number | undefined {
  try {
    const raw = localStorage.getItem(KEY);
    const w = raw ? Number(raw) : NaN;
    return Number.isFinite(w) && w >= SIDEBAR_MIN ? Math.min(SIDEBAR_MAX, Math.round(w)) : undefined;
  } catch {
    return undefined;
  }
}

export function saveSidebarWidth(width: number | undefined) {
  try {
    if (width === undefined) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, String(Math.round(width)));
  } catch {}
}

/**
 * Puts a width on the page (styles.css, :root[data-sidebar-w]), or takes it off for the sidebar's own.
 * CSS holds it to the window as that changes, by the same limits as clampSidebarWidth.
 */
export function applySidebarWidth(width: number | undefined, root: HTMLElement = document.documentElement) {
  if (width === undefined) {
    delete root.dataset.sidebarW;
    root.style.removeProperty("--sidebar-set");
  } else {
    root.dataset.sidebarW = "";
    root.style.setProperty("--sidebar-set", `${Math.round(width)}px`);
  }
}
