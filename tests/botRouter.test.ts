import { expect, test } from 'bun:test';
import type { Bot } from '../shared/bots';
import { routeGroup } from '../server/bots/router';
const primary = { id: 'primary', name: 'Primary', instructions: 'Coordinate', model: 'provider/model' } as Bot;
const helper = { id: 'helper', name: 'Researcher', instructions: 'Research' } as Bot;

test('router passes roles, bounded context and configured model without a visible turn', async () => {
  const result = await routeGroup(primary, [primary, helper], Array.from({ length: 30 }, () => ({ id: 'm', author: 'me', at: 1, text: 'x'.repeat(3000) })), 'default', async (model, system, prompt) => {
    expect(model).toBe(primary.model!);
    expect(system).toContain('Usually choose exactly one');
    const data = JSON.parse(prompt);
    expect(data.members[1].role).toBe('Research');
    expect(data.history.length).toBe(20);
    expect(data.history[0].text.length).toBe(2000);
    return '["helper"]';
  });
  expect(result).toEqual(['helper']);
});

test('error, invalid and timed out routing return primary exactly once', async () => {
  for (const output of ['[]', '{}', '["outsider"]', '["helper", 1]', 'oops']) {
    expect(await routeGroup(primary, [primary, helper], [], undefined, async () => output)).toEqual(['primary']);
  }
  expect(await routeGroup(primary, [primary, helper], [], undefined, async () => { throw new Error('offline'); })).toEqual(['primary']);
  let signal: AbortSignal | undefined;
  expect(await routeGroup(primary, [primary, helper], [], undefined, async (_m, _s, _p, s) => { signal = s; return new Promise(() => {}); }, 5)).toEqual(['primary']);
  expect(signal?.aborted).toBe(true);
});
