import { expect, test } from 'bun:test';
import type { Item } from '../shared/types';
import { userTaskInstructions, userTaskTitle } from './usertask';

const msg = (kind: Item['kind'], text: string): Item => ({ id: text, kind, text, created_at: 0, updated_at: 0, run_id: null, task_id: null }) as Item;

test('the title is the first line, whitespace collapsed', () => {
  expect(userTaskTitle('  Find a cheaper   GPU host\nunder $1/hr, US only ')).toBe('Find a cheaper GPU host');
});

test('a long title is cut at a word boundary with an ellipsis', () => {
  const t = userTaskTitle('Compare every hosting provider we use against the three cheapest alternatives and estimate savings', 60);
  expect(t.length).toBeLessThanOrEqual(60);
  expect(t.endsWith('…')).toBe(true);
  expect(t).toBe('Compare every hosting provider we use against the three…');
});

test('one unbroken word is cut hard rather than left empty', () => {
  const t = userTaskTitle(`what was this doing local-${'a'.repeat(100)}`, 40);
  expect(t.length).toBeLessThanOrEqual(40);
  expect(t.startsWith('what was this doing local-aaa')).toBe(true);
});

test('instructions carry the request verbatim and the recent chat, oldest first', () => {
  const recent = [msg('user', 'old one'), msg('assistant', 'Deploy failed: 502 from the worker'), msg('card', 'a card'), msg('user', 'hmm')];
  const s = userTaskInstructions('  look into that error  ', recent);
  expect(s).toContain('Their request, in their own words:\n\nlook into that error');
  expect(s).toContain('User: old one\nYou: Deploy failed: 502 from the worker\nUser: hmm');
  expect(s).not.toContain('a card');
});

test('only the last six chat messages are included, each clipped', () => {
  const recent = Array.from({ length: 10 }, (_, i) => msg('user', `m${i} ${'x'.repeat(500)}`));
  const s = userTaskInstructions('go', recent);
  expect(s).not.toContain('m3 ');
  expect(s).toContain('m4 ');
  expect(s).toContain('…');
  expect(s.length).toBeLessThan(3200);
});

test('no recent chat means no context section', () => {
  expect(userTaskInstructions('go', [])).not.toContain('main chat with you, in case');
});
