// Custom select controls used in Settings, styled like the composer's pickers.
import { Check, ChevronDown, CircleAlert } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { KEY_ORDER, PLANS, type Effort } from "../../shared/types";
import { findModel } from "../lib/models";
import { fuzzyScore } from "../lib/search";
import { useStore } from "../lib/store";
import type { ModelRef } from "../lib/types";
import { arrowNav, cx } from "../lib/ui";
import { BrandIcon, Popover } from "./primitives";

/** Search box + model list grouped by plan (every plan with a working key). Mounts fresh per open. */
export function ModelMenu({ selected, onPick }: { selected?: ModelRef; onPick: (ref: ModelRef) => void }) {
  const [query, setQuery] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const detection = useStore((s) => s.detection);

  const groups = useMemo(() => {
    const q = query.trim();
    return KEY_ORDER.filter((plan) => detection[plan]?.models.length)
      .map((plan) => {
        const models = detection[plan]!.models;
        const matches = q
          ? models
              .map((m) => ({ m, score: fuzzyScore(`${m.name} ${m.id}`, q) }))
              .filter((x) => x.score !== undefined)
              .sort((a, b) => b.score! - a.score!)
              .map((x) => x.m)
          : models;
        return { plan, models: matches };
      })
      .filter((g) => g.models.length);
  }, [detection, query]);

  return (
    <>
      <input
        autoFocus
        className="input input-sm"
        placeholder="Search models…"
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
            if (first?.models[0]) onPick({ plan: first.plan, id: first.models[0].id });
          }
        }}
      />
      <div ref={list} className="select-list" onKeyDown={(e) => arrowNav(e)}>
        {groups.map((g) => (
          <div key={g.plan} role="group" aria-label={PLANS[g.plan].label}>
            <div className="menu-label">{PLANS[g.plan].label}</div>
            {g.models.map((m) => {
              const isSelected = selected?.plan === g.plan && selected.id === m.id;
              return (
                <button key={m.id} type="button" role="option" aria-selected={isSelected} className="menu-item" onClick={() => onPick({ plan: g.plan, id: m.id })}>
                  <BrandIcon id={m.id} />
                  <span className="menu-item-label">{m.name}</span>
                  {isSelected && <Check size={15} className="menu-check" />}
                </button>
              );
            })}
          </div>
        ))}
        {!groups.length && <p className="menu-empty">{query.trim() ? `No models match “${query.trim()}”.` : "Add an API key to choose a model."}</p>}
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
        <span className="select-hint">{PLANS[value.plan].chip}</span>
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
