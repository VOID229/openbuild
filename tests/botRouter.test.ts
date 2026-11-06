import { expect, test } from 'bun:test';
import type { Bot } from '../shared/bots';
import { routeGroup } from '../server/bots/router';
const primary = { id: 'primary', name: 'Primary', instructions: 'Coordinate', model: 'provider/model' } as Bot;
const helper = { id: 'helper', name: 'Researcher', instructions: 'Research' } as Bot;

test('router passes roles, bounded context and configured model without a visible turn', async () => {
  const result = await routeGroup(primary, [primary, helper], Array.from({ length: 30 }, () => ({ id: 'm', author: 'me', at: 1, text: 'x'.repeat(3000) })), { defaultModel: 'default' }, async (model, system, prompt) => {
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

test('router tries ordered fallback models without extending its deadline', async () => {
  const calls: string[] = [];
  const configured = { ...primary, fallbackModels: ['provider/model', 'account/second', 'account/third'] };
  expect(await routeGroup(configured, [primary, helper], [], undefined, async model => {
    calls.push(model);
    if (model !== 'account/third') throw new Error('unavailable');
    return '["helper"]';
  })).toEqual(['helper']);
  expect(calls).toEqual(['provider/model', 'account/second', 'account/third']);
  calls.length = 0;
  expect(await routeGroup(configured, [primary, helper], [], undefined, async model => {
    calls.push(model);
    return new Promise(() => {});
  }, 5)).toEqual(['primary']);
  expect(calls).toEqual(['provider/model']);
});

test('router inherits the default model and its fallbacks when the primary is on Default, as its replies do', async () => {
  const calls: string[] = [];
  const failing = async (model: string) => { calls.push(model); throw new Error('unavailable'); };
  const onDefault = { ...primary, model: undefined };
  const defaults = { defaultModel: 'd/main', defaultFallbackModels: ['e/backup', 'd/main', 'openai-codex-2/sol'] };
  expect(await routeGroup(onDefault, [primary, helper], [], defaults, failing)).toEqual(['primary']);
  expect(calls).toEqual(['d/main', 'e/backup', 'openai-codex-2/sol']);
  // No default model: Pi's default ("") leads, the default's fallbacks follow.
  calls.length = 0;
  await routeGroup(onDefault, [primary, helper], [], { defaultFallbackModels: ['e/backup'] }, failing);
  expect(calls).toEqual(['', 'e/backup']);
  // Its own fallbacks replace the default's; its own model keeps to its own list.
  calls.length = 0;
  await routeGroup({ ...onDefault, fallbackModels: ['g/own'] }, [primary, helper], [], defaults, failing);
  expect(calls).toEqual(['d/main', 'g/own']);
  calls.length = 0;
  await routeGroup(primary, [primary, helper], [], defaults, failing);
  expect(calls).toEqual(['provider/model']);
});
