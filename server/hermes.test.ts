import { describe, expect, test } from 'bun:test';
import { parseSseFrame } from './hermes';

describe('Hermes SSE frame parsing', () => {
  test('multi-line data fields are joined with newlines as SSE requires', () => {
    expect(parseSseFrame('data: hello\ndata: world')).toEqual({ data: 'hello\nworld', id: undefined, name: undefined });
  });

  test('a JSON payload split across data lines still parses', () => {
    const frame = parseSseFrame('data: {"event":"delta",\ndata: "ok":true}');
    expect(JSON.parse(frame!.data)).toEqual({ event: 'delta', ok: true });
  });

  test('event and id fields survive, and comment-only frames are ignored', () => {
    expect(parseSseFrame('id: 41\nevent: run.completed\ndata: {"ok":true}')).toEqual({ data: '{"ok":true}', id: 41, name: 'run.completed' });
    expect(parseSseFrame(': ping')).toBeNull();
  });
});
