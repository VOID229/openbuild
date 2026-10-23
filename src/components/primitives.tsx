import { Boxes, CircleUserRound } from "lucide-react";
import { forwardRef, memo, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { brandSvg, CUSTOM_PROVIDER, providerName, providerSvg } from "../lib/models";
import { cx, useDismiss, usePresence } from "../lib/ui";

/** A Settings section's "# Title" heading. */
export const SettingsHeading = ({ children }: { children: ReactNode }) => (
  <h2 className="md-h1" id="settings-title">
    <span className="md-hash">#</span> {children}
  </h2>
);

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className="toggle" onClick={() => onChange(!checked)}>
      <span className="toggle-knob" />
    </button>
  );
}

interface PopoverProps {
  open: boolean;
  onClose: () => void;
  anchor: RefObject<HTMLElement | null>;
  className?: string;
  children: ReactNode;
  role?: string;
  label?: string;
  /**
   * Position with fixed coordinates above/below the anchor, escaping overflow-clipping ancestors.
   * "auto" opens toward the side with more room and caps the height to fit.
   */
  fixed?: "up" | "down" | "auto";
  style?: React.CSSProperties;
}

export function Popover({ open, onClose, anchor, className, children, role = "dialog", label, fixed, style }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const { mounted, visible } = usePresence(open, 160);
  const [pos, setPos] = useState<React.CSSProperties>();
  const close = useRef(onClose);
  close.current = onClose;
  useDismiss(open, onClose, [ref, anchor]);
  useLayoutEffect(() => {
    if (!fixed || !open || !mounted) return;
    const place = () => {
      const r = anchor.current?.getBoundingClientRect();
      if (!r) return;
      const width = ref.current?.offsetWidth ?? 0;
      const left = Math.max(12, Math.min(r.left, window.innerWidth - width - 12));
      const below = window.innerHeight - r.bottom - 20;
      const above = r.top - 20;
      const up = fixed === "up" || (fixed === "auto" && below < 320 && above > below);
      const maxHeight = fixed === "auto" ? Math.min(420, up ? above : below) : undefined;
      setPos(
        up
          ? { position: "fixed", left, bottom: window.innerHeight - r.top + 8, maxHeight }
          : { position: "fixed", left, top: r.bottom + 8, maxHeight },
      );
    };
    // Follow the anchor when something scrolls (e.g. a chat auto-scrolling); close only once the
    // anchor has scrolled out of view.
    const onScroll = (e: Event) => {
      if (ref.current?.contains(e.target as Node)) return;
      const r = anchor.current?.getBoundingClientRect();
      if (!r || r.bottom < 0 || r.top > window.innerHeight || (r.width === 0 && r.height === 0)) close.current();
      else place();
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [fixed, open, mounted, anchor]);
  if (!mounted) return null;
  const el = (
    <div
      ref={ref}
      role={role}
      aria-label={label}
      className={cx("popover", fixed && "popover-portal", className)}
      data-state={visible ? "open" : "closed"}
      // Until measured, keep it fixed and hidden so autofocus inside it can't scroll the page.
      style={fixed ? { ...style, ...(pos ?? { position: "fixed", top: 0, left: 0, visibility: "hidden" }) } : style}
    >
      {children}
    </div>
  );
  // Fixed popovers live in <body> so transformed or clipping ancestors can't offset or cut them.
  return fixed ? createPortal(el, document.body) : el;
}

export const BrandIcon = memo(function BrandIcon({ id, className }: { id: string; className?: string }) {
  // Gradient ids must be unique per instance: url(#id) resolves to the first match in the document,
  // and if that copy is hidden (closed picker, collapsed sidebar) WebKit paints every copy blank.
  const uid = useId();
  return <span className={cx("brand-icon", className)} aria-hidden dangerouslySetInnerHTML={{ __html: brandSvg(id).replaceAll("_R_0_", uid) }} />;
});

/** A Pi provider's icon: its brand mark, or its initial on a tile. */
export const ProviderIcon = memo(function ProviderIcon({ provider, className }: { provider: string; className?: string }) {
  const uid = useId();
  if (provider === CUSTOM_PROVIDER)
    return (
      <span className={cx("brand-icon", className)} aria-hidden>
        <Boxes />
      </span>
    );
  const svg = providerSvg(provider);
  if (svg) return <span className={cx("brand-icon", className)} aria-hidden dangerouslySetInnerHTML={{ __html: svg.replaceAll("_R_0_", uid) }} />;
  return (
    <span className={cx("brand-icon provider-letter", className)} aria-hidden>
      {providerName(provider).charAt(0)}
    </span>
  );
});

export function Avatar({ src, name, size = 24, className }: { src?: string; name?: string; size?: number; className?: string }) {
  if (src) return <img className={cx("avatar", className)} src={src} alt="" width={size} height={size} style={{ width: size, height: size }} />;
  const initial = name?.trim().charAt(0).toUpperCase();
  if (initial)
    return (
      <span className={cx("avatar avatar-initial", className)} style={{ width: size, height: size, fontSize: Math.round(size * 0.44) }} aria-hidden>
        {initial}
      </span>
    );
  return (
    <span className={cx("avatar avatar-empty", className)} style={{ width: size, height: size }}>
      <CircleUserRound size={size} strokeWidth={1.5} />
    </span>
  );
}

// Every spinner anchors its animation to the document timeline's origin, so all of them
// share one phase (now mod duration) however late they mount and always spin in lockstep.
export function Spinner({ size = 14 }: { size?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    for (const a of ref.current?.getAnimations() ?? []) a.startTime = 0;
  }, []);
  return <span ref={ref} className="spinner" style={{ width: size, height: size }} aria-hidden />;
}

export const IconButton = forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; tooltip?: string | false; tooltipSide?: "top" | "bottom" | "right" | "left" }
>(function IconButton({ label, tooltip, tooltipSide = "bottom", className, children, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      data-tooltip={tooltip === false ? undefined : (tooltip ?? label)}
      data-tooltip-side={tooltipSide}
      className={cx("icon-btn", className)}
      {...rest}
    >
      {children}
    </button>
  );
});
