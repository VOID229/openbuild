// Custom select controls used in Settings, styled like the composer's pickers.
import { Check, ChevronDown, CircleAlert } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { type Effort } from "../../shared/types";
import { findModel, providerName, providerOf } from "../lib/models";
import { usePlugins } from "../lib/plugins";
import { hasModelScope, scopedModels, searchProviderGroups } from "../lib/modelSearch";
import { useStore } from "../lib/store";
import type { ModelRef } from "../lib/types";
import { arrowNav, cx, useFocusOnShow } from "../lib/ui";
import { BrandIcon, Popover } from "./primitives";

/** Search box + Pi's models grouped by provider. Mounts fresh per open. */
export function ModelMenu({ selected, onPick }: { selected?: ModelRef; onPick: (ref: ModelRef) => void }) {
  usePlugins((s) => s.version);
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const detection = useStore((s) => s.detection);
  // This device's Pi settings can scope the picker (`enabledModels`); "Show all" widens it again.
  const scope = detection.pi?.scope;
  const scoped = hasModelScope(scope);
  const all = detection.pi?.models ?? [];

  useFocusOnShow(search);

  const models = useMemo(
    () => (showAll ? all : scopedModels(all, scope, selected?.plan === "pi" ? selected.id : undefined)),
    [all, scope, showAll, selected],
  );

  // "xai grok", "fireworks deepseek": provider words narrow to that provider.
  const groups = useMemo(() => searchProviderGroups(models, query), [models, query]);

  return (
    <>
      <input
        ref={search}
        className="input input-sm"
        placeholder="Search models or providers…"
        value={query}
        spellCheck={false}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            list.current?.querySelector<HTMLElement>(".menu-item")?.focus();
          } else if (e.key === "Enter") {
            e.preventDefault();
            const first = groups[0];
            if (first?.models[0]) onPick({ plan: "pi", id: first.models[0].id });
          }
        }}
      />
      <div ref={list} className="select-list" onKeyDown={(e) => arrowNav(e)}>
        {scoped && (
          <button type="button" className="menu-item" aria-pressed={showAll} onClick={() => setShowAll((v) => !v)}>
            <span className="menu-item-label">{showAll ? "Show only scoped models" : `Show all ${all.length} models`}</span>
          </button>
        )}
        {groups.map((g) => (
          <div key={g.provider} role="group" aria-label={providerName(g.provider)}>
            <div className="menu-label">{providerName(g.provider)}</div>
            {g.models.map((m) => {
              const isSelected = selected?.plan === "pi" && selected.id === m.id;
              return (
                <button key={m.id} type="button" role="option" aria-selected={isSelected} className="menu-item" onClick={() => onPick({ plan: "pi", id: m.id })}>
                  <BrandIcon id={m.id} />
                  <span className="menu-item-label">{m.name}</span>
                  {isSelected && <Check size={15} className="menu-check" />}
                </button>
              );
            })}
          </div>
        ))}
        {!groups.length && (
          <p className="menu-empty">
            {query.trim()
              ? `No models match “${query.trim()}”.`
              : scoped && !showAll
                ? "No models from this device's Pi scope."
                : "Sign in to a provider in Settings → Providers to choose a model."}
          </p>
        )}
      </div>
    </>
  );
}

/** Searchable model dropdown (Settings). */
export function ModelSelect({ value, onChange, label }: { value: ModelRef; onChange: (ref: ModelRef) => void; label: string }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const detection = useStore((s) => s.detection);
  const current = findModel(detection, value);

  return (
    <span className="select-wrap select-grow">
      <button
        ref={anchor}
        type="button"
        className={cx("select-trigger", open && "select-trigger-open")}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((o) => !o)}
      >
        {current ? <BrandIcon id={current.id} /> : <CircleAlert size={15} className="bad" />}
        <span className="select-value">{current ? current.name : `${value.id} (unavailable)`}</span>
        <span className="select-hint">{current ? providerName(providerOf(current)) : value.plan}</span>
        <ChevronDown size={14} className="select-chevron" />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} className="menu select-menu model-select-menu" role="listbox" label={label} fixed="auto">
        <ModelMenu
          selected={value}
          onPick={(ref) => {
            onChange(ref);
            setOpen(false);
          }}
        />
      </Popover>
    </span>
  );
}

const SHORT: Record<Effort, string> = { off: "off", low: "low", medium: "med", high: "high", xhigh: "xhigh", max: "max" };

/** Reasoning level dropdown limited to the levels a model supports. */
export function EffortSelect({ value, levels, onChange, label }: { value: Effort; levels: Effort[]; onChange: (e: Effort) => void; label: string }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const supported = levels.length > 0;
  return (
    <span className="select-wrap">
      <button
        ref={anchor}
        type="button"
        className={cx("select-trigger select-trigger-sm", open && "select-trigger-open")}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        aria-disabled={!supported}
        data-tooltip={supported || open ? undefined : "This model doesn't expose reasoning levels"}
        onClick={() => supported && setOpen((o) => !o)}
      >
        <span className="select-value">{supported ? SHORT[value] : "default"}</span>
        <ChevronDown size={14} className="select-chevron" />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} className="menu select-menu" role="listbox" label={label} fixed="auto">
        <div className="menu-label">Thinking level</div>
        <div onKeyDown={(e) => arrowNav(e)}>
          {levels.map((level) => (
            <button
              key={level}
              type="button"
              role="option"
              aria-selected={value === level}
              className="menu-item"
              onClick={() => {
                onChange(level);
                setOpen(false);
              }}
            >
              <span className="menu-item-label">{SHORT[level]}</span>
              {value === level && <Check size={15} className="menu-check" />}
            </button>
          ))}
        </div>
      </Popover>
    </span>
  );
}

/** Themed dropdown for a short fixed list of options. */
export function OptionSelect<T extends string>({ value, options, onChange, label, className }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const current = options.find((o) => o.value === value);
  return (
    <span className={cx("select-wrap", className)}>
      <button
        ref={anchor}
        type="button"
        className={cx("select-trigger select-trigger-md", open && "select-trigger-open")}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="select-value">{current?.label ?? value}</span>
        <ChevronDown size={14} className="select-chevron" />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} className="menu select-menu" role="listbox" label={label} fixed="auto">
        <div onKeyDown={(e) => arrowNav(e)}>
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={value === o.value}
              className="menu-item"
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
            >
              <span className="menu-item-label">{o.label}</span>
              {value === o.value && <Check size={15} className="menu-check" />}
            </button>
          ))}
        </div>
      </Popover>
    </span>
  );
}
