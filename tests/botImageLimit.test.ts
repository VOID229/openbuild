// One limit for a picture in a bot message (MAX_IMAGE_DATA_URL, shared/attachments.ts): the server takes
// a data URL of exactly that length and refuses a longer one, from the user or from a bot. A bot that
// sends an image file or a screenshot too large is told so, with what to do, before anything is posted.
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnScript } from "./spawnScript";

test("a picture is taken up to the shared limit and refused past it, from the user or a bot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-bots-images-"));
  try {
    const { code, stderr: err, stdout: out } = await spawnScript(`
      import { strict as a } from 'node:assert';
      import { mock } from 'bun:test';
      import { MAX_IMAGE_DATA_URL } from './shared/attachments.ts';
      // The bot's computer: a file read gives its base64, a screenshot its own.
      let file = '';
      let shot = '';
      mock.module('./server/computers/index.ts', () => ({ capabilities: async () => ({ engines: [] }), engines: async () => [], procListeners: new Set() }));
      mock.module('./server/computers/api.ts', () => ({
        computerApi: () => ({ call: async (id, op, body) => (op === 'fs' ? { data: file } : op === 'browser' ? { data: shot, mimeType: 'image/jpeg' } : {}) }),
        computerTargets: async () => [],
      }));
      const db = await import('./server/bots/db.ts');
      const svc = await import('./server/bots/service.ts');
      const { sendMessage, setFocus } = await import('./server/bots/agent.ts');
      const { bot, conversationId } = svc.createBot({ name: 'Lens' });
      setFocus(bot.id, conversationId);
      const posted = () => db.messages(conversationId, 50).map((r) => r.message).filter((m) => m.images?.length).map((m) => m.images.map((i) => i.length));
      a.equal(MAX_IMAGE_DATA_URL, 2_500_000);

      // The user's own message: exactly the limit goes, one character more doesn't.
      const png = (length) => { const head = 'data:image/png;base64,'; return head + 'A'.repeat(length - head.length); };
      svc.postMessage(conversationId, { id: crypto.randomUUID(), author: 'me', at: Date.now(), text: 'fits', images: [png(MAX_IMAGE_DATA_URL)] });
      a.throws(() => svc.postMessage(conversationId, { id: crypto.randomUUID(), author: 'me', at: Date.now(), text: 'over', images: [png(MAX_IMAGE_DATA_URL + 1)] }), /An image is too large/);
      a.deepEqual(posted(), [[MAX_IMAGE_DATA_URL]]);

      // A bot's image file is measured as the data URL the chat gets, its type and all.
      const head = 'data:image/png;base64,'.length;
      file = 'A'.repeat(MAX_IMAGE_DATA_URL - head);
      await sendMessage(bot.id, { text: 'Here', images: ['/work/shot.png'] });
      a.deepEqual(posted().at(-1), [MAX_IMAGE_DATA_URL]);
      file += 'A';
      await a.rejects(sendMessage(bot.id, { text: 'Here', images: ['/work/shot.png'] }), /\\/work\\/shot.png is too large to send \\(the chat takes images up to 1.8 MB; save a smaller or JPEG copy and send that\\)/);
      file = 'A'.repeat(MAX_IMAGE_DATA_URL + 1);
      await a.rejects(sendMessage(bot.id, { text: 'Here', images: ['/work/shot.png'] }), /shot.png is too large to send/);
      // And its browser's screenshot.
      shot = 'A'.repeat(MAX_IMAGE_DATA_URL);
      await a.rejects(sendMessage(bot.id, { text: 'Look', attach_screenshot: true }), /That screenshot is too large to send/);
      a.equal(posted().length, 2);
      process.exit(0);
    `, { OPENCHAT_DATA_DIR: dir });
    expect(err + out).toBe("");
    expect(code).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
