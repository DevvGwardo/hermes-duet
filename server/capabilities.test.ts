import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contextLabels, enabledToolsets, mcpServerNames, skillCounts, skillsFromFiles } from './capabilities';

describe('what I can see', () => {
  test('context file bullets become short labels', () => {
    const text = `<!-- - Hidden: in a comment -->
- Tasks: run \`todo list --today\` (read-only).
- **Notes**: ~/Notes/Inbox.md
  - nested detail is not a source
- Calendar and email: use the connected MCP tools.
- Ask before booking anything that costs more than a lunch, because this sentence keeps going on
Plain prose is ignored.`;
    expect(contextLabels(text)).toEqual(['Tasks', 'Notes', 'Calendar and email', 'Ask before booking anything that costs more than a lunch, b…']);
  });

  test('skills are counted per category, largest first', () => {
    expect(skillCounts(['apple', 'research', 'apple', null, ''])).toEqual({
      total: 5,
      categories: [
        { name: 'apple', count: 2 },
        { name: 'general', count: 2 },
        { name: 'research', count: 1 },
      ],
    });
  });

  test('only enabled toolsets are listed, by label', () => {
    const data = [
      { name: 'web', label: 'Web search', enabled: true },
      { name: 'tts', label: 'Speech', enabled: false },
      { name: 'terminal', enabled: true },
    ];
    expect(enabledToolsets(data)).toEqual(['Web search', 'terminal']);
    expect(enabledToolsets({ error: 'nope' })).toEqual([]);
  });

  test('MCP server names come from the top-level key, without disabled ones or duet', () => {
    const yaml = `model: x
mcp_servers:
  # comment
  gmail:
    command: npx
    args: ["-y", "gmail-mcp"]
    env:
      enabled: false
  "linear-app":
    url: https://example.invalid
  old-thing:
    command: foo
    enabled: false
  duet:
    command: bun
    tools: {}
approvals:
  mode: manual
  slack:
    command: nope`;
    expect(mcpServerNames(yaml)).toEqual(['gmail', 'linear-app']);
    expect(mcpServerNames('mcp_servers: {}\n')).toEqual([]);
    expect(mcpServerNames('model: x\n')).toEqual([]);
  });

  test('skill folders are found on disk when Hermes cannot list them', () => {
    const root = mkdtempSync(join(tmpdir(), 'duet-skills-'));
    const skill = (rel: string) => {
      mkdirSync(join(root, rel), { recursive: true });
      writeFileSync(join(root, rel, 'SKILL.md'), '---\nname: x\n---\n');
    };
    skill('apple/open-terminal');
    skill('apple/disk-recovery');
    skill('blueprint');
    skill('blueprint/references/nested');
    mkdirSync(join(root, '.hidden/skip'), { recursive: true });
    writeFileSync(join(root, '.hidden/skip/SKILL.md'), '');
    expect(skillCounts(skillsFromFiles(root)).categories).toEqual([
      { name: 'apple', count: 2 },
      { name: 'general', count: 1 },
    ]);
  });
});
