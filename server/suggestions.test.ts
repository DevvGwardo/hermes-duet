import { describe, expect, test } from 'bun:test';
import type { Capabilities, Channel, Connector } from '../shared/types';
import { suggestedConnectors } from './suggestions';

type Caps = Pick<Capabilities, 'apps' | 'toolsets'>;
const caps = (apps: string[], toolsets: string[] | null = null): Caps => ({ apps, toolsets });
const conn = (id: string, status: Connector['status'] = 'active'): Connector => ({
  id,
  name: id,
  kind: id as Connector['kind'],
  status,
  detail: '',
});
const channel = (repo?: string): Pick<Channel, 'repo'> => ({ repo });
const ids = (input: Parameters<typeof suggestedConnectors>[0]) => suggestedConnectors(input).map((s) => s.id);

describe('suggestedConnectors', () => {
  test('no calendar or mail connector suggests both', () => {
    const out = ids({ capabilities: caps([]), connectors: [], channels: [] });
    expect(out).toContain('calendar');
    expect(out).toContain('mail');
  });

  test('an active calendar and mail connector suppress those suggestions', () => {
    const out = ids({ capabilities: caps([]), connectors: [conn('calendar'), conn('mail')], channels: [] });
    expect(out).not.toContain('calendar');
    expect(out).not.toContain('mail');
  });

  test('a connector that is not active still counts as missing', () => {
    expect(ids({ capabilities: caps([]), connectors: [conn('calendar', 'needs_auth')], channels: [] })).toContain('calendar');
    expect(ids({ capabilities: caps([]), connectors: [conn('mail', 'missing')], channels: [] })).toContain('mail');
  });

  test('no apps suggests connecting an MCP server', () => {
    expect(ids({ capabilities: caps([]), connectors: [conn('calendar'), conn('mail')], channels: [] })).toContain('mcp');
    // An app that is there suppresses it.
    expect(ids({ capabilities: caps(['linear']), connectors: [conn('calendar'), conn('mail')], channels: [] })).not.toContain('mcp');
  });

  test('a channel repo with no GitHub-ish app or tool suggests GitHub', () => {
    expect(ids({ capabilities: caps(['linear']), connectors: [conn('calendar'), conn('mail')], channels: [channel('https://github.com/o/r')] })).toContain('github');
  });

  test('a GitHub app or toolset satisfies the repo heuristic', () => {
    expect(ids({ capabilities: caps(['github']), connectors: [conn('calendar'), conn('mail')], channels: [channel('o/r')] })).not.toContain('github');
    expect(ids({ capabilities: caps(['linear'], ['GitHub']), connectors: [conn('calendar'), conn('mail')], channels: [channel('o/r')] })).not.toContain('github');
  });

  test('a repo with GitHub tools and every native connector connected is "all good"', () => {
    expect(suggestedConnectors({ capabilities: caps(['github']), connectors: [conn('calendar'), conn('mail')], channels: [channel('o/r')] })).toEqual([]);
  });

  test('returns at most three suggestions, in priority order', () => {
    const out = suggestedConnectors({ capabilities: caps([]), connectors: [], channels: [channel('o/r')] });
    expect(out.length).toBeLessThanOrEqual(3);
    expect(out.map((s) => s.id)).toEqual(['calendar', 'mail', 'github']);
  });

  test('every suggestion is honest: an id, title, detail and guidance hint, no install claim', () => {
    for (const s of suggestedConnectors({ capabilities: caps([]), connectors: [], channels: [] })) {
      expect(s.id).toBeTruthy();
      expect(s.title).toBeTruthy();
      expect(s.detail).toBeTruthy();
      expect(s.hint).toBeTruthy();
      expect(s.detail).not.toMatch(/install/i);
      expect(s.hint!).not.toMatch(/click install|install now|one-click/i);
    }
  });
});
