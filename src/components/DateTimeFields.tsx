import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight, Clock } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cx, useDismiss } from "../lib/ui";

const startOfDay = (t: number) => new Date(t).setHours(0, 0, 0, 0);
const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

/** "09:00" → minutes after midnight, or undefined if it isn't a time. Accepts "9", "9:5", "0930". */
export function parseTime(text: string): number | undefined {
  const m = text.trim().match(/^(\d{1,2})(?::?(\d{1,2}))?$/);
  if (!m) return undefined;
  const h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  return h < 24 && min < 60 ? h * 60 + min : undefined;
}

export const formatTime = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/** A field that opens a panel below it, closing on an outside click or Escape. */
function useField() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), [ref]);
  return { open, setOpen, ref };
}

/** A day, picked from a month calendar. Days before `min` are struck out. */
export function DateField({ value, min, onChange, label }: { value: number; min?: number; onChange: (day: number) => void; label: string }) {
  const { open, setOpen, ref } = useField();
  const [month, setMonth] = useState(() => new Date(value).setDate(1));
  const today = startOfDay(Date.now());
  const floor = min === undefined ? -Infinity : startOfDay(min);

  useEffect(() => {
    if (open) setMonth(new Date(value).setDate(1));
  }, [open, value]);

  const first = new Date(month);
  const days = Array.from({ length: 42 }, (_, i) => new Date(first.getFullYear(), first.getMonth(), i + 1 - first.getDay()).getTime());
  // Drop a trailing week that's all next month.
  const shown = new Date(days[35]!).getMonth() !== first.getMonth() ? days.slice(0, 35) : days;
  const step = (n: number) => setMonth(new Date(first.getFullYear(), first.getMonth() + n, 1).getTime());

  return (
    <div className="dt-field" ref={ref}>
      <button type="button" className="input dt-trigger" aria-label={label} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>{new Date(value).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}</span>
        <CalendarDays size={16} />
      </button>
      {open && (
        <div className="popover dt-popover dt-calendar" data-state="open" role="dialog" aria-label="Choose a date">
          <div className="dt-calendar-head">
            <button type="button" className="dt-nav" aria-label="Previous month" disabled={month <= new Date(floor).setDate(1)} onClick={() => step(-1)}>
              <ChevronLeft size={16} />
            </button>
            <span>{first.toLocaleDateString([], { month: "long", year: "numeric" })}</span>
            <button type="button" className="dt-nav" aria-label="Next month" onClick={() => step(1)}>
              <ChevronRight size={16} />
            </button>
          </div>
          <div className="dt-grid">
            {WEEKDAYS.map((d) => (
              <span key={d} className="dt-weekday">
                {d}
              </span>
            ))}
            {shown.map((day) => (
              <button
                key={day}
                type="button"
                className={cx("dt-day", new Date(day).getMonth() !== first.getMonth() && "dt-day-outside", day === today && "dt-day-today")}
                aria-pressed={day === startOfDay(value)}
                disabled={day < floor}
                onClick={() => {
                  onChange(day);
                  setOpen(false);
                }}
              >
                {new Date(day).getDate()}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** A time of day ("HH:MM", minutes after midnight): typed, or picked from half-hour steps. Times before `min` are disabled. */
export function TimeField({ value, min = 0, onChange, label }: { value: number; min?: number; onChange: (minutes: number) => void; label: string }) {
  const { open, setOpen, ref } = useField();
  const [draft, setDraft] = useState(formatTime(value));
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => setDraft(formatTime(value)), [value]);
  // Open on the chosen time, not midnight.
  useLayoutEffect(() => {
    if (open) list.current?.querySelector<HTMLElement>("[aria-selected=true], .dt-option:not(:disabled)")?.scrollIntoView({ block: "center" });
  }, [open]);

  const commit = () => {
    const t = parseTime(draft);
    if (t !== undefined) onChange(t);
    else setDraft(formatTime(value));
  };
  const steps = Array.from({ length: 48 }, (_, i) => i * 30);

  return (
    <div className="dt-field" ref={ref}>
      <label className="input dt-trigger">
        <input
          aria-label={label}
          value={draft}
          inputMode="numeric"
          onFocus={() => setOpen(true)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
              setOpen(false);
            }
          }}
        />
        <Clock size={16} />
      </label>
      {open && (
        <div ref={list} className="popover menu dt-popover dt-list" data-state="open" role="listbox" aria-label={label}>
          {steps.map((t) => (
            <button
              key={t}
              type="button"
              role="option"
              aria-selected={t === value}
              className="menu-item dt-option"
              disabled={t < min}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onChange(t);
                setOpen(false);
              }}
            >
              {formatTime(t)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** One of a few options, in the same dropdown as the time list. */
export function ChoiceField<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (value: T) => void; label: string }) {
  const { open, setOpen, ref } = useField();
  return (
    <div className="dt-field" ref={ref}>
      <button type="button" className="input dt-trigger" aria-label={label} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>{options.find((o) => o.value === value)?.label}</span>
        <ChevronDown size={16} />
      </button>
      {open && (
        <div className="popover menu dt-popover dt-list" data-state="open" role="listbox" aria-label={label}>
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              className="menu-item dt-option"
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
