import { expect, test } from 'bun:test';
import { type Steer, undeliveredSteers } from './steer';

const note = '(Cards of yours still waiting on the user\'s tap:\n- [approval a1] Email Sam)\n\n';

test('a steer Hermes returns as pending_steer is replayed as its raw text', () => {
  const steers: Steer[] = [{ sent: `${note}never mind, don't send it`, raw: "never mind, don't send it" }];
  // Hermes strips each steer and joins undelivered ones with "\n".
  const late = undeliveredSteers(steers, `earlier steer\n${steers[0].sent.trim()}`);
  expect(late.map((s) => s.raw)).toEqual(["never mind, don't send it"]);
});

test('only the steers still in pending_steer come back, in the order they were sent', () => {
  const steers: Steer[] = [
    { sent: 'first', raw: 'first' },
    { sent: 'second', raw: 'second' },
    { sent: 'third', raw: 'third' },
  ];
  expect(undeliveredSteers(steers, 'second\nthird').map((s) => s.raw)).toEqual(['second', 'third']);
  expect(undeliveredSteers(steers, undefined)).toEqual([]);
  expect(undeliveredSteers(steers, '   ')).toEqual([]);
});

test('a delivered steer that is a substring of the undelivered one is not replayed in its place', () => {
  // Hermes delivered "send it" into an earlier tool batch, then the user said "don't send it" too late.
  const steers: Steer[] = [
    { sent: 'send it', raw: 'send it' },
    { sent: "don't send it", raw: "don't send it" },
  ];
  expect(undeliveredSteers(steers, "don't send it").map((s) => s.raw)).toEqual(["don't send it"]);
  // Same shape with two words that are a prefix of a longer retraction.
  const prefix: Steer[] = [
    { sent: 'do it', raw: 'do it' },
    { sent: 'do it tomorrow', raw: 'do it tomorrow' },
  ];
  expect(undeliveredSteers(prefix, 'do it tomorrow').map((s) => s.raw)).toEqual(['do it tomorrow']);
});

test('identical messages replay once per undelivered copy, and an already queued one never', () => {
  const steers: Steer[] = [
    { sent: 'ok', raw: 'ok' },
    { sent: 'ok', raw: 'ok' },
  ];
  expect(undeliveredSteers(steers, 'ok')).toHaveLength(1);
  const refused: Steer[] = [{ sent: 'stop', raw: 'stop', queued: true }];
  expect(undeliveredSteers(refused, 'stop')).toEqual([]);
});
