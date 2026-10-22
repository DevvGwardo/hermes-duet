import type { Item } from '../shared/types';

/**
 * Tasks the user starts from the composer ("Run in background") instead of Hermes deciding to call start_task.
 * They run in their own session, so the main chat stays free and several can go at once.
 */

/** A task title from the user's own words: the first line, cut at a word boundary. */
export function userTaskTitle(text: string, max = 80): string {
  const line = text.trim().split('\n')[0].trim().replace(/\s+/g, ' ');
  if (line.length <= max) return line;
  const cut = line.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, '')}…`;
}

/**
 * The task's instructions: the request verbatim, plus the tail of the main chat, because "look into that error"
 * usually points at something said there and the task's fresh session can't see it.
 */
export function userTaskInstructions(text: string, recent: Item[]): string {
  const lines = recent
    .filter((i) => (i.kind === 'user' || i.kind === 'assistant') && i.text?.trim())
    .slice(-6)
    .map((i) => `${i.kind === 'user' ? 'User' : 'You'}: ${clip(i.text!.trim().replace(/\s+/g, ' '), 400)}`);
  const context = lines.length
    ? `\n\nThe last few messages of their main chat with you, in case the request refers to them (they may be unrelated):\n${lines.join('\n')}`
    : '';
  return `The user started this as a background task themselves, so their main chat with you stays free. Their request, in their own words:\n\n${text.trim()}${context}`;
}

function clip(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
