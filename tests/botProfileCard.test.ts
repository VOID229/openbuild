// A bot's profile card from its mascot beside its messages in a group chat, in a real Chrome: hovering,
// crossing onto the card, the keyboard, a tap, reduced motion, and both themes.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { browser, launchChrome, Page, serveFixture } from "./chromePage";

let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
let server: Awaited<ReturnType<typeof serveFixture>> | undefined;

beforeAll(async () => {
  if (!browser) return;
  server = await serveFixture(`${import.meta.dir}/fixtures/botScroll/index.html`);
  chrome = await launchChrome();
}, 60_000);

afterAll(async () => {
  await chrome?.close();
  await server?.stop();
});

const KEYS: Record<string, number> = { Tab: 9, Enter: 13, Escape: 27, ArrowRight: 39 };
/** The last mascot beside a bot's messages, which is in view at the bottom of the chat. */
const MASCOT = "[...document.querySelectorAll('.bm-theirs .bm-profile-trigger')].at(-1)";

class CardPage extends Page {
  mouse = { x: 900, y: 650 };
  /** A real pointer gliding to (x, y) a few pixels at a time, as a hand moves it. */
  async moveTo(x: number, y: number) {
    const from = this.mouse;
    const steps = Math.max(1, Math.ceil(Math.hypot(x - from.x, y - from.y) / 6));
    for (let i = 1; i <= steps; i++) {
      await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x + ((x - from.x) * i) / steps, y: from.y + ((y - from.y) * i) / steps });
    }
    this.mouse = { x, y };
  }
  async centre(expr: string) {
    return this.eval<[number, number]>(`(() => { const r = (${expr}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
  }
  async key(key: string, shift = false) {
    // Enter needs its character too, or a focused button isn't pressed.
    const down = key === "Enter" ? { type: "keyDown", text: "\r" } : { type: "rawKeyDown" };
    for (const event of [down, { type: "keyUp" }]) await this.send("Input.dispatchKeyEvent", { ...event, key, code: key, windowsVirtualKeyCode: KEYS[key], modifiers: shift ? 8 : 0 });
    await this.settle();
  }
  card() {
    return this.eval<{ name: string; buttons: string[]; side: string } | null>(`(() => {
      const card = document.querySelector('.bm-profile[data-state="open"]');
      return card && { name: card.querySelector('.bm-profile-name').textContent, buttons: [...card.querySelectorAll('button')].map((b) => b.textContent), side: card.dataset.side };
    })()`);
  }
  focused() {
    return this.eval<string>(`(() => { const el = document.activeElement; return el.closest('.bm-profile') ? 'card:' + el.textContent : el.matches('.bm-profile-trigger') ? 'mascot' : el.tagName; })()`);
  }
}

/** Group chat "b", its last message from manager. */
const open = async (width = 1000, height = 700) => {
  const page = await CardPage.open(chrome!.ws, server!.url.href, width, height, "!!document.querySelector('.bm-group')");
  await page.eval(`bots.getState().select("b")`);
  await page.until(`${MASCOT} !== undefined && bots.getState().activeId === "b"`);
  await page.settle();
  return page as CardPage;
};

describe.skipIf(!browser)("a bot's profile card", () => {
  test("shows on hover, stays while the pointer crosses onto it, and opens the bot's chat", async () => {
    const page = await open();
    const [x, y] = await page.centre(MASCOT);
    // A pointer over the mascot, wherever it is on it.
    expect(await page.eval(`getComputedStyle(document.elementFromPoint(${x}, ${y})).cursor`)).toBe("pointer");
    await page.moveTo(x, y);
    await page.until(`!!document.querySelector('.bm-profile[data-state="open"]')`);
    expect(await page.card()).toEqual({ name: "manager", buttons: ["Open chat", "Edit profile"], side: "top" });
    expect(await page.eval(`${MASCOT}.getAttribute('aria-expanded')`)).toBe("true");
    // Above the mascot and starting by it, not over the message.
    const fit = await page.eval<{ above: boolean; near: boolean }>(`(() => {
      const m = ${MASCOT}.getBoundingClientRect(), c = document.querySelector('.bm-profile').getBoundingClientRect();
      return { above: c.bottom <= m.top, near: Math.abs(c.left - m.left) <= 12 };
    })()`);
    expect(fit).toEqual({ above: true, near: true });
    // Across the gap and onto the buttons, slowly: the card stays.
    const [bx, by] = await page.centre(`[...document.querySelectorAll('.bm-profile-btn')].find((b) => b.textContent === "Open chat")`);
    await page.moveTo(bx, by);
    await Bun.sleep(400);
    expect(await page.card()).not.toBeNull();
    expect(await page.eval(`getComputedStyle(document.elementFromPoint(${bx}, ${by})).cursor`)).toBe("pointer");
    await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: bx, y: by, button: "left", clickCount: 1 });
    await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: bx, y: by, button: "left", clickCount: 1 });
    await page.until(`bots.getState().activeId === "a"`);
    expect(await page.eval(`!!document.querySelector('.bm-profile')`)).toBe(false);
    expect(await page.eval(`bots.getState().detailsOpen`)).toBe(false);
  }, 60_000);

  test("goes once the pointer leaves the mascot and card, and never shows for a pointer passing by", async () => {
    const page = await open();
    const [x, y] = await page.centre(MASCOT);
    // Straight past: no card.
    await page.moveTo(x, y);
    await page.moveTo(x + 400, y);
    await Bun.sleep(500);
    expect(await page.card()).toBeNull();
    await page.moveTo(x, y);
    await page.until(`!!document.querySelector('.bm-profile[data-state="open"]')`);
    await page.moveTo(x + 400, y + 10);
    await page.until(`!document.querySelector('.bm-profile')`);
    expect(await page.eval(`${MASCOT}.getAttribute('aria-expanded')`)).toBe("false");
  }, 60_000);

  test("Edit profile opens the bot's chat with its details", async () => {
    const page = await open();
    const [x, y] = await page.centre(MASCOT);
    await page.moveTo(x, y);
    await page.until(`!!document.querySelector('.bm-profile[data-state="open"]')`);
    await page.click(`.bm-profile-btn:last-child`);
    await page.until(`bots.getState().activeId === "a" && bots.getState().detailsOpen`);
    expect(await page.eval(`!!document.querySelector('.bm-profile')`)).toBe(false);
  }, 60_000);

  test("works from the keyboard: focus shows it, Tab goes in, arrows move, Escape comes back", async () => {
    const page = await open();
    // Focus what comes before the mascot (not an earlier mascot, whose own card would show), then a real Tab onto it.
    await page.eval(`(() => {
      const all = [...document.querySelectorAll('button:not([disabled]), [tabindex]:not([tabindex="-1"]), textarea, a[href]')].filter((el) => el.offsetParent !== null);
      const mascot = ${MASCOT};
      const before = all.slice(0, all.indexOf(mascot)).filter((el) => !el.matches('.bm-profile-trigger'));
      for (const el of all) if (el !== mascot && el.matches('.bm-profile-trigger')) el.tabIndex = -1;
      before.at(-1).focus();
    })()`);
    await page.key("Tab");
    expect(await page.focused()).toBe("mascot");
    await page.until(`!!document.querySelector('.bm-profile[data-state="open"]')`);
    await page.key("Tab");
    expect(await page.focused()).toBe("card:Open chat");
    await page.key("ArrowRight");
    expect(await page.focused()).toBe("card:Edit profile");
    await page.key("Tab", true);
    expect(await page.focused()).toBe("card:Open chat");
    await page.key("Tab", true);
    expect(await page.focused()).toBe("mascot");
    expect(await page.card()).not.toBeNull();
    await page.key("Tab");
    await page.key("Escape");
    expect(await page.card()).toBeNull();
    expect(await page.focused()).toBe("mascot");
    // Escape didn't also leave the chat or close anything else.
    expect(await page.eval(`bots.getState().activeId`)).toBe("b");
    // Enter opens it and goes straight to its first button; Tab off its end moves on and puts it away.
    await page.key("Enter");
    await page.until(`document.activeElement?.textContent === "Open chat"`);
    await page.key("Tab");
    await page.key("Tab");
    expect(await page.card()).toBeNull();
    expect(await page.focused()).not.toMatch(/^card:|^mascot$/);
    // Enter on a button does what a click does.
    await page.eval(`${MASCOT}.focus()`);
    await page.key("Enter");
    await page.until(`document.activeElement?.textContent === "Open chat"`);
    await page.key("Enter");
    await page.until(`bots.getState().activeId === "a"`);
  }, 60_000);

  test("a tap opens it on a touch screen, and a tap elsewhere puts it away", async () => {
    const page = await open(390, 760);
    await page.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    const tap = async (x: number, y: number) => {
      await page.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      await page.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await page.settle();
    };
    // Once the chat has slid in over the list.
    await page.until(`(() => { const x = ${MASCOT}.getBoundingClientRect().x; const was = window.lastX; window.lastX = x; return was === x; })()`);
    const [x, y] = await page.centre(MASCOT);
    await tap(x, y);
    await page.until(`!!document.querySelector('.bm-profile[data-state="open"]')`);
    // On screen at a phone's width.
    const inside = await page.eval(`(() => { const r = document.querySelector('.bm-profile').getBoundingClientRect(); return r.left >= 8 && r.right <= innerWidth - 8 && r.top >= 8; })()`);
    expect(inside).toBe(true);
    // Stays without a pointer resting on it.
    await Bun.sleep(400);
    expect(await page.card()).not.toBeNull();
    // A tap on an empty part of the chat, beside the messages.
    const [mx, my] = await page.eval<[number, number]>(`(() => { const r = document.querySelector('.bots-messages').getBoundingClientRect(); return [r.right - 12, r.top + 12]; })()`);
    await tap(mx, my);
    await page.until(`!document.querySelector('.bm-profile')`);
    // A tap on Open chat opens the chat.
    await tap(x, y);
    await page.until(`!!document.querySelector('.bm-profile[data-state="open"]')`);
    const [bx, by] = await page.centre(`document.querySelector('.bm-profile-btn')`);
    await tap(bx, by);
    await page.until(`bots.getState().activeId === "a"`);
  }, 60_000);

  test("doesn't animate with reduced motion, and follows the theme", async () => {
    const page = await open();
    const show = async () => {
      await page.eval(`${MASCOT}.click()`);
      await page.until(`!!document.querySelector('.bm-profile[data-state="open"]')`);
    };
    await show();
    expect(await page.eval(`getComputedStyle(document.querySelector('.bm-profile')).animationName`)).toBe("tip-in");
    await page.key("Escape");
    await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await show();
    expect(await page.eval(`getComputedStyle(document.querySelector('.bm-profile')).animationName`)).toBe("none");
    const colours = () =>
      page.eval<{ bg: string; text: string; surface: string }>(`(() => {
        const s = getComputedStyle(document.querySelector('.bm-profile'));
        const probe = document.createElement('div');
        probe.style.background = 'var(--surface-2)';
        document.body.append(probe);
        const surface = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return { bg: s.backgroundColor, text: s.color, surface };
      })()`);
    const dark = await colours();
    await page.eval(`document.documentElement.dataset.theme = "light"`);
    // Reduced motion leaves every transition a millisecond long.
    await page.until(`getComputedStyle(document.querySelector('.bm-profile')).backgroundColor !== ${JSON.stringify(dark.bg)}`);
    const light = await colours();
    expect(dark.bg).toBe(dark.surface);
    expect(light.bg).toBe(light.surface);
    expect(light.bg).not.toBe(dark.bg);
    expect(light.text).not.toBe(dark.text);
  }, 60_000);
});
