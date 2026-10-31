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

/** The Pi mark (pi.dev's monogram), in full-strength text colour. Padded so it sits like a Lucide icon. */
export const PiMark = memo(function PiMark({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="-47 -47 654 654" width={size} height={size} fill="var(--text)" className={className} aria-hidden>
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
    <svg viewBox="0 0 24 24" width={size} height={size} fill="var(--text)" className={className} aria-hidden>
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

/** Vercel Labs' fx mark: the official filled glyph from fx.sh, in full-strength text colour, sized like a Lucide icon. */
export const FxMark = memo(function FxMark({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="166.241 0 155.861 156" width={size} height={(size * 156) / 155.861} fill="var(--text)" className={className} aria-hidden>
      <path d="M237.89 0C243.18 0 249.38 1.42 253.03 3.07L255.09 4.01L250.08 18.63L247.68 17.75C244.9 16.72 241.94 15.8 238.49 15.8C234.98 15.8 232.79 16.56 231.08 18.32C229.23 20.23 227.63 23.64 226.23 29.76L226.23 29.76L226.23 29.76L225.14 34.85H241.67L260.43 34.95L260.69 34.95L260.84 35.17L278.85 61.63L296.74 34.95H320.87L291.68 76.74L322.1 119.75H299.33L299.18 119.55L241.14 40.48L239.35 49.4H222.07L205.69 127.21C203.93 135.71 201.19 142.84 196.78 147.87C192.27 153.01 186.2 155.75 178.34 155.75C174.18 155.75 170.75 155.11 167.91 154.11L166.24 153.52V137.18L166.9 137.4L169.53 138.28C172.18 139.16 174.41 139.8 177.14 139.8C178.53 139.8 179.7 139.53 180.73 138.98C181.76 138.43 182.68 137.6 183.52 136.44C185.3 133.99 186.72 130.13 187.9 124.67L203.76 49.4H189.87L191.76 39.44L192.04 39.35L206.82 34.47L208.15 28.64C210.52 18.21 213.77 10.94 218.71 6.32C223.74 1.61 230.13 0 237.89 0ZM273.99 99.08L260.07 120.25H234.54L261 82.02L273.99 99.08Z" />
    </svg>
  );
});

/** Codex's six-lobed app mark, using LobeHub's codex-color artwork without its white app tile.
 * Source: https://github.com/lobehub/lobe-icons/blob/master/packages/static-svg/icons/codex-color.svg
 */
export const CodexMark = memo(function CodexMark({ size = 14, className }: { size?: number; className?: string }) {
  const id = `codex-fill-${useId().replace(/[^\w-]/g, "")}`;
  return (
    <svg viewBox="3 3 18 18" width={size} height={size} className={className} aria-hidden>
      <defs>
        <linearGradient id={id} x1="12" y1="3" x2="12" y2="21" gradientUnits="userSpaceOnUse">
          <stop stopColor="#B1A7FF" />
          <stop offset=".5" stopColor="#7A9DFF" />
          <stop offset="1" stopColor="#3941FF" />
        </linearGradient>
      </defs>
      <path d="M9.064 3.344a4.578 4.578 0 012.285-.312c1 .115 1.891.54 2.673 1.275.01.01.024.017.037.021a.09.09 0 00.043 0 4.55 4.55 0 013.046.275l.047.022.116.057a4.581 4.581 0 012.188 2.399c.209.51.313 1.041.315 1.595a4.24 4.24 0 01-.134 1.223.123.123 0 00.03.115c.594.607.988 1.33 1.183 2.17.289 1.425-.007 2.71-.887 3.854l-.136.166a4.548 4.548 0 01-2.201 1.388.123.123 0 00-.081.076c-.191.551-.383 1.023-.74 1.494-.9 1.187-2.222 1.846-3.711 1.838-1.187-.006-2.239-.44-3.157-1.302a.107.107 0 00-.105-.024c-.388.125-.78.143-1.204.138a4.441 4.441 0 01-1.945-.466 4.544 4.544 0 01-1.61-1.335c-.152-.202-.303-.392-.414-.617a5.81 5.81 0 01-.37-.961 4.582 4.582 0 01-.014-2.298.124.124 0 00.006-.056.085.085 0 00-.027-.048 4.467 4.467 0 01-1.034-1.651 3.896 3.896 0 01-.251-1.192 5.189 5.189 0 01.141-1.6c.337-1.112.982-1.985 1.933-2.618.212-.141.413-.251.601-.33.215-.089.43-.164.646-.227a.098.098 0 00.065-.066 4.51 4.51 0 01.829-1.615 4.535 4.535 0 011.837-1.388z" fill={`url(#${id})`} />
      <path d="M12.546 13.909a.637.637 0 000 1.272h3.636a.637.637 0 100-1.272h-3.636zM8.462 9.23a.637.637 0 00-1.106.631l1.272 2.224-1.266 2.136a.636.636 0 101.095.649l1.454-2.455a.636.636 0 00.005-.64L8.462 9.23z" fill="#fff" />
    </svg>
  );
});

/** Cursor's official cube mark (simple-icons "cursor"), in full-strength text colour. */
export const CursorMark = memo(function CursorMark({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="var(--text)" className={className} aria-hidden>
      <path d="M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23" />
    </svg>
  );
});

/** Claude Code's mascot, Clawd (simple-icons "claudecode"), in Claude's orange. */
export const ClaudeMark = memo(function ClaudeMark({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="#D97757" className={className} aria-hidden>
      <path d="M21 10.5h3v3h-3v3h-1.5v3H18v-3h-1.5v3H15v-3H9v3H7.5v-3H6v3H4.5v-3H3v-3H0v-3h3v-6h18Zm-15 0h1.5v-3H6Zm10.5 0H18v-3h-1.5z" />
    </svg>
  );
});

/** OpenCode's official mark, matching the bundled brand asset. */
export const OpencodeMark = memo(function OpencodeMark({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="var(--text)" fillRule="evenodd" className={className} aria-hidden>
      <path d="M16 6H8v12h8V6zm4 16H4V2h16v20z" />
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
  // A second Claude login shares the mark, so its number tells them apart.
  const account = /^claude(\d+)$/.exec(provider)?.[1];
  if (svg) return <span className={cx("brand-icon", className)} aria-hidden dangerouslySetInnerHTML={{ __html: svg.replaceAll("_R_0_", uid) + (account ? `<span class="brand-badge">${account}</span>` : "") }} />;
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
