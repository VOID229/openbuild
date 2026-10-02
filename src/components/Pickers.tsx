import { Check, ChevronDown, KeyRound, ListFilter, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { CHIP_ORDER, EFFORTS, nearestEffort, PLANS, type Effort, type ModelInfo, type PlanId } from "../../shared/types";
import { availablePlans, findModel, isAuto } from "../lib/models";
import { useStore } from "../lib/store";
import { arrowNav, cx } from "../lib/ui";
import { BrandIcon, Popover, Spinner } from "./primitives";

const SHORT: Record<Effort, string> = { off: "off", low: "low", medium: "med", high: "high", xhigh: "xhigh", max: "max" };
const LONG: Record<Effort, string> = { off: "Off", low: "Low", medium: "Medium", high: "High", xhigh: "XHigh", max: "Max" };

export function EffortPicker({ dropUp }: { dropUp: boolean }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const effort = useStore((s) => s.settings.effort);
  const selection = useStore((s) => s.settings.selection);
  const detection = useStore((s) => s.detection);
  const updateSettings = useStore((s) => s.updateSettings);

  const auto = isAuto(selection);
  const model = auto ? undefined : findModel(detection, selection);
  // Availability comes from the model's metadata; the auto router applies the level wherever supported.
  const levels: Effort[] = auto ? [...EFFORTS] : (model?.reasoning.efforts ?? []);
  const supported = levels.length > 0;
  const shown = nearestEffort(levels, effort) ?? effort;
  const tooltip = !model && !auto ? "Select a model first" : !supported ? `${model?.name} doesn't expose reasoning levels` : "Reasoning effort";

  return (
    <div className="picker">
      <button
        ref={anchor}
        type="button"
        className={cx("pill", open && "pill-open")}
        disabled={!supported}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-tooltip={open ? undefined : tooltip}
        data-tooltip-side={dropUp ? "top" : "bottom"}
        onClick={() => setOpen((o) => !o)}
      >
        {LONG[shown]}
        <ChevronDown size={14} className="pill-chevron" />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} className={cx("menu effort-menu", dropUp ? "drop-up" : "drop-down")} role="listbox" label="Reasoning effort">
        <div className="menu-label">Thinking level</div>
        <div onKeyDown={(e) => arrowNav(e)}>
          {EFFORTS.map((level) => {
            const enabled = levels.includes(level);
            return (
              <button
                key={level}
                type="button"
                role="option"
                aria-selected={shown === level}
                className="menu-item"
                disabled={!enabled}
                title={enabled ? undefined : `Not supported by ${model?.name ?? "this model"}`}
                onClick={() => {
                  updateSettings({ effort: level });
                  setOpen(false);
                }}
              >
                <span>{SHORT[level]}</span>
                {shown === level && <Check size={15} className="menu-check" />}
              </button>
            );
          })}
        </div>
      </Popover>
    </div>
  );
}

function PlanStatus({ plan }: { plan: PlanId }) {
  const d = useStore((s) => s.detection[plan]);
  const openSettings = useStore((s) => s.openSettings);
  const label = PLANS[plan].label;
  if (!d || (d.status === "checking" && !d.models.length)) {
    if (d?.status === "checking")
      return (
        <div className="model-empty">
          <Spinner /> Detecting models…
        </div>
      );
    return (
      <div className="model-empty">
        <KeyRound size={18} />
        <p>No {label} key yet.</p>
        <button type="button" className="btn btn-sm" onClick={() => openSettings("keys")}>
          Add key
        </button>
      </div>
    );
  }
  if (d.status === "invalid" || (d.status === "error" && !d.models.length))
    return (
      <div className="model-empty">
        <p>{d.status === "invalid" ? `Your ${label} key was rejected.` : (d.error ?? "Couldn't load models.")}</p>
        <button type="button" className="btn btn-sm" onClick={() => openSettings("keys")}>
          {d.status === "invalid" ? "Replace key" : "Open settings"}
        </button>
      </div>
    );
  return null;
}

export function ModelPicker({ dropUp }: { dropUp: boolean }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const selection = useStore((s) => s.settings.selection);
  const autoRouter = useStore((s) => s.settings.autoRouter);
  const keys = useStore((s) => s.settings.keys);
  const detection = useStore((s) => s.detection);
  const updateSettings = useStore((s) => s.updateSettings);
  const openSettings = useStore((s) => s.openSettings);

  const auto = isAuto(selection);
  const current = auto ? undefined : findModel(detection, selection);
  const hasKeys = Object.keys(keys).length > 0;
  const ready = availablePlans(detection);
  const [chip, setChip] = useState<PlanId>(() => (!auto && selection?.plan) || ready[0] || "go");

  // When opening, jump to the chip of the selected model.
  useEffect(() => {
    if (!open) return;
    if (!auto && selection) setChip(selection.plan);
    else if (!keys[chip]) setChip(ready[0] ?? CHIP_ORDER.find((p) => keys[p]) ?? "go");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const models: ModelInfo[] = detection[chip]?.models ?? [];
  const status = detection[chip]?.status;
  const checking = status === "checking";

  const label = auto ? "Auto" : current ? current.name : !hasKeys ? "Add API key" : ready.length ? "Select model" : "Loading models…";

  const choose = (plan: PlanId, id: string) => {
    updateSettings({ selection: { plan, id } });
    setOpen(false);
  };

  return (
    <div className="picker picker-static">
      <button
        ref={anchor}
        type="button"
        className={cx("pill pill-model", open && "pill-open")}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (hasKeys ? setOpen((o) => !o) : openSettings("keys"))}
      >
        {auto ? <Sparkles size={14} /> : current ? <BrandIcon id={current.id} /> : !hasKeys ? <KeyRound size={14} /> : null}
        <span className="pill-text">{label}</span>
        <ChevronDown size={14} className="pill-chevron" />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} className={cx("model-panel", dropUp ? "drop-up" : "drop-down")} label="Choose a model">
        <div className="model-panel-head">
          <ListFilter size={16} />
          <span>{PLANS[chip].label}</span>
          {checking && <Spinner size={12} />}
          {!!models.length && <span className="model-count">{models.length} models</span>}
        </div>
        <div className="model-cols">
          <div className="api-chips" role="tablist" aria-label="Filter models by API" onKeyDown={(e) => arrowNav(e)}>
            {CHIP_ORDER.map((plan) => (
              <button
                key={plan}
                type="button"
                role="tab"
                aria-selected={chip === plan}
                className={cx("api-chip", !keys[plan] && "api-chip-empty")}
                onClick={() => setChip(plan)}
              >
                {PLANS[plan].chip}
                <span className={cx("dot", detection[plan]?.status === "valid" && "dot-ok", detection[plan]?.status === "invalid" && "dot-bad")} />
              </button>
            ))}
          </div>
          <div className="model-list" onKeyDown={(e) => arrowNav(e)}>
            {autoRouter && ready.length > 0 && (
              <button type="button" className="model-row" aria-selected={auto} onClick={() => (updateSettings({ selection: { auto: true } }), setOpen(false))}>
                <span className="model-row-icon">
                  <Sparkles size={15} />
                </span>
                <span className="model-row-name">
                  Auto <span className="badge">experimental</span>
                </span>
                {auto && <Check size={15} className="menu-check" />}
              </button>
            )}
            {models.length ? (
              models.map((m) => {
                const selected = !auto && selection?.plan === chip && selection.id === m.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    className="model-row"
                    aria-selected={selected}
                    title={`${PLANS[chip].prefix}/${m.id}`}
                    onClick={() => choose(chip, m.id)}
                  >
                    <BrandIcon id={m.id} className="model-row-icon" />
                    <span className="model-row-name">{m.name}</span>
                    {selected && <Check size={15} className="menu-check" />}
                  </button>
                );
              })
            ) : (
              <PlanStatus plan={chip} />
            )}
          </div>
        </div>
      </Popover>
    </div>
  );
}
