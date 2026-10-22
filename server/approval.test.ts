import { expect, test } from 'bun:test';
import type { CardData, Item } from '../shared/types';
import { approvalDecision, approvalPrompt } from './approval';

const card = (extra: Partial<CardData> = {}): CardData => ({ type: 'approval', title: 'Send the reply to Dana', status: 'pending', ...extra });
const item = (c: CardData): Item => ({ id: 'c1', kind: 'card', created_at: 0, updated_at: 0, card: c });

test('decline ignores any edited text, and unknown actions are rejected', () => {
  expect(approvalDecision(card({ draft: 'Hi Dana' }), 'decline', 'Hello Dana')).toEqual({ approved: false });
  expect(() => approvalDecision(card(), 'choose', 'x')).toThrow('invalid action');
});

test('approving without a change, or from a push action, keeps the original draft', () => {
  const c = card({ draft: 'Hi Dana,\nsee you at 3.' });
  expect(approvalDecision(c, 'approve', undefined)).toEqual({ approved: true });
  expect(approvalDecision(c, 'approve', '  Hi Dana,\nsee you at 3.\n')).toEqual({ approved: true });
  // No draft on the card: a stray value is not treated as an edit.
  expect(approvalDecision(card(), 'approve', 'something')).toEqual({ approved: true });
});

test('an edited draft comes back trimmed; empty or oversized edits are refused', () => {
  const c = card({ draft: 'Hi Dana, see you at 3.' });
  expect(approvalDecision(c, 'approve', ' Hi Dana, see you at 4. ')).toEqual({ approved: true, draft: 'Hi Dana, see you at 4.' });
  expect(() => approvalDecision(c, 'approve', '   ')).toThrow('empty');
  expect(() => approvalDecision(c, 'approve', 'x'.repeat(9000))).toThrow('too long');
});

test('Hermes-native approvals are never editable', () => {
  const c = card({ draft: 'rm -rf build', hermes: { kind: 'approval', run_id: 'r', request_id: 'q', generation: 1 } });
  expect(approvalDecision(c, 'approve', 'rm -rf /')).toEqual({ approved: true });
});

test('the resume prompt hands an edited draft back verbatim', () => {
  const edited = approvalPrompt(item(card({ draft: 'Hi Dana, 4pm works.', edited: true, action_label: 'Send' })), true);
  expect(edited).toStartWith('[approval c1] APPROVED with edits: "Send the reply to Dana"');
  expect(edited).toContain('Send exactly the text below');
  expect(edited).toEndWith('\n\nHi Dana, 4pm works.');
  expect(approvalPrompt(item(card({ draft: 'Hi' })), true)).toContain('sending the draft exactly as it was');
  expect(approvalPrompt(item(card()), true)).not.toContain('draft');
  expect(approvalPrompt(item(card({ draft: 'Hi', edited: true })), false)).toStartWith('[approval c1] NOT NOW');
});
