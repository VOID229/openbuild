// The body of a disclosure, opening and closing by height. It stays mounted, showing what it last
// showed, while it closes, so the motion is the same whether someone clicked or the app folded it
// (a finished reply folding its work away).
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

const EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";
/** Longer for taller changes, so a big fold doesn't snap and a small one doesn't drag. */
const timeFor = (px: number) => (matchMedia("(prefers-reduced-motion: reduce)").matches ? 1 : Math.min(460, 180 + Math.sqrt(px) * 5));

export function Fold({
  open,
  className,
  children,
  as: Tag = "div",
  initiallyOpen = false,
  settle = false,
}: {
  open: boolean;
  className?: string;
  children: ReactNode;
  as?: "div" | "ul";
  /** Render open first and animate shut on mount: something that was showing folds away. */
  initiallyOpen?: boolean;
  /** While open, ease the height down when the content shrinks instead of jumping (live rows ending). */
  settle?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLElement>(null);
  const [shown, setShown] = useState(open || initiallyOpen);
  const was = useRef(open || initiallyOpen);
  const anim = useRef<Animation | null>(null);
  const kept = useRef(children);
  if (open) kept.current = children;
  if (open && !shown) setShown(true);

  const stop = (el: HTMLDivElement) => {
    anim.current?.cancel();
    anim.current = null;
    delete el.dataset.fold;
    el.style.overflow = "";
  };

  const run = (el: HTMLDivElement, from: number, to: number, fade: [number, number], mode: "opening" | "closing" | "settling") => {
    anim.current?.cancel();
    el.dataset.fold = mode;
    el.style.overflow = "hidden";
    const a = el.animate(
      { height: [`${from}px`, `${to}px`], opacity: fade },
      // Held at the end so a closed body doesn't flash back to full height before it unmounts.
      { duration: timeFor(Math.abs(to - from)), easing: EASE, fill: "forwards" },
    );
    anim.current = a;
    a.onfinish = () => {
      if (anim.current !== a) return;
      if (mode === "closing") setShown(false);
      else stop(el);
    };
  };

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) anim.current = null;
    if (!el || was.current === open) return;
    was.current = open;
    // Start from wherever it is now, mid-animation included; a body that just mounted starts shut.
    const moving = !!anim.current;
    const from = moving || !open ? el.getBoundingClientRect().height : 0;
    const fade = moving ? Number(getComputedStyle(el).opacity) : open ? 0 : 1;
    anim.current?.cancel();
    run(el, from, open ? el.getBoundingClientRect().height : 0, [fade, open ? 1 : 0], open ? "opening" : "closing");
  }, [open, shown]);

  // Settling follows what's rendered here (live rows coming and going): the height on screen before
  // this render, against the one after it, so it starts before the frame paints.
  const before = useRef(0);
  const target = useRef(0);
  if (settle && open && ref.current) before.current = ref.current.getBoundingClientRect().height;
  useLayoutEffect(() => {
    const el = ref.current;
    const inner = body.current;
    if (!settle || !el || !inner) return;
    const cs = getComputedStyle(inner);
    // The body's height with its margins, which the fold holds.
    const h = inner.offsetHeight + parseFloat(cs.marginTop) + parseFloat(cs.marginBottom);
    const state = el.dataset.fold;
    const now = el.getBoundingClientRect().height;
    // Already settling to this height: let it carry on rather than restart.
    if (state === "settling" && Math.abs(h - target.current) < 1) return;
    if (was.current && h < before.current - 1 && state !== "opening" && state !== "closing") {
      target.current = h;
      run(el, before.current, h, [1, 1], "settling");
    } else if (state === "settling" && h > now) stop(el);
  });

  if (!shown) return null;
  return (
    <div ref={ref} className="fold">
      <Tag ref={body as never} className={className}>
        {open ? children : kept.current}
      </Tag>
    </div>
  );
}
