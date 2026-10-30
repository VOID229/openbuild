// The cursor a resize sets stays only as long as the drag does, and the new-thread screen starts
// with nothing open.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { trackDrag } from "../src/lib/ui";
import { usePanel } from "../src/lib/panel";
import { useStore } from "../src/lib/store";
import { refreshTerminal, useTerminal } from "../src/lib/terminal";

const pointer = (type: string, init: { pointerId?: number; buttons?: number; clientX?: number } = {}) =>
  Object.assign(new Event(type), { pointerId: 1, buttons: 1, ...init }) as unknown as PointerEvent;

describe("trackDrag", () => {
  const g = globalThis as unknown as { window?: unknown; document?: unknown };
  const saved = { window: g.window, document: g.document };
  let classes: Set<string>;
  let moved: number[];
  const start = () =>
    trackDrag(
      { preventDefault() {}, pointerId: 1, currentTarget: { setPointerCapture() {} } } as unknown as React.PointerEvent<HTMLElement>,
      "dragging",
      (ev) => moved.push(ev.clientX),
    );

  beforeEach(() => {
    classes = new Set();
    moved = [];
    g.window = new EventTarget();
    g.document = { body: { classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) } } };
  });
  afterEach(() => {
    g.window = saved.window;
    g.document = saved.document;
  });
  const fire = (e: Event) => (g.window as EventTarget).dispatchEvent(e);

  test("moves until the pointer is released, then stops", () => {
    start();
    expect(classes.has("dragging")).toBe(true);
    fire(pointer("pointermove", { clientX: 5 }));
    fire(pointer("pointerup"));
    fire(pointer("pointermove", { clientX: 9 }));
    expect(moved).toEqual([5]);
    expect(classes.size).toBe(0);
  });

  for (const type of ["pointercancel", "lostpointercapture"])
    test(`${type} ends it`, () => {
      start();
      fire(pointer(type));
      expect(classes.size).toBe(0);
    });

  test("losing the window ends it", () => {
    start();
    fire(new Event("blur"));
    expect(classes.size).toBe(0);
  });

  test("a release nobody saw ends it at the next move", () => {
    start();
    fire(pointer("pointermove", { buttons: 0, clientX: 5 }));
    expect(moved).toEqual([]);
    expect(classes.size).toBe(0);
  });

  test("another pointer doesn't end it", () => {
    start();
    fire(pointer("pointerup", { pointerId: 2 }));
    expect(classes.has("dragging")).toBe(true);
  });
});

describe("the new-thread screen", () => {
  const chat = (id: string, createdAt: number) => ({ id, createdAt }) as never;
  const open = () => {
    usePanel.getState().setPanel(true);
    usePanel.getState().setTree(true);
    useTerminal.setState({ open: true });
  };
  const showing = () => [usePanel.getState().panel, usePanel.getState().tree, useTerminal.getState().open];
  const go = (activeChatId?: string) => {
    useStore.setState({ activeChatId });
    refreshTerminal();
  };

  beforeEach(() => {
    useStore.setState({ chats: [chat("old", 0), chat("older", 0)], activeChatId: "old" });
    refreshTerminal();
    open();
  });

  test("closes what's open, and going back to a thread brings it back", () => {
    go(undefined);
    expect(showing()).toEqual([false, false, false]);
    go("old");
    expect(showing()).toEqual([true, true, true]);
  });

  test("moving between threads leaves it alone", () => {
    go("older");
    expect(showing()).toEqual([true, true, true]);
  });

  test("a thread started from it keeps what's open there, not what the last thread had", () => {
    go(undefined);
    usePanel.getState().setPanel(true);
    useStore.setState({ chats: [...useStore.getState().chats, chat("new", Date.now())] });
    go("new");
    expect(showing()).toEqual([true, false, false]);
  });
});
