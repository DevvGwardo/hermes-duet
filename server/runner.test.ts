import { expect, test } from 'bun:test';
import type { FileEntry, Page, Task } from '../shared/types';
import { newId, tasks } from './db';
import { deliverableAction, deliverableApproval, pageRefreshing } from './runner';

const task = (status: Task['status']): Task => ({
  id: newId(),
  title: `hc refresh ${status}`,
  status,
  steps: [],
  created_at: Date.now(),
  updated_at: Date.now(),
  background: true,
});
const page = (task_id?: string): Page =>
  ({ id: newId(), title: 'hc page', instructions: 'x', file_id: 'f', task_id } as Page);

test('a page that never refreshed is not refreshing', () => {
  expect(pageRefreshing(page())).toBe(false);
});

test('queued and running refreshes count as refreshing', () => {
  for (const status of ['queued', 'running', 'waiting'] as const) {
    const t = task(status);
    tasks.save(t);
    expect(pageRefreshing(page(t.id))).toBe(true);
  }
});

test('finished refreshes no longer count', () => {
  for (const status of ['done', 'failed'] as const) {
    const t = task(status);
    tasks.save(t);
    expect(pageRefreshing(page(t.id))).toBe(false);
  }
});

test('a dangling task id is not refreshing', () => {
  expect(pageRefreshing(page('no-such-task'))).toBe(false);
});

test('a new refresh supersedes the finished one', () => {
  const old = task('done');
  tasks.save(old);
  expect(pageRefreshing(page(old.id))).toBe(false);
  const next = task('queued');
  tasks.save(next);
  expect(pageRefreshing(page(next.id))).toBe(true);
});

const dash = (extra: Partial<FileEntry> = {}): FileEntry => ({
  id: `f-${newId()}`,
  title: 'Spend dash',
  name: 'spend.html',
  mime: 'text/html',
  size: 10,
  created_at: Date.now(),
  ...extra,
});

test('a dashboard approval is only ever a proposal: pending card, nothing acted on', () => {
  const item = deliverableApproval(dash(), { title: 'Pay the bill', summary: 'Bill is $5.', action_label: 'Pay' });
  expect(item.card!.type).toBe('approval');
  expect(item.card!.status).toBe('pending');
  expect(item.card!.title).toBe('Pay the bill');
  expect(item.card!.body).toContain('Bill is $5.');
});

test('dashboard approval falls back when the dashboard sends nothing usable', () => {
  const item = deliverableApproval(dash({ title: 'Q3 board' }), {});
  expect(item.card!.title).toContain('Q3 board');
  expect(item.card!.body).toContain('Q3 board');
});

test('dashboard approval text is bounded', () => {
  const item = deliverableApproval(dash(), { title: 't'.repeat(200), summary: 's'.repeat(5000), action_label: 'a'.repeat(40) });
  expect(item.card!.title).toHaveLength(140);
  expect(item.card!.body!.length).toBeLessThan(4100);
  expect(item.card!.action_label).toHaveLength(30);
});

test('dashboard buttons sanitize the action and arrive as a system line', () => {
  expect(() => deliverableAction(dash(), {})).toThrow('missing action');
  const item = deliverableAction(dash({ title: 'Board' }), { action: 'export-csv!', payload: { row: 3 } });
  expect(item.kind).toBe('system');
  expect(item.text).toContain('export-csv');
  expect(item.text).not.toContain('!');
});
