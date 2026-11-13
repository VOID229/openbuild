// Watching mascots that should hold still (a hover card's, a thread row's): every 50ms, where each one's
// body and eyes are drawn on screen, its face, what it's flagged as doing, and what's animating it.
import type { Page } from "./chromePage";

/** What the mascots under a root did while watched: how many there were, and how many ways each was drawn. */
export type Stillness = {
  bots: number;
  /** The most different ways one of them was drawn (1: it never moved, blinked or changed face). */
  poses: number;
  /** Any that had a life of their own (.bot-alive). */
  alive: number;
  /** Anything they were flagged as doing: busy, asleep, blinking, a move, a look, following the pointer, dots. */
  flags: string[];
  /** The most animations running in one of them at once. */
  animations: number;
  /** Any "zzz" over them. */
  zzz: number;
};

const FLAGS = ["busy", "asleep", "blink", "action", "looking", "tracking", "dots"];

/** Starts watching every mascot under `root` (an expression for an element in the page). */
export const watchMascots = (page: Page, root: string) =>
  page.eval<boolean>(`(() => {
    const root = ${root};
    const seen = { poses: [], flags: new Set(), alive: 0, animations: 0, zzz: 0, bots: 0 };
    const box = (el) => { const r = el.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map((n) => n.toFixed(1)).join(','); };
    const look = () => {
      const bots = [...root.querySelectorAll('.bot')];
      seen.bots = Math.max(seen.bots, bots.length);
      bots.forEach((b, i) => {
        const drawn = [box(b.querySelector('.bot-shape')), ...[...b.querySelectorAll('.bot-eye-fill, .bot-eye-heart')].map(box), b.dataset.mood, b.dataset.eyes].join('|');
        (seen.poses[i] ??= new Set()).add(drawn);
        if (b.classList.contains('bot-alive')) seen.alive++;
        for (const f of ${JSON.stringify(FLAGS)}) if (f in b.dataset) seen.flags.add(f);
        seen.animations = Math.max(seen.animations, b.getAnimations({ subtree: true }).filter((a) => a.playState === 'running').length);
        seen.zzz = Math.max(seen.zzz, b.querySelectorAll('.bot-zzz').length);
      });
    };
    look();
    window.__still = { seen, timer: setInterval(look, 50) };
    return true;
  })()`);

/** Stops watching, and what they did meanwhile. */
export const stillness = (page: Page) =>
  page.eval<Stillness>(`(() => {
    const { seen, timer } = window.__still;
    clearInterval(timer);
    return { bots: seen.bots, poses: Math.max(0, ...seen.poses.map((p) => p.size)), alive: seen.alive, flags: [...seen.flags].sort(), animations: seen.animations, zzz: seen.zzz };
  })()`);

/** What still mascots, `bots` of them, look like watched. */
export const still = (bots: number): Stillness => ({ bots, poses: 1, alive: 0, flags: [], animations: 0, zzz: 0 });
