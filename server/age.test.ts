import { expect, test } from 'bun:test';
import type { CardData, Item } from '../shared/types';
import { OLD_ASK_MS, askAge } from '../shared/age';
import { approvalPrompt } from './approval';
import { decisionPrompt } from './prompts';

const tz = 'America/New_York';
// Wed Oct 21 2026, 9:14 PM in New York (UTC-4).
const posted = Date.parse('2026-10-22T01:14:00Z');
const hours = (h: number) => posted + h * 3600_000;

test('a card stays fresh the same evening, and is old after midnight or after six hours', () => {
  expect(askAge(posted, hours(1), tz)).toBeNull();
  // 12:05 AM the next day: "tomorrow" in the draft is now today.
  expect(askAge(posted, hours(2.85), tz)).toBe('yesterday at 9:14 PM');
  expect(askAge(posted, hours(48), tz)).toBe('on Wed, Oct 21 at 9:14 PM');
  // Posted 7 AM, answered past the threshold the same day.
  const morning = Date.parse('2026-10-22T11:00:00Z');
  expect(askAge(morning, morning + OLD_ASK_MS - 60_000, tz)).toBeNull();
  expect(askAge(morning, morning + OLD_ASK_MS, tz)).toBe('earlier today at 7:00 AM');
});

const at = (c: Partial<CardData>): Item => ({ id: 'c1', kind: 'card', created_at: posted, updated_at: posted, card: { type: 'approval', title: 'Reply to Dana', status: 'approved', ...c } });

test('an old approval resumes with a check before acting; a fresh one does not', () => {
  const age = 'yesterday at 9:14 PM';
  const fresh = approvalPrompt(at({ draft: 'See you tomorrow' }), true);
  expect(fresh).not.toContain('posted');
  const old = approvalPrompt(at({ draft: 'See you tomorrow' }), true, age);
  expect(old).toStartWith('[approval c1] APPROVED: "Reply to Dana"');
  expect(old).toContain('This card was posted yesterday at 9:14 PM, not just now.');
  expect(old).toContain('"tomorrow"');
  expect(old).toContain('post a fresh request_approval');
  // Declining needs no check: nothing happens either way.
  expect(approvalPrompt(at({}), false, age)).not.toContain('posted');
});

test('an edited old draft keeps the user text last and skips the relative-date check', () => {
  const p = approvalPrompt(at({ draft: 'See you Friday', edited: true }), true, 'yesterday at 9:14 PM');
  expect(p).toEndWith('\n\nSee you Friday');
  expect(p).toContain('already done');
  expect(p).not.toContain('"tomorrow"');
});

test('an old answer is flagged in the decision prompt', () => {
  const q = at({ type: 'choice', title: 'Which flight?', options: ['7 AM', '9 AM'], status: 'answered' });
  expect(decisionPrompt(q, { answer: '7 AM' })).toBe('[answer c1] To "Which flight?" the user chose: "7 AM". Continue accordingly.');
  expect(decisionPrompt(q, { answer: '7 AM' }, 'on Wed, Oct 21 at 9:14 PM')).toContain('This question was asked on Wed, Oct 21 at 9:14 PM');
});
