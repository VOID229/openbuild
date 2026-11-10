// The building blocks of the Settings and Usage pages: the page header with its way back, a row that
// opens a page inside a section (label · current value · chevron), and that page's own header with a
// back arrow and a trail of where it sits ("Bots / Models").
import { ArrowLeft, ChevronRight, Info } from "lucide-react";
import type { ReactNode } from "react";
import { openSettingsPage, settingsUp } from "../lib/pages";
import { cx } from "../lib/ui";
import { IconButton, SettingsBack } from "./primitives";

/** The top of a page in the main pane (Settings, Usage): back to wherever it was opened from, its title, and its own controls. */
export function PageHeader({ title, onBack, backLabel = "Back", children, className }: { title: ReactNode; onBack: () => void; backLabel?: string; children?: ReactNode; className?: string }) {
  return (
    <header className={cx("page-head", className)}>
      <IconButton label={backLabel} tooltipSide="bottom" className="page-back" onClick={onBack}>
        <ArrowLeft size={17} />
      </IconButton>
      <h1 className="page-title">{title}</h1>
      {children}
    </header>
  );
}

/** A setting whose details are a tooltip on a small info mark beside its label. */
export function Hint({ text }: { text: string }) {
  return (
    <span className="setting-hint" tabIndex={0} role="img" aria-label={text} data-tooltip={text} data-tooltip-side="top">
      <Info size={13} aria-hidden />
    </span>
  );
}

/**
 * A setting with a label, one short line under it at most, and its control on the right. Details
 * that don't fit a line go in `hint`, a tooltip.
 */
export function SettingRow({ label, desc, hint, children, className, id }: { label: ReactNode; desc?: ReactNode; hint?: string; children?: ReactNode; className?: string; id?: string }) {
  return (
    <div className={cx("setting-row", className)} id={id}>
      <div className="setting-text">
        <div className="setting-label">
          {label}
          {hint && <Hint text={hint} />}
        </div>
        {desc && <p className="setting-desc">{desc}</p>}
      </div>
      {children}
    </div>
  );
}

/** A row that opens a page inside the section: its name, what it's set to now, and a chevron. */
export function NavRow({ label, value, desc, icon, to, onClick, className }: { label: ReactNode; value?: ReactNode; desc?: ReactNode; icon?: ReactNode; to?: string; onClick?: () => void; className?: string }) {
  return (
    <button type="button" className={cx("setting-row nav-row", className)} onClick={onClick ?? (() => to && openSettingsPage(to))}>
      {icon && <span className="nav-row-icon" aria-hidden>{icon}</span>}
      <span className="setting-text">
        <span className="setting-label">{label}</span>
        {desc && <span className="setting-desc">{desc}</span>}
      </span>
      {value !== undefined && value !== "" && <span className="nav-row-value">{value}</span>}
      <ChevronRight size={16} className="nav-row-chevron" aria-hidden />
    </button>
  );
}

/** A titled group of rows inside a section, with an action at its right (New bot, Pair device). */
export function SettingsGroup({ title, action, children, className }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("sgroup", className)}>
      {(title || action) && (
        <div className="sgroup-head">
          {title && <h3 className="sgroup-title">{title}</h3>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

/**
 * A page inside a Settings section: a back arrow and the trail to it ("Bots / Models"), then its
 * content. `trail` names the levels above it, the last being where back goes; `onBack` defaults to
 * one level up (`parent`, or the section). A phone shows the title and back in the page's own header
 * instead, so the same way back is in the same place.
 */
export function SubPage({ title, trail, parent, onBack, action, children, className }: { title: ReactNode; trail: string[]; parent?: string; onBack?: () => void; action?: ReactNode; children: ReactNode; className?: string }) {
  const up = onBack ?? (() => settingsUp(parent));
  const where = trail[trail.length - 1] ?? "Settings";
  return (
    <div className={cx("subpage", className)}>
      <SettingsBack label={`Back to ${where}`} title={typeof title === "string" ? title : undefined} onBack={up} />
      <div className="subpage-head">
        <IconButton label={`Back to ${where}`} tooltip={false} className="subpage-back" onClick={up}>
          <ArrowLeft size={16} />
        </IconButton>
        <div className="subpage-trail">
          {trail.map((t, i) => (
            <span key={i} className="subpage-crumb">
              {t}
              <span className="subpage-sep" aria-hidden>/</span>
            </span>
          ))}
          <h2 className="subpage-title" id="settings-title">{title}</h2>
        </div>
        {action && <div className="subpage-action">{action}</div>}
      </div>
      {children}
    </div>
  );
}
