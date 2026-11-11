import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capabilities, contextLabels, enabledToolsets, invalidateCapabilities, mcpServerNames, skillCounts, skillsFromFiles } from './capabilities';
import { config } from './config';
import { hermes } from './hermes';

const ORIG_CONTEXT = config.contextFile;
const ORIG_HERMES_HOME = config.hermesHome;
const ORIG_SKILLS = hermes.skills;
const ORIG_TOOLSETS = hermes.toolsets;
const ORIG_DATE_NOW = Date.now;
const temps: string[] = [];

afterEach(() => {
  config.contextFile = ORIG_CONTEXT;
  config.hermesHome = ORIG_HERMES_HOME;
  hermes.skills = ORIG_SKILLS;
  hermes.toolsets = ORIG_TOOLSETS;
  Date.now = ORIG_DATE_NOW;
  invalidateCapabilities();
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

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

  test('skill folders follow symlinked directories and SKILL.md files safely', () => {
    const base = mkdtempSync(join(tmpdir(), 'duet-skills-link-'));
    temps.push(base);
    const root = join(base, 'skills');
    const sharedDir = join(base, 'shared-skill');
    const targetFile = join(base, 'SHARED.md');
    mkdirSync(join(root, 'linked-cat'), { recursive: true });
    mkdirSync(sharedDir, { recursive: true });
    writeFileSync(join(sharedDir, 'SKILL.md'), '# linked dir skill');
    writeFileSync(targetFile, '# linked file skill');
    mkdirSync(join(root, 'direct-file'), { recursive: true });
    try {
      symlinkSync(sharedDir, join(root, 'linked-cat', 'my-skill'), 'dir');
      symlinkSync(targetFile, join(root, 'direct-file', 'SKILL.md'), 'file');
      // Cyclic symlink back to parent must terminate without infinite recursion.
      symlinkSync(sharedDir, join(sharedDir, 'loop'), 'dir');
    } catch (e: any) {
      if (e?.code === 'EPERM') return; // Symlink creation requires privileges on un-tuned Windows hosts.
      throw e;
    }
    expect(skillCounts(skillsFromFiles(root)).categories).toEqual([
      { name: 'general', count: 1 },
      { name: 'linked-cat', count: 1 },
    ]);
  });

  test('capabilities() caches healthy reads and auto-invalidates on memory file edits and clears', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'duet-cap-'));
    temps.push(dir);
    const ctx = join(dir, 'context.local.md');
    config.contextFile = ctx;
    config.hermesHome = dir;
    let skillCalls = 0;
    hermes.skills = async () => {
      skillCalls++;
      return { data: [{ category: 'research' }] };
    };
    hermes.toolsets = async () => ({ data: [{ name: 'web', label: 'Web', enabled: true }] });

    const first = await capabilities();
    expect(first.context).toEqual([]);
    expect(first.skills_from).toBe('hermes');
    expect(first.toolsets).toEqual(['Web']);
    expect(skillCalls).toBe(1);

    // Repeat read within TTL uses cache.
    expect(await capabilities()).toBe(first);
    expect(skillCalls).toBe(1);

    // Writing the memory file changes size/mtime and invalidates automatically.
    writeFileSync(ctx, '- Tasks: todo list\n', 'utf8');
    utimesSync(ctx, new Date(Date.now() + 2000), new Date(Date.now() + 2000));
    const second = await capabilities();
    expect(second.context).toEqual(['Tasks']);
    expect(skillCalls).toBe(2);

    // Updating content again invalidates cache.
    writeFileSync(ctx, '- Notes: inbox notes\n- Calendar: events\n', 'utf8');
    utimesSync(ctx, new Date(Date.now() + 4000), new Date(Date.now() + 4000));
    const third = await capabilities();
    expect(third.context).toEqual(['Notes', 'Calendar']);
    expect(skillCalls).toBe(3);

    // Removing the memory file returns empty context on the very next read.
    rmSync(ctx);
    const fourth = await capabilities();
    expect(fourth.context).toEqual([]);
    expect(skillCalls).toBe(4);
  });

  test('capabilities() uses a 15s short TTL when Hermes skills or toolsets fail', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'duet-cap-fail-'));
    temps.push(dir);
    config.contextFile = join(dir, 'context.local.md');
    config.hermesHome = dir;

    let now = 1_000_000;
    Date.now = () => now;
    let healthy = false;
    let calls = 0;
    hermes.skills = async () => {
      calls++;
      if (!healthy) throw new Error('gateway restarting');
      return { data: [{ category: 'tools' }] };
    };
    hermes.toolsets = async () => {
      if (!healthy) throw new Error('gateway restarting');
      return { data: [{ name: 'terminal', enabled: true }] };
    };

    const failed = await capabilities();
    expect(failed.toolsets).toBeNull();
    expect(failed.skills_from).toBe('none');
    expect(calls).toBe(1);

    // Within 15s failure TTL it returns cached value.
    now += 10_000;
    await capabilities();
    expect(calls).toBe(1);

    // Past 15s (still well under 5 min healthy TTL), Hermes recovers immediately.
    healthy = true;
    now += 6_000;
    const recovered = await capabilities();
    expect(calls).toBe(2);
    expect(recovered.toolsets).toEqual(['terminal']);
    expect(recovered.skills_from).toBe('hermes');

    // Once healthy, 20s stays within the 5-minute TTL.
    now += 20_000;
    await capabilities();
    expect(calls).toBe(2);
  });
});
