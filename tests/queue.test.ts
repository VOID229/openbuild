// Messages queued while a reply streams: order is kept, and an edited one goes back in its place.
import { describe, expect, test } from "bun:test";
import { enqueue, moveQueued, queueOf, removeQueued, shiftQueue, useQueue } from "../src/lib/queue";

const item = (id: string) => ({ id, text: id, files: [] });
const ids = () => queueOf("c").map((q) => q.id);

describe("queue", () => {
  test("first in, first out; an edited message returns to its slot", () => {
    enqueue("c", item("a"));
    enqueue("c", item("b"));
    enqueue("c", item("c"));
    removeQueued("c", "b");
    enqueue("c", item("b"), 1);
    expect(ids()).toEqual(["a", "b", "c"]);
    expect(shiftQueue("c")?.id).toBe("a");
    expect(ids()).toEqual(["b", "c"]);
  });
  test("an emptied queue leaves no entry behind", () => {
    shiftQueue("c");
    shiftQueue("c");
    expect(shiftQueue("c")).toBeUndefined();
    expect(useQueue.getState().queues).toEqual({});
  });
});

describe("reorder", () => {
  test("a dragged message lands in the new slot; out-of-range slots clamp", () => {
    for (const id of ["a", "b", "c"]) enqueue("r", item(id));
    const order = () => queueOf("r").map((q) => q.id);
    moveQueued("r", "c", 0);
    expect(order()).toEqual(["c", "a", "b"]);
    moveQueued("r", "c", 2);
    expect(order()).toEqual(["a", "b", "c"]);
    moveQueued("r", "a", 99);
    expect(order()).toEqual(["b", "c", "a"]);
    moveQueued("r", "b", -1);
    expect(order()).toEqual(["b", "c", "a"]);
  });
});
