import { expect, test } from 'bun:test';
import { startScheduler } from './scheduler';

test('disabled scheduler starts nothing and returns', () => {
  expect(process.env.DUET_DISABLE_SCHEDULER).toBe('1');
  expect(startScheduler()).toBeUndefined();
});

test('starting the disabled scheduler twice is safe', () => {
  expect(() => {
    startScheduler();
    startScheduler();
  }).not.toThrow();
});
