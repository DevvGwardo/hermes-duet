import { expect, test } from 'bun:test';
import type { CardData, Item } from '../shared/types';
import { approvalDecision, approvalPrompt, approvalPush, deadPrompts } from './approval';

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

test('an approval push offers one-tap Approve only when there is no draft to read', () => {
  const plain = approvalPush(item(card({ action_label: 'Send' })));
  expect(plain).toMatchObject({ title: 'Needs your OK', body: 'Send the reply to Dana', card_id: 'c1', approval: true, action_label: 'Send', tag: 'c1', url: '/?card=c1' });
  expect(plain.must_read).toBeUndefined();
  const drafted = approvalPush(item(card({ draft: 'Hi Dana,\nsee you at 3.' })));
  expect(drafted.must_read).toBe(true);
  expect(drafted.body).toBe('Send the reply to Dana. Draft ready to read.');
  // The draft text itself never goes into the push payload.
  expect(JSON.stringify(drafted)).not.toContain('see you at 3');
});

test('a Hermes-native approval push never allows the command unseen', () => {
  const hermes = { kind: 'approval' as const, run_id: 'r', request_id: 'q', generation: 1 };
  const p = approvalPush(item(card({ title: 'Delete build output', body: 'Hermes wants to run:\n\n```\nrm -rf build\n```', action_label: 'Allow once', hermes })));
  expect(p).toMatchObject({ title: 'Needs your OK', body: 'Delete build output. Check the command first.', must_read: true, action_label: 'Allow once' });
  expect(JSON.stringify(p)).not.toContain('rm -rf');
  // Even when Hermes sent no command text, the card is the only place to look before allowing it.
  expect(approvalPush(item(card({ title: 'Run a flagged command', hermes }))).must_read).toBe(true);
});

test('a Hermes prompt dies with its run; Duet cards and live runs stay pending', () => {
  const h = (run_id: string, kind: 'approval' | 'clarify' = 'approval') => ({ kind, run_id, request_id: `q-${run_id}`, generation: 1 });
  const at = (id: string, c: CardData): Item => ({ ...item(c), id });
  const pending = [
    at('dead', card({ hermes: h('r1') })),
    at('dead-question', { type: 'choice', title: 'Which branch?', options: ['main', 'dev'], status: 'pending', hermes: h('r1', 'clarify') }),
    at('live', card({ hermes: h('r2') })),
    // A Duet approval from a run that ended long ago: tapping it resumes the session as a new turn.
    at('duet', card({ draft: 'Hi Dana' })),
    at('answered', card({ status: 'approved', hermes: h('r1') })),
  ];
  expect(deadPrompts(pending, new Set(['r2'])).map((i) => i.id)).toEqual(['dead', 'dead-question']);
  expect(deadPrompts(pending, new Set(['r1', 'r2']))).toEqual([]);
});
