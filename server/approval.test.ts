import { expect, test } from 'bun:test';
import type { CardData, Item } from '../shared/types';
import { OPEN_ASKS_MAX, approvalDecision, approvalPrompt, approvalPush, askMarks, deadPrompts, replaceRefusal, waitingNote, withdrawRefusal } from './approval';

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

test('a redraft withdraws only its own pending card of the same kind', () => {
  const at = (c: Partial<CardData>): Item => item(card({ session_id: 'main', ...c }));
  expect(replaceRefusal(at({ draft: 'Hi Dana' }), 'approval', 'main')).toBeNull();
  expect(replaceRefusal(at({ type: 'choice', options: ['A', 'B'] }), 'choice', 'main')).toBeNull();
  expect(replaceRefusal(null, 'approval', 'main')).toBe('there is no such card');
  // A question can't stand in for an approval, and Duet's own cards and Hermes prompts aren't the agent's to withdraw.
  expect(replaceRefusal(at({ type: 'choice' }), 'approval', 'main')).toContain('not one of your request_approval cards');
  expect(replaceRefusal(at({ type: 'choice', resume: true }), 'choice', 'main')).toContain('not one of your ask cards');
  expect(replaceRefusal(at({ hermes: { kind: 'approval', run_id: 'r', request_id: 'q', generation: 1 } }), 'approval', 'main')).not.toBeNull();
  // A background task can't withdraw the main thread's card.
  expect(replaceRefusal(at({}), 'approval', 'duet-task-1')).toBe('it belongs to another conversation');
  // Once decided, the old version stands, and the agent is told why nothing was replaced.
  expect(replaceRefusal(at({ status: 'approved' }), 'approval', 'main')).toBe('the user already approved it');
  expect(replaceRefusal(at({ status: 'expired' }), 'approval', 'main')).toBe('it already expired');
});

test('withdraw_card takes down only the calling session\'s own pending asks', () => {
  const at = (c: Partial<CardData>): Item => item(card({ session_id: 'main', ...c }));
  expect(withdrawRefusal(at({}), 'main')).toBeNull();
  expect(withdrawRefusal(at({ type: 'choice', options: ['A', 'B'] }), 'main')).toBeNull();
  expect(withdrawRefusal(null, 'main')).toBe('there is no such card');
  expect(withdrawRefusal(at({ type: 'brief', status: 'info' }), 'main')).toBe('it is not an approval or question card');
  expect(withdrawRefusal(at({ type: 'choice', rerun: 'brief' }), 'main')).not.toBeNull();
  expect(withdrawRefusal(at({}), 'duet-task-1')).toBe('it belongs to another conversation');
  expect(withdrawRefusal(at({ status: 'declined' }), 'main')).toBe('the user already declined it');
});

test('a chat message is told which of its session\'s cards are still waiting, newest first', () => {
  const at = (id: string, created_at: number, c: Partial<CardData>): Item => ({ ...item(card({ session_id: 'main', ...c })), id, created_at });
  const pending = [
    at('old', 1, { title: 'Send the reply to Dana' }),
    at('q', 2, { type: 'choice', title: 'Which venue?', options: ['A', 'B'] }),
    // Not the agent's to withdraw: another session's card, a Hermes prompt, Duet's own resume card.
    at('task', 3, { session_id: 'duet-task-1' }),
    at('hermes', 4, { hermes: { kind: 'approval', run_id: 'r', request_id: 'x', generation: 1 } }),
    at('resume', 5, { type: 'choice', resume: true }),
  ];
  const note = waitingNote(pending, 'main');
  expect(note).toStartWith('(Cards of yours still waiting');
  expect(note).toContain('- [question q] Which venue?\n- [approval old] Send the reply to Dana\n');
  expect(note).not.toMatch(/ (task|hermes|resume)\]/);
  expect(note).toContain('withdraw_card');
  expect(note).toEndWith(')\n\n');
  expect(waitingNote(pending.slice(2), 'main')).toBe('');
  const many = Array.from({ length: 7 }, (_, i) => at(`a${i}`, i, {}));
  expect(waitingNote(many, 'main').match(/\[approval /g)).toHaveLength(5);
});

test('every push lists the open asks, and marks itself an ask only for a pending approval or question', () => {
  const at = (id: string, c: CardData): Item => ({ ...item(c), id });
  const pending = [
    at('a1', card()),
    at('q1', card({ type: 'choice' })),
    // A note never waits on anyone, so it is neither listed nor marked.
    at('n1', card({ type: 'note', status: 'info' })),
  ];
  expect(askMarks({ card_id: 'a1' }, pending, 5)).toEqual({ ask: true, open: ['a1', 'q1'], sent_at: 5 });
  // A brief, handover or "While you were away" push still carries the list, so it can clear stale asks.
  expect(askMarks({}, pending, 5)).toEqual({ open: ['a1', 'q1'], sent_at: 5 });
  expect(askMarks({ card_id: 'n1' }, pending, 5)).toEqual({ open: ['a1', 'q1'], sent_at: 5 });
  // Too many to fit in a push: no list, so the service worker closes nothing.
  const many = Array.from({ length: OPEN_ASKS_MAX + 1 }, (_, i) => at(`a${i}`, card()));
  expect(askMarks({ card_id: 'a0' }, many, 5)).toEqual({ ask: true, sent_at: 5 });
});
