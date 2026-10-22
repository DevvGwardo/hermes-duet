import { describe, expect, test } from 'bun:test';
import type { ToolStep } from '../shared/types';
import { lastDone, resumeCardBody } from './recovery';

const step = (id: string, status: ToolStep['status'], label?: string): ToolStep => ({ id, name: `tool_${id}`, label, status, started_at: 1 });

describe('interrupted-run card', () => {
  test('names the last completed tool step, skipping the one that was cut off', () => {
    const steps = [step('a', 'done', 'search: Q3 revenue'), step('b', 'done', 'write ~/duet-work/deck.html'), step('c', 'error', 'render pdf')];
    expect(lastDone({ steps })).toBe('write ~/duet-work/deck.html');
    expect(resumeCardBody({ steps })).toContain('The last step that finished: write ~/duet-work/deck.html.');
  });

  test("a task's own ticked step beats a tool label", () => {
    const body = resumeCardBody({ steps: [step('a', 'done', 'terminal: ls')], taskSteps: [{ text: 'Pull the numbers', done: true }, { text: 'Build the slides' }] });
    expect(body).toContain('The last step that finished: Pull the numbers.');
    expect(body).not.toContain('terminal');
  });

  test('falls back to the tool name and says when nothing had finished', () => {
    expect(lastDone({ steps: [step('a', 'done')] })).toBe('tool_a');
    expect(resumeCardBody({ steps: [step('a', 'error', 'x')] })).toContain('Nothing had finished yet.');
  });

  test('mentions the silent unpause-and-retry only when it happened', () => {
    expect(resumeCardBody({ steps: [], retried: true })).toContain('retried once on my own');
    expect(resumeCardBody({ steps: [] })).not.toContain('retried');
  });
});
