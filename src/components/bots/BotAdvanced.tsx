// A bot's model and computer for Settings → Bots, and the Advanced tab of the OpenBots details panel,
// which puts them on one line each beside what the bot may do in OpenBuild.
import { ArrowUp, Check, ChevronDown, CircleAlert, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { botModels, type PiModels } from "../../lib/pi";
import { providerName, providerOf } from "../../lib/models";
import { useBots } from "../../lib/bots/store";
import type { Bot } from "../../lib/bots/types";
import { LOCAL, loadTargets, targetLabel, targetNote, targetOptions } from "../../lib/bots/targets";
import type { ComputerTarget } from "../../../shared/bots";
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
  const [listing, setListing] = useState<PiModels>();
  const [failed, setFailed] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const models = listing?.models;
  const fallback = unset ? inherited || listing?.defaultModel : undefined;
  useEffect(() => {
    let live = true;
    void botModels()
      .then((r) => live && setListing(r))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, []);
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

/** The bot's model, falling back to the default in Settings → Bots. */
export function BotModel({ bot }: { bot: Bot }) {
  const defaultModel = useBots((s) => s.defaultModel);
  return (
    <>
      <div className="setting-row setting-row-stack">
        <div className="setting-text">
          <div className="setting-label">Model</div>
          <p className="setting-desc">Default follows the default model in Settings → Bots. Changes apply from the bot's next reply.</p>
        </div>
        <BotModelSelect label="Model" value={bot.model} unset="Default" inherited={defaultModel} onChange={(model) => useBots.getState().updateBot(bot.id, { model })} />
      </div>
      <div className="setting-row setting-row-top">
        <div className="setting-text">
          <div className="setting-label">Fallback models</div>
          <p className="setting-desc">{FALLBACKS_DESC}</p>
        </div>
      </div>
      <BotFallbacks bot={bot} />
    </>
  );
}

/**
 * Models the bot tries, top to bottom, when its own fails before replying. Each is one provider's
 * model, so a second account's ("openai-codex-2/…") is an entry of its own. A bot on Default with
 * none of its own follows the default's, until it lists some.
 */
export function BotFallbacks({ bot }: { bot: Bot }) {
  const inherited = useBots((s) => (bot.model || bot.fallbackModels?.length ? 0 : s.defaultFallbackModels.length));
  return (
    <>
      {inherited > 0 && <p className="setting-desc bots-fallbacks-note">Following the {inherited === 1 ? "fallback" : `${inherited} fallbacks`} of the default model in Settings → Bots. Adding one here gives this bot its own list instead.</p>}
      <FallbackList list={bot.fallbackModels ?? []} onChange={(fallbackModels) => useBots.getState().updateBot(bot.id, { fallbackModels })} />
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

const FALLBACKS_DESC = "Tried in order when the model fails before the bot has said or done anything. A reply that's under way isn't retried on another model. The chat notes each switch.";

/** Settings → Bots: the fallbacks of the default model, for every bot on Default without fallbacks of its own. */
export function DefaultFallbacks() {
  const list = useBots((s) => s.defaultFallbackModels);
  return (
    <>
      <div className="setting-row setting-row-top">
        <div className="setting-text">
          <div className="setting-label">Default fallback models</div>
          <p className="setting-desc">{FALLBACKS_DESC} Bots set to Default use these unless they list their own; a bot with its own model keeps its own fallbacks.</p>
        </div>
      </div>
      <FallbackList list={list} onChange={useBots.getState().setDefaultFallbackModels} />
    </>
  );
}

/** The places a bot's computer can run, loaded while its settings are open. */
function useTargets() {
  const [targets, setTargets] = useState<ComputerTarget[]>();
  useEffect(() => {
    let live = true;
    void loadTargets().then(
      (list) => live && setTargets(list),
      () => live && setTargets([]),
    );
    return () => {
      live = false;
    };
  }, []);
  return targets;
}

/** Which machine runs the bot's tools: this server, or a paired device that allowed it. */
function TargetSelect({ bot, targets, className }: { bot: Bot; targets?: ComputerTarget[]; className?: string }) {
  const cfg = bot.computer ?? LOCAL;
  return (
    <OptionSelect
      label="Runs on"
      className={className}
      value={cfg.device}
      options={targetOptions(targets, cfg).map((t) => ({ value: t.device, label: targetLabel(t) }))}
      onChange={(device) => useBots.getState().updateBot(bot.id, { computer: { device, kind: cfg.kind } })}
    />
  );
}

/** How it's kept apart there: a container, or a folder with no isolation. Separate from where. */
function KindSelect({ bot, className }: { bot: Bot; className?: string }) {
  const cfg = bot.computer ?? LOCAL;
  return (
    <OptionSelect
      label="Isolation"
      className={className}
      value={cfg.kind}
      options={[
        { value: "container", label: "Container" },
        { value: "host", label: "Host (unisolated)" },
      ]}
      onChange={(kind) => useBots.getState().updateBot(bot.id, { computer: { device: cfg.device, kind } })}
    />
  );
}

/** Why the chosen device can't run every tool right now, and what to do about it. */
function TargetNote({ bot, targets }: { bot: Bot; targets?: ComputerTarget[] }) {
  const cfg = bot.computer ?? LOCAL;
  const target = targets && targetOptions(targets, cfg).find((t) => t.device === cfg.device);
  const note = targetNote(target, cfg, targets?.find((t) => t.device === "local")?.name ?? "this server");
  if (!note) return null;
  return (
    <p className={cx("setting-desc bot-target-note", note.tone === "bad" && "bot-target-note-bad")} role="status">
      <CircleAlert size={13} aria-hidden /> {note.text}
    </p>
  );
}

/** Where the bot's computer runs, and how it's isolated there. */
export function BotComputer({ bot }: { bot: Bot }) {
  const targets = useTargets();
  return (
    <>
      <div className="setting-row">
        <div className="setting-text">
          <div className="setting-label">Runs on</div>
          <p className="setting-desc">The machine its terminal, files and browser use. A paired device has to allow this server's bots first, in its Settings → Devices.</p>
        </div>
        <TargetSelect bot={bot} targets={targets} />
      </div>
      <TargetNote bot={bot} targets={targets} />
      <div className="setting-row">
        <div className="setting-text">
          <div className="setting-label">Isolation</div>
          <p className="setting-desc">Containers are isolated. Host access is unisolated: the bot can run commands and read or change files as the user running OpenBuild on that machine. Only choose host access if you trust this bot.</p>
        </div>
        <KindSelect bot={bot} />
      </div>
      <p className="setting-desc">Changes apply to the next request. Nothing moves: files on the previous computer stay there.</p>
    </>
  );
}

/** The details panel's Advanced tab: the same settings as above, one line each so it fits the panel. The descriptions sit in tooltips on the labels. */
export function BotAdvanced({ bot }: { bot: Bot }) {
  const defaultModel = useBots((s) => s.defaultModel);
  const targets = useTargets();
  return (
    <div className="bots-pane bots-advanced">
      <div className="setting-row">
        <div className="setting-label" data-tooltip="Default follows the default model in Settings → Bots. Changes apply from the bot's next reply." data-tooltip-side="left">
          Model
        </div>
        <BotModelSelect label="Model" value={bot.model} unset="Default" inherited={defaultModel} onChange={(model) => useBots.getState().updateBot(bot.id, { model })} />
      </div>
      <div className="setting-row">
        <div className="setting-label" data-tooltip="The machine its terminal, files and browser use. A paired device has to allow this server's bots first. Applies to the next request, without moving files." data-tooltip-side="left">
          Runs on
        </div>
        <TargetSelect bot={bot} targets={targets} className="select-grow" />
      </div>
      <TargetNote bot={bot} targets={targets} />
      <div className="setting-row">
        <div className="setting-label" data-tooltip="Containers are isolated. Host access is unisolated: the bot can run commands and read or change files as the user running OpenBuild on that machine." data-tooltip-side="left">
          Isolation
        </div>
        <KindSelect bot={bot} className="select-grow" />
      </div>
      <div className="setting-row">
        <div className="setting-label" data-tooltip={FALLBACKS_DESC} data-tooltip-side="left">
          Fallback models
        </div>
      </div>
      <BotFallbacks bot={bot} />
      <BotThreads bot={bot} compact />
    </div>
  );
}
