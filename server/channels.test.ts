import { describe, expect, test } from 'bun:test';
import { channelInput, channelLine, slugFor } from './channels';

describe('slugFor', () => {
  test('makes a short, session-safe slug', () => {
    expect(slugFor('Taxes 2026!')).toBe('taxes-2026');
    expect(slugFor('#home automation')).toBe('home-automation');
    expect(slugFor('  Project — Launch  ')).toBe('project-launch');
  });

  test('folds accents instead of dropping the letter', () => {
    expect(slugFor('Cuánto')).toBe('cuanto');
    expect(slugFor('Büro')).toBe('buro');
  });

  test('never returns an empty or overlong slug', () => {
    expect(slugFor('!!!')).toBe('channel');
    expect(slugFor('')).toBe('channel');
    expect(slugFor('a'.repeat(100)).length).toBeLessThanOrEqual(24);
    expect(slugFor('many words here that go on and on forever')).not.toMatch(/-$/);
  });
});

describe('channelInput', () => {
  test('takes a name and an optional topic', () => {
    expect(channelInput({ name: ' #taxes ', topic: ' 2026 filing ' })).toEqual({ name: 'taxes', topic: '2026 filing' });
    expect(channelInput({ name: 'home' })).toEqual({ name: 'home' });
  });

  test('refuses a name that is empty, too long or has no letters', () => {
    expect(() => channelInput({ name: '   ' })).toThrow(/needs a name/);
    expect(() => channelInput({ name: 'x'.repeat(41) })).toThrow(/at most 40/);
    expect(() => channelInput({ name: '!!!' })).toThrow(/letter or number/);
  });

  test('there is only one general channel', () => {
    expect(() => channelInput({ name: 'General' })).toThrow(/already a general/);
    expect(() => channelInput({ name: '#general!' })).toThrow(/already a general/);
  });

  test('collapses whitespace and truncates a long topic', () => {
    const input = channelInput({ name: 'work', topic: `${'x'.repeat(300)}\n\nmore` });
    expect(input.topic!.length).toBe(200);
    expect(channelInput({ name: 'work', topic: 'a    b' }).topic).toBe('a b');
  });
});

describe('channelLine', () => {
  test('general is the main thread, and says so', () => {
    expect(channelLine({ name: 'general' }, true)).toContain('general channel');
    expect(channelLine({ name: 'general', topic: 'Briefs' }, true)).toContain('Its topic: Briefs');
  });

  test('another channel is its own thread with shared memory', () => {
    const line = channelLine({ name: 'taxes', topic: '2026 filing' }, false);
    expect(line).toContain('#taxes');
    expect(line).toContain('2026 filing');
    expect(line).toContain('shared');
  });
});