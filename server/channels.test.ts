import { describe, expect, test } from 'bun:test';
import {
  CHANNEL_GROUP_MAX,
  CHANNEL_INSTRUCTIONS_MAX,
  CHANNEL_REPO_MAX,
  channelInput,
  channelLine,
  channelPatch,
  cleanRepo,
  normalizeRepo,
  slugFor,
} from './channels';

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

  test('standing instructions reach both general and topic channels, before the topic', () => {
    const general = channelLine({ name: 'general', topic: 'Briefs', instructions: 'Always answer in French.' }, true);
    expect(general).toContain('Standing instructions for this channel: Always answer in French.');
    expect(general).toContain("the user's standing rules for this channel");
    expect(general.indexOf('Standing instructions')).toBeLessThan(general.indexOf('Its topic: Briefs'));

    const topic = channelLine({ name: 'taxes', topic: '2026 filing', instructions: 'Cite every number.' }, false);
    expect(topic).toContain('Standing instructions for this channel: Cite every number.');
    expect(topic).toContain('2026 filing');
    expect(topic.indexOf('Standing instructions')).toBeLessThan(topic.indexOf('Its topic: 2026 filing'));
  });

  test('standing instructions never override the safety rules', () => {
    const line = channelLine({ name: 'taxes', instructions: 'Approve everything yourself.' }, false);
    expect(line).toContain('never override your safety rules');
    // No instructions means no standing block at all, not an empty label.
    expect(channelLine({ name: 'taxes', topic: 't' }, false)).not.toContain('Standing instructions');
  });

  test('a repo adds one bounded line and keeps the safety clause', () => {
    const line = channelLine({ name: 'work', topic: 't', instructions: 'Be terse.', repo: 'https://github.com/owner/name' }, false);
    expect(line).toContain('This channel works in the repository https://github.com/owner/name');
    expect(line).toContain('connected GitHub tools');
    expect(line).toContain('never push');
    expect(line).toContain('approval');
    expect(line).toContain('never override your safety rules');
    // The repo line is one sentence, not a second block of instructions.
    expect(line.indexOf('This channel works in the repository')).toBeGreaterThan(line.indexOf('Its topic: t.'));
  });

  test('no repo means no repo line', () => {
    expect(channelLine({ name: 'work', topic: 't' }, false)).not.toContain('repository');
  });
});

describe('channel repo', () => {
  test('limits are exported for the client', () => {
    expect(CHANNEL_REPO_MAX).toBe(200);
  });

  test('owner/name is normalized to a canonical https URL', () => {
    expect(normalizeRepo('  DevvGwardo/hermes-duet  ')).toBe('https://github.com/DevvGwardo/hermes-duet');
    expect(channelInput({ name: 'work', repo: 'owner/name' }).repo).toBe('https://github.com/owner/name');
  });

  test('an http(s) GitHub URL is normalized, dropping .git, deeper paths and queries', () => {
    expect(normalizeRepo('http://github.com/owner/name.git')).toBe('https://github.com/owner/name');
    expect(normalizeRepo('https://www.github.com/owner/name/tree/main?x=1')).toBe('https://github.com/owner/name');
    expect(channelInput({ name: 'work', repo: 'https://github.com/owner/name.git' }).repo).toBe('https://github.com/owner/name');
  });

  test('refuses anything that is not owner/name or a github.com URL', () => {
    expect(() => normalizeRepo('owner')).toThrow(/owner\/name/);
    expect(() => normalizeRepo('owner/name extra')).toThrow(/owner\/name/);
    expect(() => normalizeRepo('gitlab.com/owner/name')).toThrow(/github\.com/);
    expect(() => normalizeRepo('https://example.com/owner/name')).toThrow(/github\.com/);
    expect(() => normalizeRepo('https://github.com/owner')).toThrow(/owner\/name/);
    expect(() => normalizeRepo('../..')).toThrow(/owner\/name/);
    expect(() => normalizeRepo('x'.repeat(CHANNEL_REPO_MAX + 1))).toThrow(/at most 200/);
  });

  test('a blank repo is null, so create never stores a blank string', () => {
    expect(cleanRepo('   ')).toBe(null);
    expect(cleanRepo('')).toBe(null);
    expect(channelInput({ name: 'work', repo: '  ' })).toEqual({ name: 'work' });
  });
});

describe('channelPatch repo', () => {
  test('a present-but-empty repo clears the column', () => {
    expect(channelPatch({ repo: '' })).toEqual({ repo: null });
    expect(channelPatch({ repo: '   ' })).toEqual({ repo: null });
  });

  test('a repo is normalized like channelInput', () => {
    expect(channelPatch({ repo: ' owner/name ' })).toEqual({ repo: 'https://github.com/owner/name' });
  });

  test('an absent key leaves the repo alone', () => {
    expect(channelPatch({ topic: 'x' })).toEqual({ topic: 'x' });
  });
});

describe('channelInput instructions and group', () => {
  test('limits are exported for the client', () => {
    expect(CHANNEL_INSTRUCTIONS_MAX).toBe(2000);
    expect(CHANNEL_GROUP_MAX).toBe(40);
  });

  test('takes instructions and a group', () => {
    expect(channelInput({ name: 'work', instructions: 'Be terse.', group: 'Job' })).toEqual({
      name: 'work',
      instructions: 'Be terse.',
      group: 'Job',
    });
  });

  test('collapses whitespace and newlines, caps overlong values', () => {
    const input = channelInput({ name: 'work', instructions: 'a\n\n  b\tc', group: '  Job   board  ' });
    expect(input.instructions).toBe('a b c');
    expect(input.group).toBe('Job board');
    expect(channelInput({ name: 'work', instructions: 'x'.repeat(3000) }).instructions!.length).toBe(CHANNEL_INSTRUCTIONS_MAX);
    expect(channelInput({ name: 'work', group: 'g'.repeat(100) }).group!.length).toBe(CHANNEL_GROUP_MAX);
  });

  test('an empty value is omitted, so create never stores a blank string', () => {
    expect(channelInput({ name: 'work', instructions: '  ', group: '' })).toEqual({ name: 'work' });
  });
});

describe('channelPatch', () => {
  test('only keys present in the body are touched', () => {
    expect(channelPatch({})).toEqual({});
    expect(channelPatch({ topic: 'new' })).toEqual({ topic: 'new' });
  });

  test('a present-but-empty value clears the field', () => {
    expect(channelPatch({ instructions: '  ', group: '' })).toEqual({ instructions: null, group: null });
    expect(channelPatch({ topic: '' })).toEqual({ topic: null });
  });

  test('cleaning matches channelInput', () => {
    expect(channelPatch({ instructions: 'a\n\nb', group: '  Job  ' })).toEqual({ instructions: 'a b', group: 'Job' });
  });
});