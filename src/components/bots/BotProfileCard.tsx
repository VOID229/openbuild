// A bot's profile card, from its mascot beside its messages in a group chat: the mascot and name, and
// the way to its own chat or its details. Hovering the mascot shows it, and it stays while the pointer
// crosses onto it; a click or tap keeps it until dismissed; keyboard focus shows it and Tab goes in.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { directOf, useBots, useRemoteWorkspace } from "../../lib/bots/store";
import type { Bot } from "../../lib/bots/types";
import { openBotsChat, openBotsDetails } from "../../lib/gestures";
import { useDismiss } from "../../lib/ui";
import { BotAvatar } from "./BotAvatar";

/** How long the pointer rests on a mascot before its card shows. */
const OPEN_DELAY = 300;
/** How long the card waits after the pointer leaves, so it can cross the gap onto the card. */
const CLOSE_DELAY = 200;
const GAP = 8;
const MARGIN = 8;

/** What opened the card: a resting pointer, keyboard focus, or a click or tap, which keeps it open. */
type How = "hover" | "focus" | "pinned";
type Pos = { left: number; top: number; side: "top" | "bottom" };

const TABBABLE = "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

/** Above the mascot, its left edge just before the mascot's; below when there's no room above. */
function placeCard(rect: DOMRect, w: number, h: number): Pos {
  const side = rect.top - h - GAP < MARGIN && rect.bottom + h + GAP <= window.innerHeight - MARGIN ? "bottom" : "top";
  return {
    left: Math.round(Math.min(Math.max(MARGIN, rect.left - 6), window.innerWidth - w - MARGIN)),
    top: Math.round(Math.max(MARGIN, side === "top" ? rect.top - h - GAP : rect.bottom + GAP)),
    side,
  };
}

/**
 * The mascot (`children`) as the button that shows `bot`'s profile card. Without a bot (a friend's
 * message, a deleted bot) there's no profile to show, and the mascot stays as it is.
 */
export function BotProfileHover({ bot, children }: { bot?: Bot; children: ReactNode }) {
  if (!bot) return <>{children}</>;
  return <ProfileTrigger bot={bot}>{children}</ProfileTrigger>;
}

function ProfileTrigger({ bot, children }: { bot: Bot; children: ReactNode }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const [how, setHow] = useState<How>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** Focus the card hands back to the mascot, which shouldn't open it again. */
  const quiet = useRef(false);
  /** Opened from the keyboard: focus goes to the card's first button once it's placed. */
  const focusIn = useRef(false);
  const id = useId();
  const later = (fn: () => void, ms: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(fn, ms);
  };
  const hide = useCallback(() => {
    clearTimeout(timer.current);
    setHow(undefined);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  // Escape or a press elsewhere. Escape from inside the card hands focus back to the mascot.
  useDismiss(!!how, () => {
    if (card.current?.contains(document.activeElement)) {
      quiet.current = true;
      trigger.current?.focus();
    }
    hide();
  }, [trigger, card]);
  // The card is placed once, so anything that moves the mascot puts it away.
  useEffect(() => {
    if (!how) return;
    const onScroll = (e: Event) => !card.current?.contains(e.target as Node) && hide();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", hide);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", hide);
    };
  }, [how, hide]);
  const enterCard = () => {
    const first = card.current?.querySelector<HTMLElement>("button:not([disabled])");
    first?.focus();
    return !!first;
  };
  /** Tab off the card's end: on to whatever follows the mascot on the page. */
  const tabPast = () => {
    const all = [...document.querySelectorAll<HTMLElement>(TABBABLE)].filter((el) => !card.current?.contains(el) && el.offsetParent !== null);
    const next = all[all.indexOf(trigger.current!) + 1];
    hide();
    if (next) next.focus();
    else {
      quiet.current = true;
      trigger.current?.focus();
    }
  };
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="bm-profile-trigger"
        aria-label={`${bot.name}'s profile`}
        aria-haspopup="dialog"
        aria-expanded={!!how}
        aria-controls={how ? id : undefined}
        onPointerEnter={(e) => {
          if (e.pointerType === "touch") return;
          if (how) clearTimeout(timer.current);
          else later(() => setHow("hover"), OPEN_DELAY);
        }}
        onPointerLeave={(e) => {
          if (e.pointerType === "touch") return;
          if (!how) clearTimeout(timer.current);
          else if (how === "hover") later(hide, CLOSE_DELAY);
        }}
        onClick={(e) => {
          clearTimeout(timer.current);
          // From the keyboard (no pointer, so no detail): open and go in. A click or tap keeps it open; another puts it away.
          if (e.detail === 0) {
            focusIn.current = true;
            if (how) enterCard();
            setHow("pinned");
          } else setHow(how === "pinned" ? undefined : "pinned");
        }}
        onFocus={(e) => {
          if (quiet.current) return void (quiet.current = false);
          if (!how && e.currentTarget.matches(":focus-visible")) setHow("focus");
        }}
        onBlur={(e) => {
          if (how === "focus" && !card.current?.contains(e.relatedTarget as Node)) hide();
        }}
        onKeyDown={(e) => {
          if (how && ((e.key === "Tab" && !e.shiftKey) || e.key === "ArrowDown") && enterCard()) e.preventDefault();
        }}
      >
        {children}
      </button>
      {how && (
        <ProfileCard
          id={id}
          bot={bot}
          anchor={trigger}
          card={card}
          onPlaced={() => {
            if (focusIn.current) enterCard();
            focusIn.current = false;
          }}
          onPointerEnter={() => clearTimeout(timer.current)}
          onPointerLeave={(e) => e.pointerType !== "touch" && how === "hover" && later(hide, CLOSE_DELAY)}
          onBlur={(e) => {
            const to = e.relatedTarget as Node | null;
            if (to && !card.current?.contains(to) && to !== trigger.current) hide();
          }}
          onKeyDown={(e) => {
            const buttons = [...e.currentTarget.querySelectorAll<HTMLElement>("button:not([disabled])")];
            const at = buttons.indexOf(document.activeElement as HTMLElement);
            if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
              e.preventDefault();
              buttons[(at + (e.key === "ArrowRight" ? 1 : buttons.length - 1)) % buttons.length]?.focus();
            } else if (e.key === "Tab" && !e.shiftKey && at === buttons.length - 1) {
              e.preventDefault();
              tabPast();
            } else if (e.key === "Tab" && e.shiftKey && at === 0) {
              e.preventDefault();
              quiet.current = true;
              trigger.current?.focus();
            }
          }}
          onDone={hide}
        />
      )}
    </>
  );
}

function ProfileCard({ id, bot, anchor, card, onPlaced, onDone, ...handlers }: {
  id: string;
  bot: Bot;
  anchor: RefObject<HTMLElement | null>;
  card: RefObject<HTMLDivElement | null>;
  onPlaced: () => void;
  onDone: () => void;
  onPointerEnter: () => void;
  onPointerLeave: (e: React.PointerEvent) => void;
  onBlur: (e: React.FocusEvent) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
}) {
  const thread = useBots((s) => directOf(s.conversations, bot.id)?.id);
  // A bot is set up in its details panel, which another device's workspace keeps to itself.
  const remote = !!useRemoteWorkspace();
  const [pos, setPos] = useState<Pos>();
  useLayoutEffect(() => {
    const r = anchor.current?.getBoundingClientRect();
    if (!r || !card.current) return;
    setPos(placeCard(r, card.current.offsetWidth, card.current.offsetHeight));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (pos) onPlaced();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!pos]);
  const go = (details: boolean) => {
    if (!thread) return;
    onDone();
    useBots.getState().select(thread);
    openBotsChat();
    if (details) openBotsDetails();
  };
  return createPortal(
    <div
      ref={card}
      id={id}
      role="dialog"
      aria-label={`${bot.name}'s profile`}
      className="bm-profile"
      data-side={pos?.side ?? "top"}
      data-state={pos ? "open" : "measuring"}
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0 }}
      {...handlers}
    >
      <div className="bm-profile-head">
        <BotAvatar look={bot.look} size={44} />
        <span className="bm-profile-name">{bot.name}</span>
      </div>
      <div className="bm-profile-actions">
        <button type="button" className="bm-profile-btn" disabled={!thread} onClick={() => go(false)}>
          Open chat
        </button>
        <button type="button" className="bm-profile-btn" disabled={!thread || remote} onClick={() => go(true)}>
          Edit profile
        </button>
      </div>
    </div>,
    document.body,
  );
}
