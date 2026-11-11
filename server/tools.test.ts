import { expect, test } from 'bun:test';
import { TOOLS } from './tools';

test('every tool has a description and a well-formed input schema', () => {
  const names = new Set<string>();
  for (const t of TOOLS) {
    expect(t.name).toMatch(/^[a-z_]+$/);
    expect(names.has(t.name)).toBe(false);
    names.add(t.name);
    expect(t.description.length).toBeGreaterThan(40);
    expect(t.inputSchema.type).toBe('object');
    const props = Object.keys(t.inputSchema.properties);
    for (const r of t.inputSchema.required ?? []) expect(props).toContain(r);
  }
});

test('the approval tool tells the model to stop and wait', () => {
  const approval = TOOLS.find((t) => t.name === 'request_approval')!;
  expect(approval.description).toContain('BEFORE');
  expect(approval.description).toMatch(/do not perform the action/i);
});

test('all session-routed tools accept task_id for unambiguous attribution', () => {
  const routed = [
    'request_approval',
    'request_payment',
    'ask',
    'withdraw_card',
    'post_brief',
    'post_card',
    'deliver_file',
    'save_page',
    'save_routine',
    'remove_routine',
    'start_task',
    'update_task',
    'notify',
  ];
  for (const name of routed) {
    const tool = TOOLS.find((t) => t.name === name)!;
    expect(tool).toBeTruthy();
    expect(Object.keys(tool.inputSchema.properties)).toContain('task_id');
  }
});
