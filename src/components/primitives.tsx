import { Boxes, CircleUserRound } from "lucide-react";
import { forwardRef, memo, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { brandSvg, CUSTOM_PROVIDER, providerName, providerSvg } from "../lib/models";
import { pluginBrandSvg, pluginIconsReady, pluginProviderSvg, usePlugins } from "../lib/plugins";
import { cx, useDismiss, usePresence } from "../lib/ui";

/** A Settings section's "# Title" heading. */
export const SettingsHeading = ({ children }: { children: ReactNode }) => (
  <h2 className="md-h1" id="settings-title">
    <span className="md-hash">#</span> {children}
  </h2>
);

export function Toggle({ checked, onChange, label, disabled = false }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={cx("toggle", disabled && "toggle-disabled")}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
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
  /** Fixed popovers: line up with the anchor's left edge, or its right edge. */
  align?: "start" | "end";
  style?: React.CSSProperties;
}

export function Popover({ open, onClose, anchor, className, children, role = "dialog", label, fixed, align = "start", style }: PopoverProps) {
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
      const left = Math.max(12, Math.min(align === "end" ? r.right - width : r.left, window.innerWidth - width - 12));
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
  }, [fixed, align, open, mounted, anchor]);
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
  usePlugins((s) => s.version);
  // Use the cached registry on first paint; a cold load waits to avoid flashing the wrong mark.
  const svg = pluginBrandSvg(id) ?? (pluginIconsReady() ? brandSvg(id) : undefined);
  if (!svg) return <span className={cx("brand-icon", className)} aria-hidden />;
  return <span className={cx("brand-icon", className)} aria-hidden dangerouslySetInnerHTML={{ __html: svg.replaceAll("_R_0_", uid) }} />;
});

/** The Pi mark (pi.dev's monogram), in the current text colour. Padded so it sits like a Lucide icon. */
export const PiMark = memo(function PiMark({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="-47 -47 654 654" width={size} height={size} fill="currentColor" className={className} aria-hidden>
      <path d="M420 280H280V140H0V0H420V280Z" />
      <path d="M560 560H420V280H560V560Z" />
      <path d="M140 560H0V140H140V280H280V420H140V560Z" />
    </svg>
  );
});

/** Durable runtime: the Pi mark with a filled shield badge cut into its bottom-right corner. */
export const DurableMark = memo(function DurableMark({ size = 14, className }: { size?: number; className?: string }) {
  const id = `durable-cut-${useId().replace(/[^\w-]/g, "")}`;
  const shield = "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z";
  const at = "translate(10.4 9.4) scale(0.68)";
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" className={className} aria-hidden>
      <defs>
        <mask id={id} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
          <rect width="24" height="24" fill="white" />
          <path transform={at} d={shield} fill="black" stroke="black" strokeWidth={6} strokeLinejoin="round" />
        </mask>
      </defs>
      <g mask={`url(#${id})`}>
        <g transform="translate(1 1) scale(0.0357)">
          <path d="M420 280H280V140H0V0H420V280Z" />
          <path d="M560 560H420V280H560V560Z" />
          <path d="M140 560H0V140H140V280H280V420H140V560Z" />
        </g>
      </g>
      <path transform={at} d={shield} />
    </svg>
  );
});

/** Vercel Labs' fx mark: the official filled glyph from fx.sh, in the current text colour, sized like a Lucide icon. */
export const FxMark = memo(function FxMark({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="166.241 0 155.861 156" width={size} height={(size * 156) / 155.861} fill="currentColor" className={className} aria-hidden>
      <path d="M237.89 0C243.18 0 249.38 1.42 253.03 3.07L255.09 4.01L250.08 18.63L247.68 17.75C244.9 16.72 241.94 15.8 238.49 15.8C234.98 15.8 232.79 16.56 231.08 18.32C229.23 20.23 227.63 23.64 226.23 29.76L226.23 29.76L226.23 29.76L225.14 34.85H241.67L260.43 34.95L260.69 34.95L260.84 35.17L278.85 61.63L296.74 34.95H320.87L291.68 76.74L322.1 119.75H299.33L299.18 119.55L241.14 40.48L239.35 49.4H222.07L205.69 127.21C203.93 135.71 201.19 142.84 196.78 147.87C192.27 153.01 186.2 155.75 178.34 155.75C174.18 155.75 170.75 155.11 167.91 154.11L166.24 153.52V137.18L166.9 137.4L169.53 138.28C172.18 139.16 174.41 139.8 177.14 139.8C178.53 139.8 179.7 139.53 180.73 138.98C181.76 138.43 182.68 137.6 183.52 136.44C185.3 133.99 186.72 130.13 187.9 124.67L203.76 49.4H189.87L191.76 39.44L192.04 39.35L206.82 34.47L208.15 28.64C210.52 18.21 213.77 10.94 218.71 6.32C223.74 1.61 230.13 0 237.89 0ZM273.99 99.08L260.07 120.25H234.54L261 82.02L273.99 99.08Z" />
    </svg>
  );
});

/** OpenAI Codex's app mark: a scalloped cloud with a `>_` prompt cut out, in the current text colour. */
export const CodexMark = memo(function CodexMark({ size = 14, className }: { size?: number; className?: string }) {
  const id = `codex-cut-${useId().replace(/[^\w-]/g, "")}`;
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" className={className} aria-hidden>
      <defs>
        <mask id={id} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
          <rect width="24" height="24" fill="#fff" />
          <path d="M8.3 9.1L10.9 12L8.3 14.9M13 14.9H16.2" fill="none" stroke="#000" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
        </mask>
      </defs>
      <g mask={`url(#${id})`}>
        <circle cx="12" cy="12" r="7.4" />
        {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => (
          <circle key={a} cx={12 + 6.7 * Math.sin((a * Math.PI) / 180)} cy={12 - 6.7 * Math.cos((a * Math.PI) / 180)} r="4.1" />
        ))}
      </g>
    </svg>
  );
});

/** A Pi provider's icon: its brand mark, or its initial on a tile. */
export const ProviderIcon = memo(function ProviderIcon({ provider, className }: { provider: string; className?: string }) {
  const uid = useId();
  usePlugins((s) => s.version);
  if (provider === CUSTOM_PROVIDER)
    return (
      <span className={cx("brand-icon", className)} aria-hidden>
        <Boxes />
      </span>
    );
  const override = pluginProviderSvg(provider);
  if (!override && !pluginIconsReady()) return <span className={cx("brand-icon", className)} aria-hidden />;
  const svg = override ?? providerSvg(provider);
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

const SPIN_MS = 700;

// Every spinner anchors its animation to the document timeline's origin, so all of them
// share one phase (now mod duration) however late they mount and always spin in lockstep.
// It's a script animation, not a CSS one: a CSS animation restarts at 0° whenever its
// element is moved (the thread list reorders) or re-shown, knocking it out of phase.
// `waiting` parks the ring and puts a dot in it: the work isn't over, but it isn't moving either
// (a thread blocked on an extension's question).
export function Spinner({ size = 14, waiting = false }: { size?: number; waiting?: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || waiting || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const a = el.animate([{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }], { duration: SPIN_MS, iterations: Infinity });
    a.startTime = 0;
    return () => a.cancel();
  }, [waiting]);
  return <span ref={ref} className={cx("spinner", waiting && "spinner-waiting")} style={{ width: size, height: size }} aria-hidden />;
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
