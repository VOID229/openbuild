// A list that opens for something typed in a textarea (the "@" pickers) opens where it was typed: at
// the "@", above its line, or under it when there's no room above (the other way round for a list
// that opens downwards, as a new thread's does), kept on screen. A phone keeps the
// list across the box (mobile.css), so there the list is left where its CSS puts it.
import { useLayoutEffect, type RefObject } from "react";

/** What lays the field's text out, copied onto the mirror that measures it. */
const LAYOUT = [
  "box-sizing",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "font-family",
  "font-size",
  "font-style",
  "font-variant",
  "font-weight",
  "font-stretch",
  "font-kerning",
  "font-feature-settings",
  "font-variation-settings",
  "font-optical-sizing",
  "text-rendering",
  "line-height",
  "letter-spacing",
  "word-spacing",
  "text-transform",
  "text-indent",
  "text-align",
  "tab-size",
  "white-space",
  "word-break",
  "overflow-wrap",
  "direction",
] as const;

const PHONE = "(max-width: 768px)";

/**
 * Where character `index` of a field is drawn, in viewport px: its left edge and its line's top and
 * bottom, after the field's scroll. A mirror of the field lays the same text out at the same width.
 */
export function charRect(field: HTMLTextAreaElement, index: number): { left: number; top: number; bottom: number } {
  const style = getComputedStyle(field);
  const mirror = document.createElement("div");
  for (const p of LAYOUT) mirror.style.setProperty(p, style.getPropertyValue(p));
  // The field's text box: its width inside the borders and any scrollbar.
  Object.assign(mirror.style, { position: "fixed", left: "0", top: "0", visibility: "hidden", pointerEvents: "none", boxSizing: "border-box", border: "0", width: `${field.clientWidth}px`, height: "auto", overflow: "hidden" });
  const value = field.value;
  const mark = document.createElement("span");
  // The rest of the text follows, so the word the character starts wraps as it does in the field.
  mark.textContent = value[index] && value[index] !== "\n" ? value[index]! : "​";
  mirror.append(value.slice(0, index), mark, value.slice(index + 1));
  document.body.append(mirror);
  const box = mirror.getBoundingClientRect();
  const at = mark.getClientRects()[0] ?? mark.getBoundingClientRect();
  mirror.remove();
  const drawn = field.getBoundingClientRect();
  const x = drawn.left + field.clientLeft - field.scrollLeft + (at.left - box.left);
  const y = drawn.top + field.clientTop - field.scrollTop + (at.top - box.top);
  return { left: x, top: y, bottom: y + at.height };
}

/** Puts `menu` back where its CSS has it. */
function unplace(menu: HTMLElement) {
  for (const p of ["left", "right", "top", "bottom", "max-height", "overflow-y"]) menu.style.removeProperty(p);
}

/**
 * Places `menu` (absolutely positioned, inside the composer) at character `index` of `field`: its left
 * edge at that character, above its line, or under it when the list fits better there (`down`: under
 * it first, above when it fits better there); inside the composer where it fits, `margin` px clear of
 * the window's edges, and shortened to the room there is.
 */
export function placeAtChar(menu: HTMLElement, field: HTMLTextAreaElement, index: number, down = false, gap = 6, margin = 8) {
  const parent = menu.offsetParent;
  if (!parent) return;
  unplace(menu);
  if (window.matchMedia(PHONE).matches) return;
  const at = charRect(field, index);
  // A line scrolled out of the field: the list stays at the field's edge.
  const shown = field.getBoundingClientRect();
  const lineTop = Math.min(Math.max(at.top, shown.top), shown.bottom);
  const lineBottom = Math.min(Math.max(at.bottom, shown.top), shown.bottom);
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  const above = lineTop - gap - margin;
  const below = window.innerHeight - lineBottom - gap - margin;
  const up = down ? height > below && above > below : height <= above || above >= below;
  const room = Math.max(0, up ? above : below);
  // Inside the composer where it fits, and always inside the window.
  const p = parent.getBoundingClientRect();
  const lo = Math.max(margin, p.left);
  const hi = Math.min(window.innerWidth - margin, p.right);
  const left = hi - lo >= width ? Math.max(lo, Math.min(at.left, hi - width)) : Math.max(margin, Math.min(at.left, window.innerWidth - margin - width));
  // In the parent's padding box, which is what `left`, `top` and `bottom` count from.
  const padLeft = p.left + parent.clientLeft;
  const padTop = p.top + parent.clientTop;
  menu.style.left = `${left - padLeft}px`;
  menu.style.right = "auto";
  if (up) {
    menu.style.top = "auto";
    menu.style.bottom = `${padTop + parent.clientHeight - (lineTop - gap)}px`;
  } else {
    menu.style.bottom = "auto";
    menu.style.top = `${lineBottom + gap - padTop}px`;
  }
  if (height > room) {
    menu.style.maxHeight = `${room}px`;
    menu.style.overflowY = "auto";
  }
}

/**
 * Keeps `menu` at character `index` of `field` (placeAtChar) while it's open: on every render, as the
 * window resizes and as the field scrolls. `index` undefined: no list open. `down`: a list that opens
 * under the line when there's room.
 */
export function useCharAnchor(menu: RefObject<HTMLElement | null>, field: RefObject<HTMLTextAreaElement | null>, index: number | undefined, down = false) {
  useLayoutEffect(() => {
    if (index === undefined || !menu.current || !field.current) return;
    placeAtChar(menu.current, field.current, index, down);
  });
  useLayoutEffect(() => {
    const el = field.current;
    if (index === undefined || !el) return;
    const place = () => menu.current && field.current && placeAtChar(menu.current, field.current, index, down);
    window.addEventListener("resize", place);
    el.addEventListener("scroll", place);
    return () => {
      window.removeEventListener("resize", place);
      el.removeEventListener("scroll", place);
    };
  }, [menu, field, index, down]);
}
