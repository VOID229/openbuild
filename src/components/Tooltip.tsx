// One floating tooltip for every element with `data-tooltip` (and optional `data-tooltip-side`).
// Rendered in a fixed layer above the app so scrolling or overflow-clipped containers never cut it off.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type Side = "top" | "bottom" | "left" | "right";
interface Tip {
  text: string;
  side: Side;
  rect: DOMRect;
}

const GAP = 8;
const MARGIN = 8;
const DELAY = 450;

function place(tip: Tip, w: number, h: number) {
  const { rect } = tip;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let side = tip.side;
  // Flip to the other side if the preferred one doesn't fit.
  if (side === "top" && rect.top - h - GAP < MARGIN) side = "bottom";
  else if (side === "bottom" && rect.bottom + h + GAP > vh - MARGIN) side = "top";
  else if (side === "left" && rect.left - w - GAP < MARGIN) side = "right";
  else if (side === "right" && rect.right + w + GAP > vw - MARGIN) side = "left";

  let left: number;
  let top: number;
  if (side === "top" || side === "bottom") {
    left = rect.left + rect.width / 2 - w / 2;
    top = side === "top" ? rect.top - h - GAP : rect.bottom + GAP;
  } else {
    top = rect.top + rect.height / 2 - h / 2;
    left = side === "left" ? rect.left - w - GAP : rect.right + GAP;
  }
  return {
    left: Math.round(Math.min(Math.max(MARGIN, left), vw - w - MARGIN)),
    top: Math.round(Math.min(Math.max(MARGIN, top), vh - h - MARGIN)),
    side,
  };
}

export function TooltipLayer() {
  const [tip, setTip] = useState<Tip | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; side: Side }>();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current: HTMLElement | null = null;
    let observer: MutationObserver | undefined;

    const read = (el: HTMLElement): Tip | null => {
      const text = el.dataset.tooltip;
      if (!text || !el.isConnected) return null;
      return { text, side: (el.dataset.tooltipSide as Side) ?? "bottom", rect: el.getBoundingClientRect() };
    };
    const hide = () => {
      clearTimeout(timer);
      observer?.disconnect();
      current = null;
      setTip(null);
    };
    const show = (el: HTMLElement, delay: number) => {
      hide();
      current = el;
      // Follow label changes (e.g. "Copy" → "Copied") and removal of the tooltip.
      observer = new MutationObserver(() => {
        if (current === el) setTip(el.dataset.tooltip ? read(el) : null);
      });
      observer.observe(el, { attributes: true, attributeFilter: ["data-tooltip"] });
      timer = setTimeout(() => current === el && setTip(read(el)), delay);
    };

    const target = (e: Event) => (e.target instanceof Element ? (e.target.closest("[data-tooltip]") as HTMLElement | null) : null);
    const onOver = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      const el = target(e);
      if (el === current) return;
      if (el) show(el, DELAY);
      else hide();
    };
    const onOut = (e: PointerEvent) => {
      if (current && !(e.relatedTarget instanceof Node && current.contains(e.relatedTarget))) hide();
    };
    const onFocus = (e: FocusEvent) => {
      const el = target(e);
      if (el?.matches(":focus-visible")) show(el, 0);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && hide();

    document.addEventListener("pointerover", onOver);
    document.addEventListener("pointerout", onOut);
    document.addEventListener("pointerdown", hide, true);
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", hide);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      hide();
      document.removeEventListener("pointerover", onOver);
      document.removeEventListener("pointerout", onOut);
      document.removeEventListener("pointerdown", hide, true);
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("focusout", hide);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, []);

  useLayoutEffect(() => {
    if (!tip || !ref.current) return setPos(undefined);
    setPos(place(tip, ref.current.offsetWidth, ref.current.offsetHeight));
  }, [tip]);

  if (!tip) return null;
  return createPortal(
    <div
      ref={ref}
      role="tooltip"
      className="tooltip"
      data-side={pos?.side ?? tip.side}
      data-state={pos ? "open" : "measuring"}
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0 }}
    >
      {tip.text}
    </div>,
    document.body,
  );
}
