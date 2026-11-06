// A bot's model and computer for Settings → Bots, and the Advanced tab of the OpenBots details panel,
// which puts them on one line each beside what the bot may do in OpenBuild.
import { Check, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { botModels, type PiModels } from "../../lib/pi";
import { providerName, providerOf } from "../../lib/models";
import { useBots } from "../../lib/bots/store";
import type { Bot } from "../../lib/bots/types";
import { cx } from "../../lib/ui";
import { ModelMenu, OptionSelect } from "../ModelSelect";
import { BrandIcon, Popover } from "../primitives";
import { BotThreads } from "./BotThreads";

/** A model to run bots on, with an option on top for leaving it unset and following what's `inherited` (Pi's own default without one). */
export function BotModelSelect({ label, value, unset, inherited, onChange }: { label: string; value?: string; unset: string; inherited?: string; onChange: (model: string) => void }) {
  const [open, setOpen] = useState(false);
  const [listing, setListing] = useState<PiModels>();
  const [failed, setFailed] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const models = listing?.models;
  const fallback = inherited || listing?.defaultModel;
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
  const unsetLabel = `${unset}${fallback ? ` · ${nameOf(fallback)}` : ""}`;
  return (
    <span className="select-wrap select-grow bots-set-model">
      <button ref={anchor} type="button" className={cx("select-trigger", open && "select-trigger-open")} aria-haspopup="listbox" aria-expanded={open} aria-label={label} onClick={() => setOpen((o) => !o)}>
        {value && <BrandIcon id={value} />}
        <span className="select-value">{value ? (current?.name ?? (listing ? `${value} (unavailable)` : value)) : unsetLabel}</span>
        {current && <span className="select-hint">{providerName(providerOf(current))}</span>}
        <ChevronDown size={14} className="select-chevron" />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} className="menu select-menu model-select-menu" role="listbox" label={label} fixed="auto">
        <button type="button" role="option" aria-selected={!value} className="menu-item" onClick={() => pick("")}>
          <span className="menu-item-label">{unsetLabel}</span>
          {!value && <Check size={15} className="menu-check" />}
        </button>
        <ModelMenu
          selected={{ plan: "pi", id: value ?? "" }}
          piDetection={listing ? { plan: "pi", status: "valid", models: listing.models, scope: listing.scope } : { plan: "pi", status: failed ? "error" : "checking", models: [] }}
          scopedOnly
          onPick={(ref) => pick(ref.id)}
        />
      </Popover>
    </span>
  );
}

/** The bot's model, falling back to the default in Settings → Bots. */
export function BotModel({ bot }: { bot: Bot }) {
  const defaultModel = useBots((s) => s.defaultModel);
  return (
    <div className="setting-row setting-row-stack">
      <div className="setting-text">
        <div className="setting-label">Model</div>
        <p className="setting-desc">Default follows the default model in Settings → Bots. Changes apply from the bot's next reply.</p>
      </div>
      <BotModelSelect label="Model" value={bot.model} unset="Default" inherited={defaultModel} onChange={(model) => useBots.getState().updateBot(bot.id, { model })} />
    </div>
  );
}

/** Container or host, shared by both layouts. */
function ComputerSelect({ bot, className }: { bot: Bot; className?: string }) {
  return (
    <OptionSelect
      label="Computer"
      className={className}
      value={bot.computer ? `${bot.computer.device}:${bot.computer.kind}` : "local:container"}
      options={[
        { value: "local:container", label: "Container" },
        { value: "local:host", label: "Host (unisolated)" },
        ...(bot.computer && bot.computer.device !== "local" ? [{ value: `${bot.computer.device}:${bot.computer.kind}`, label: `${bot.computer.kind} · ${bot.computer.device}` }] : []),
      ]}
      onChange={(value) => {
        if (value === "local:container" || value === "local:host") useBots.getState().updateBot(bot.id, { computer: { device: "local", kind: value === "local:host" ? "host" : "container" } });
      }}
    />
  );
}

/** Where the bot's computer runs: an isolated container, or the server itself. */
export function BotComputer({ bot }: { bot: Bot }) {
  return (
    <>
      <div className="setting-row">
        <div className="setting-text">
          <div className="setting-label">Execution environment</div>
          <p className="setting-desc">Containers are isolated. Host access is unisolated: the bot can run commands and read or change files as the server user. Only choose host access if you trust this bot.</p>
        </div>
        <ComputerSelect bot={bot} />
      </div>
      <p className="setting-desc">Choosing an environment applies to the next request. This does not move files from an existing computer.</p>
    </>
  );
}

/** The details panel's Advanced tab: the same settings as above, one line each so it fits the panel. The descriptions sit in tooltips on the labels. */
export function BotAdvanced({ bot }: { bot: Bot }) {
  const defaultModel = useBots((s) => s.defaultModel);
  return (
    <div className="bots-pane bots-advanced">
      <div className="setting-row">
        <div className="setting-label" data-tooltip="Default follows the default model in Settings → Bots. Changes apply from the bot's next reply." data-tooltip-side="left">
          Model
        </div>
        <BotModelSelect label="Model" value={bot.model} unset="Default" inherited={defaultModel} onChange={(model) => useBots.getState().updateBot(bot.id, { model })} />
      </div>
      <div className="setting-row">
        <div className="setting-label" data-tooltip="Containers are isolated. Host access is unisolated: the bot can run commands and read or change files as the server user. Applies to the next request, without moving files." data-tooltip-side="left">
          Environment
        </div>
        <ComputerSelect bot={bot} className="select-grow" />
      </div>
      <BotThreads bot={bot} compact />
    </div>
  );
}
