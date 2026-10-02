import { CircleUserRound } from "lucide-react";
import { forwardRef, memo, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { brandSvg } from "../lib/models";
import { cx, useDismiss, usePresence } from "../lib/ui";

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
  /** Position with fixed coordinates below the anchor, escaping overflow-clipping ancestors. */
  fixed?: boolean;
}

export function Popover({ open, onClose, anchor, className, children, role = "dialog", label, fixed }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const { mounted, visible } = usePresence(open, 160);
  const [pos, setPos] = useState<{ top: number; left: number }>();
  useDismiss(open, onClose, [ref, anchor]);
  useLayoutEffect(() => {
    if (!fixed || !open || !anchor.current) return;
    const r = anchor.current.getBoundingClientRect();
    setPos({ top: r.bottom + 8, left: r.left });
  }, [fixed, open, anchor]);
  if (!mounted) return null;
  return (
    <div
      ref={ref}
      role={role}
      aria-label={label}
      className={cx("popover", className)}
      data-state={visible ? "open" : "closed"}
      style={fixed ? { top: pos?.top, left: pos?.left } : undefined}
    >
      {children}
    </div>
  );
}

export const BrandIcon = memo(function BrandIcon({ id, className }: { id: string; className?: string }) {
  return <span className={cx("brand-icon", className)} aria-hidden dangerouslySetInnerHTML={{ __html: brandSvg(id) }} />;
});

export function Avatar({ src, size = 24, className }: { src?: string; size?: number; className?: string }) {
  if (src) return <img className={cx("avatar", className)} src={src} alt="" width={size} height={size} style={{ width: size, height: size }} />;
  return (
    <span className={cx("avatar avatar-empty", className)} style={{ width: size, height: size }}>
      <CircleUserRound size={size} strokeWidth={1.5} />
    </span>
  );
}

export const Spinner = ({ size = 14 }: { size?: number }) => <span className="spinner" style={{ width: size, height: size }} aria-hidden />;

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
