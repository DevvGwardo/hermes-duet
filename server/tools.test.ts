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
