// A bot's model and effort for Settings → Bots, and the Advanced tab of the OpenBots details panel,
// which puts them on one line each beside what the bot may do in OpenBuild, and the machines bots reach.
import { ArrowUp, Check, ChevronDown, ChevronRight, CircleAlert, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { providerName, providerOf } from "../../lib/models";
import { useBotModels } from "../../lib/bots/models";
import { useBots } from "../../lib/bots/store";
import type { Bot } from "../../lib/bots/types";
import { loadTargets, showDevice, targetNote, targetStatus, targetSummary } from "../../lib/bots/targets";
import { isLocalWorkspace, workspaceName } from "../../lib/bots/workspace";
import { fallbackMode, type ComputerTarget, type FallbackMode } from "../../../shared/bots";
import { cx } from "../../lib/ui";
import { ModelMenu, OptionSelect } from "../ModelSelect";
import { BrandIcon, IconButton, Popover } from "../primitives";
import { BotThreads } from "./BotThreads";

/**
 * A model to run bots on, with an option on top for leaving it unset and following what's `inherited` (Pi's own default without one).
 * Without `unset` there's no such option and an empty value reads `placeholder`. `account` tags the model with its own provider,
 * so a second login ("openai-codex-2") reads apart from the first.
 */
export function BotModelSelect({ label, value, unset, inherited, placeholder, account, onChange }: { label: string; value?: string; unset?: string; inherited?: string; placeholder?: string; account?: boolean; onChange: (model: string) => void }) {
  const [open, setOpen] = useState(false);
  const { listing, failed } = useBotModels();
  const anchor = useRef<HTMLButtonElement>(null);
  const models = listing?.models;
  const fallback = unset ? inherited || listing?.defaultModel : undefined;
  const nameOf = (id?: string) => models?.find((m) => m.id === id)?.name ?? id;
  const current = models?.find((m) => m.id === value);
  const pick = (model: string) => {
    onChange(model);
    setOpen(false);
  };
  // Unset reads like the model it follows, tagged with `unset`; without a known fallback it's just `unset`.
  const unsetLabel = fallback ? nameOf(fallback) : (unset ?? placeholder);
  const hint = (m: NonNullable<typeof current>) => providerName(account ? (m.provider ?? m.id.split("/")[0]!) : providerOf(m));
  return (
    <span className="select-wrap select-grow bots-set-model">
      <button ref={anchor} type="button" className={cx("select-trigger", open && "select-trigger-open")} aria-haspopup="listbox" aria-expanded={open} aria-label={label} onClick={() => setOpen((o) => !o)}>
        {(value || fallback) && <BrandIcon id={value || fallback!} />}
        <span className="select-value">{value ? (current?.name ?? (listing ? `${value} (unavailable)` : value)) : unsetLabel}</span>
        {value ? current && <span className="select-hint">{hint(current)}</span> : fallback && <span className="select-hint">{unset}</span>}
        <ChevronDown size={14} className="select-chevron" />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} className="menu select-menu model-select-menu" role="listbox" label={label} fixed="auto">
        <ModelMenu
          selected={{ plan: "pi", id: value ?? "" }}
          piDetection={listing ? { plan: "pi", status: "valid", models: listing.models, scope: listing.scope } : { plan: "pi", status: failed ? "error" : "checking", models: [] }}
          scopedOnly
          onPick={(ref) => pick(ref.id)}
          leading={
            unset && (
              <button type="button" role="option" aria-selected={!value} className="menu-item" onClick={() => pick("")}>
                {fallback && <BrandIcon id={fallback} />}
                <span className="menu-item-label">{unsetLabel}</span>
                {fallback && <span className="menu-item-hint">{unset}</span>}
                {!value && <Check size={15} className="menu-check" />}
              </button>
            )
          }
        />
      </Popover>
    </span>
  );
}

const EFFORT_LABELS: Record<string, string> = { off: "Off", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "XHigh", max: "Max" };

/**
 * The bot's reasoning effort: Default leaves it to Pi, otherwise one of the levels the model it runs on
 * takes (its own, or the default model). One it doesn't take, kept from another model, says it runs at
 * the nearest level instead.
 */
export function BotEffortSelect({ bot, className }: { bot: Bot; className?: string }) {
  const defaultModel = useBots((s) => s.defaultModel);
  const { listing } = useBotModels();
  const modelId = bot.model || defaultModel || listing?.defaultModel;
  const model = listing?.models?.find((m) => m.id === modelId);
  const efforts: string[] = model?.reasoning.efforts ?? [];
  const value = bot.effort ?? "";
  const options = [{ value: "", label: "Default" }, ...efforts.map((e) => ({ value: e, label: EFFORT_LABELS[e] ?? e }))];
  if (value && !efforts.includes(value)) options.push({ value, label: `${EFFORT_LABELS[value] ?? value}${listing ? " · uses nearest" : ""}` });
  return (
    <OptionSelect
      label="Effort"
      className={className}
      value={value}
      options={options}
      // A model without reasoning levels has nothing to choose, unless there's an old level to clear.
      disabled={!!listing && !efforts.length && !value}
      // Empty, not left out, so the server clears it.
      onChange={(effort) => useBots.getState().updateBot(bot.id, { effort })}
    />
  );
}

const EFFORT_DESC = "How much the model reasons before answering. Default uses Pi's own level.";

/** The bot's model, falling back to the default in Settings → Bots. */
export function BotModel({ bot }: { bot: Bot }) {
  const defaultModel = useBots((s) => s.defaultModel);
  return (
    <>
      <div className="setting-row setting-row-stack">
        <div className="setting-text">
          <div className="setting-label">Model</div>
          <p className="setting-desc">Default uses your default model.</p>
        </div>
        <BotModelSelect label="Model" value={bot.model} unset="Default" inherited={defaultModel} onChange={(model) => useBots.getState().updateBot(bot.id, { model })} />
      </div>
      <div className="setting-row">
        <div className="setting-text">
          <div className="setting-label">Effort</div>
          <p className="setting-desc">{EFFORT_DESC}</p>
        </div>
        <BotEffortSelect bot={bot} />
      </div>
      <BotFallbacks
        bot={bot}
        header={(select) => (
          <div className="setting-row setting-row-top">
            <div className="setting-text">
              <div className="setting-label">Fallback models</div>
              <p className="setting-desc">{FALLBACKS_DESC}</p>
            </div>
            {select}
          </div>
        )}
      />
    </>
  );
}

const FALLBACK_MODES: { value: FallbackMode; label: string }[] = [
  { value: "inherit", label: "Default fallbacks" },
  { value: "own", label: "Its own list" },
  { value: "none", label: "No fallback" },
];

/**
 * Models the bot tries, top to bottom, when its own fails before replying. Each is one provider's
 * model, so a second account's ("openai-codex-2/…") is an entry of its own. A bot follows the default
 * fallbacks, whatever its model, until it lists its own or is set to none. Picking "Its own list" shows
 * an empty list that only saves once it has a model, so until then the bot still follows the defaults.
 */
export function BotFallbacks({ bot, header }: { bot: Bot; header: (select: ReactNode) => ReactNode }) {
  const defaults = useBots((s) => s.defaultFallbackModels.length);
  const saved = fallbackMode(bot);
  const [drafting, setDrafting] = useState(false);
  const mode = saved === "inherit" && drafting ? "own" : saved;
  const { updateBot } = useBots.getState();
  const choose = (next: FallbackMode) => {
    setDrafting(next === "own");
    if (next === mode) return;
    if (next === "none") updateBot(bot.id, { noFallbacks: true });
    else if (next === "inherit") updateBot(bot.id, { noFallbacks: false, fallbackModels: [] });
    else if (saved === "none") updateBot(bot.id, { noFallbacks: false });
  };
  const following = defaults ? `the default fallbacks (${defaults})` : "the default fallbacks (none set)";
  const note =
    mode === "inherit"
      ? `Uses ${following}.`
      : mode === "none"
        ? "Never switches models. If its model fails, the chat shows the error."
        : !bot.fallbackModels?.length && `Until you add one, it uses ${following}.`;
  return (
    <>
      {header(<OptionSelect label="Fallback models" className="select-grow" value={mode} options={FALLBACK_MODES} onChange={choose} />)}
      {note && <p className="setting-desc bots-fallbacks-note">{note}</p>}
      {mode === "own" && <FallbackList list={bot.fallbackModels ?? []} onChange={(fallbackModels) => (setDrafting(true), updateBot(bot.id, { fallbackModels }))} />}
    </>
  );
}

/** An ordered list of fallback models: the bot's own, or the default's in Settings → Bots. */
export function FallbackList({ list, onChange: set }: { list: string[]; onChange: (models: string[]) => void }) {
  return (
    <div className="naming-list bots-fallbacks">
      {list.map((model, i) => (
        <div key={`${model}:${i}`} className="naming-row">
          <span className="naming-index">{i + 1}</span>
          <BotModelSelect label={`Fallback model ${i + 1}`} value={model} account onChange={(next) => set(list.map((m, j) => (j === i ? next : m)).filter((m, j, all) => all.indexOf(m) === j))} />
          <span className="naming-actions">
            {i > 0 && (
              <IconButton label="Try earlier" tooltipSide="left" className="key-icon-btn" onClick={() => set(list.map((m, j) => (j === i - 1 ? list[i]! : j === i ? list[i - 1]! : m)))}>
                <ArrowUp size={14} />
              </IconButton>
            )}
            <IconButton label="Remove" tooltipSide="left" className="key-icon-btn key-remove" onClick={() => set(list.filter((_, j) => j !== i))}>
              <Trash2 size={14} />
            </IconButton>
          </span>
        </div>
      ))}
      {list.length < 8 && (
        <div className="naming-row">
          <span className="naming-index">{list.length + 1}</span>
          <BotModelSelect key={list.length} label="Add a fallback model" placeholder="Add a fallback model" account onChange={(model) => model && !list.includes(model) && set([...list, model])} />
        </div>
      )}
    </div>
  );
}

const FALLBACKS_DESC = "Tried in order if the model fails before the bot starts replying.";

/** Settings → Bots: the default fallbacks, for every bot without a list of its own or set to none, whatever its model. */
export function DefaultFallbacks() {
  const list = useBots((s) => s.defaultFallbackModels);
  return (
    <>
      <div className="setting-row setting-row-top">
        <div className="setting-text">
          <div className="setting-label">Default fallback models</div>
          <p className="setting-desc">{FALLBACKS_DESC} Every bot uses these, whatever its model, unless it has its own list or No fallback.</p>
        </div>
      </div>
      <FallbackList list={list} onChange={useBots.getState().setDefaultFallbackModels} />
    </>
  );
}

/** The machines bots reach, loaded while a list of them is open. */
function useTargets(on: boolean) {
  const [targets, setTargets] = useState<ComputerTarget[]>();
  useEffect(() => {
    if (!on) return;
    let live = true;
    void loadTargets().then(
      (list) => live && setTargets(list),
      () => live && setTargets([]),
    );
    return () => {
      live = false;
    };
  }, [on]);
  return targets;
}

const DOT: Partial<Record<ComputerTarget["status"], string>> = { access: "pi-status-dot-warn", offline: "pi-status-dot-off", revoked: "pi-status-dot-bad", outdated: "pi-status-dot-bad", mismatch: "pi-status-dot-bad", unpaired: "pi-status-dot-bad" };

/** One machine: whether it allows bots, what with, and why not. It opens that device in Settings → Devices, where both are changed. */
function MachineRow({ target, here }: { target: ComputerTarget; here: string }) {
  const note = targetNote(target, here);
  const summary = targetSummary(target);
  return (
    <li className="pi-row pi-row-stack bot-machine">
      <button type="button" className="bot-machine-link" aria-label={`${target.name}: ${targetStatus(target)}. Open in Settings → Devices`} onClick={() => showDevice(target.device)}>
        <span className={cx("pi-status-dot", DOT[target.status])} aria-hidden />
        <span className="pi-row-text">
          <span className="pi-row-name">
            {target.name}
            <span className="device-status">{targetStatus(target)}</span>
          </span>
          {summary && <span className="pi-row-desc">{summary}</span>}
        </span>
        <ChevronRight size={14} className="bot-machine-chevron" aria-hidden />
      </button>
      {note && (
        <p className={cx("setting-desc bot-target-note", note.tone === "bad" && "bot-target-note-bad")}>
          <CircleAlert size={13} aria-hidden /> {note.text}
        </p>
      )}
    </li>
  );
}

const MACHINES_DESC = "Bots can work on any of these. What each device allows is set in Settings → Devices.";

/**
 * The machines a bot reaches, read-only: the same for every bot. Another server's workspace lists its
 * own, which only its own Settings → Devices can change.
 */
export function BotMachines({ compact }: { compact?: boolean }) {
  const workspace = useBots((s) => s.workspace);
  const local = isLocalWorkspace(workspace);
  const targets = useTargets(local);
  const here = targets?.find((t) => t.device === "local")?.name ?? "this server";
  if (!local) return <p className="setting-desc">{`These bots run on ${workspaceName(workspace)}, which lists their machines in its own Settings → Devices.`}</p>;
  return (
    <>
      {!compact && <p className="setting-desc">{MACHINES_DESC}</p>}
      <ul className="pi-list bot-machines" aria-label="Machines bots can reach" aria-busy={!targets}>
        {!targets ? <li className="pi-empty">Checking machines…</li> : targets.map((t) => <MachineRow key={t.device} target={t} here={here} />)}
      </ul>
    </>
  );
}

/** The details panel's Advanced tab: the same settings as above, one line each so it fits the panel. The descriptions sit in tooltips on the labels. */
export function BotAdvanced({ bot }: { bot: Bot }) {
  const defaultModel = useBots((s) => s.defaultModel);
  return (
    <div className="bots-pane bots-advanced">
      <div className="setting-row">
        <div className="setting-label" data-tooltip="Default uses your default model from Settings → Bots." data-tooltip-side="left">
          Model
        </div>
        <BotModelSelect label="Model" value={bot.model} unset="Default" inherited={defaultModel} onChange={(model) => useBots.getState().updateBot(bot.id, { model })} />
      </div>
      <div className="setting-row">
        <div className="setting-label" data-tooltip={EFFORT_DESC} data-tooltip-side="left">
          Effort
        </div>
        <BotEffortSelect bot={bot} className="select-grow" />
      </div>
      <BotFallbacks
        bot={bot}
        header={(select) => (
          <div className="setting-row">
            <div className="setting-label" data-tooltip={FALLBACKS_DESC} data-tooltip-side="left">
              Fallback models
            </div>
            {select}
          </div>
        )}
      />
      <div className="setting-row">
        <div className="setting-label" data-tooltip={MACHINES_DESC} data-tooltip-side="left">
          Machines
        </div>
      </div>
      <BotMachines compact />
      <BotThreads bot={bot} compact />
    </div>
  );
}
