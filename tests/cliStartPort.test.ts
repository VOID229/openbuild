import { expect, test } from "bun:test";
import { chooseStartPort, portAvailable } from "../bin/startPort";

test("an unmanaged listener survives selection and the selected port can complete a lifecycle", async () => {
  const listener = Bun.serve({ hostname: "0.0.0.0", port: 0, fetch: () => new Response("original listener") });
  let selected: ReturnType<typeof Bun.serve> | undefined;
  try {
    const port = await chooseStartPort(listener.port!, { explicit: false, interactive: true, confirm: async (question) => {
      expect(question).toContain("left running");
      return true;
    } });
    expect(port).toBeGreaterThan(listener.port!);
    selected = Bun.serve({ hostname: "0.0.0.0", port, fetch: () => new Response("selected listener") });
    // This is the same port passed to the server and saved by start for status/stop.
    expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe("selected listener");
    await selected.stop(true);
    expect(await portAvailable(port)).toBe(true);
    expect(await (await fetch(`http://127.0.0.1:${listener.port}`)).text()).toBe("original listener");
  } finally {
    await selected?.stop(true);
    await listener.stop(true);
  }
});

for (const explicit of [false, true]) test(`occupied port fails without prompting (${explicit ? "explicit" : "noninteractive"})`, async () => {
  let prompted = false;
  await expect(chooseStartPort(3100, { explicit, interactive: !explicit ? false : true, available: async () => false,
    confirm: async () => { prompted = true; return true; },
  })).rejects.toThrow("PORT=<port> ob start");
  expect(prompted).toBe(false);
});

test("declining preserves listener and skips occupied alternatives", async () => {
  const probed: number[] = [];
  await expect(chooseStartPort(3100, { explicit: false, interactive: true,
    available: async (port) => { probed.push(port); return port === 3102; },
    confirm: async (question) => { expect(question).toContain("3102"); return false; },
  })).rejects.toThrow("cancelled");
  expect(probed).toEqual([3100, 3101, 3102]);
});

test("rechecks a candidate after confirmation", async () => {
  let first = true;
  expect(await chooseStartPort(3100, { explicit: false, interactive: true,
    available: async (port) => port === 3102 || (port === 3101 && first),
    confirm: async () => { first = false; return true; },
  })).toBe(3102);
});
