import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnScript } from "./spawnScript";

// The sidebar's order is saved with the bots' settings, on the server: only chats that are there,
// each once; an empty one is no order at all. The script runs against a data directory of its own,
// in a process of its own.
test("the saved sidebar order keeps only chats that exist, each once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-sidebar-order-"));
  try {
    const { code, stderr } = await spawnScript(`
      import { strict as a } from 'node:assert';
      const svc = await import('./server/bots/service.ts');
      svc.setHooks({ wake() {}, stop() {} });
      const one = svc.createBot({ name: 'One' }).conversationId;
      const two = svc.createBot({ name: 'Two' }).conversationId;
      a.equal(svc.getSettings().order, undefined);
      svc.updateSettings({ order: [two, 'gone', one, two, 5] });
      a.deepEqual(svc.getSettings().order, [two, one]);
      // Saving something else leaves it as it was.
      svc.updateSettings({ quietHours: { from: 1, to: 6 } });
      a.deepEqual(svc.getSettings().order, [two, one]);
      svc.updateSettings({ order: [] });
      a.equal(svc.getSettings().order, undefined);
    `, { OPENCHAT_DATA_DIR: dir, PI_CODING_AGENT_DIR: join(dir, "pi") });
    expect(stderr).toBe("");
    expect(code).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
