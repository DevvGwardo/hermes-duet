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

  test('CRLF framing and data lines without a space still parse', () => {
    expect(parseSseFrame('event: delta\r\ndata: {"t":1}')).toEqual({ data: '{"t":1}', id: undefined, name: 'delta' });
    expect(parseSseFrame('data:compact')).toEqual({ data: 'compact', id: undefined, name: undefined });
  });

  test('empty frames carry nothing, and a non-numeric id stays numeric-or-NaN', () => {
    expect(parseSseFrame('')).toBeNull();
    expect(parseSseFrame('event: keepalive')).toBeNull();
    expect(parseSseFrame('id: abc\ndata: x')?.id).toBeNaN();
  });
});
