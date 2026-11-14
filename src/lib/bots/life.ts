// OpenBots: one life for every avatar of the same bot doing the same thing. A bot shows in several
// places at once (a chat's header, its working row, the sidebar), and in the reference recording
// every one of them moves as one: the same clip, the same look, the same blink, at the same moment.
// So a routine isn't each avatar's own: it's a timeline kept here, by key (the bot and what it's at),
// that every avatar showing it reads from. An avatar that joins late picks it up where it has got to.
import type { Step } from "./routines";

/** A step on the timeline: what, from when (the page's clock, ms), and for how long. */
export interface Timed {
  what: Step[0];
  at: number;
  ms: number;
  /** Its place on the timeline, counting from the first. */
  index: number;
}

export class Life {
  private steps: Timed[] = [];
  private count = 0;
  /** When it last started over (`restart`), so a second avatar asking at the same moment doesn't start it again. */
  private restarted = -Infinity;
  constructor(
    /** When it began, on the page's clock. */
    readonly start: number,
    private next: () => Step[],
  ) {}

  private end() {
    const last = this.steps.at(-1);
    return last ? last.at + last.ms : this.start;
  }

  private push(steps: Step[], from: number) {
    let at = from;
    for (const [what, ms] of steps) {
      this.steps.push({ what, at, ms, index: this.count++ });
      at += ms;
    }
  }

  /**
   * The steps due since the one at `seen` (its index; -1 for none yet), up to `now`, and when the next
   * one is due. The timeline is laid down ahead as far as it's asked for, and forgets what's long past.
   */
  due(seen: number, now: number): { steps: Timed[]; next: number } {
    // (A routine always takes some time, so this ends.)
    for (let guard = 0; this.end() <= now && guard < 1000; guard++) this.push(this.next(), this.end());
    const steps = this.steps.filter((s) => s.index > seen && s.at <= now);
    const next = this.steps.find((s) => s.at > now)?.at ?? this.end();
    // A minute's worth back is plenty for anyone catching up.
    while (this.steps.length > 1 && this.steps[0]!.at + this.steps[0]!.ms < now - 60_000) this.steps.shift();
    return { steps, next };
  }

  /**
   * Starts over at `now` with `steps` and then the routine as usual, unless it has just done so: every
   * avatar of the bot sees the same moment (three dots ending), and only the first of them asks.
   */
  restart(now: number, steps: Step[]) {
    if (now - this.restarted < 250) return;
    this.restarted = now;
    this.steps = this.steps.filter((s) => s.at < now && s.at + s.ms <= now);
    this.push(steps, now);
  }
}

const lives = new Map<string, { life: Life; users: number }>();

/**
 * The life kept under `key`, begun now with `next` for its routine if no avatar has it yet. `leave`
 * when done with it: once the last avatar has, it's dropped, and the next to come starts afresh.
 */
export function joinLife(key: string, next: () => Step[], now: number): { life: Life; leave: () => void } {
  let entry = lives.get(key);
  if (!entry) lives.set(key, (entry = { life: new Life(now, next), users: 0 }));
  entry.users++;
  const held = entry;
  let left = false;
  return {
    life: held.life,
    leave: () => {
      if (left) return;
      left = true;
      if (--held.users <= 0 && lives.get(key) === held) lives.delete(key);
    },
  };
}
