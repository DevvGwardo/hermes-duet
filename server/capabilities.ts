import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Capabilities } from '../shared/types';
import { config } from './config';
import { hermes } from './hermes';

/**
 * "What I can see": the context sources, skills and connected tools the agent starts every turn with.
 * Only names and counts leave this module; nothing from a config value or skill body is passed on.
 */

const MAX_CONTEXT = 8;

/** One short label per top-level bullet of the context file: the part before the first colon, else the line cut short. */
export function contextLabels(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.replace(/<!--[\s\S]*?-->/g, '').split('\n')) {
    const m = raw.match(/^[-*]\s+(.+)$/);
    if (!m) continue;
    const line = m[1].replace(/[`*_]/g, '').trim();
    const colon = line.indexOf(':');
    const label = colon > 0 && colon <= 40 ? line.slice(0, colon).trim() : line.length > 60 ? `${line.slice(0, 59).trimEnd()}…` : line;
    if (label && !out.includes(label)) out.push(label);
    if (out.length === MAX_CONTEXT) break;
  }
  return out;
}

/** Count skills per category, largest first; a skill without a category counts as "general". */
export function skillCounts(categories: (string | null | undefined)[]): Capabilities['skills'] {
  const counts = new Map<string, number>();
  for (const c of categories) {
    const name = (c ?? '').trim() || 'general';
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return {
    total: categories.length,
    categories: [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
  };
}

/** `GET /v1/toolsets` data → labels of the enabled toolsets. */
export function enabledToolsets(data: unknown): string[] {
  if (!Array.isArray(data)) return [];
  return data.filter((t) => t?.enabled === true).map((t) => String(t.label || t.name || '').trim()).filter(Boolean);
}

/**
 * Server names under the top-level `mcp_servers:` key of Hermes's config.yaml, without a YAML parser:
 * the first indented key sets the server indent, deeper lines belong to that server, and a server whose
 * own `enabled:` key is false is left out (a nested `env: enabled: false` is not the switch). `duet` is these very tools, so it is skipped too.
 */
export function mcpServerNames(yaml: string): string[] {
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => /^mcp_servers:\s*(#.*)?$/.test(l));
  if (start < 0) return [];
  const names: string[] = [];
  let indent = -1;
  let current: string | null = null;
  let childIndent = -1;
  let disabled = false;
  const close = () => {
    if (current && !disabled && current !== 'duet') names.push(current);
    current = null;
    childIndent = -1;
    disabled = false;
  };
  for (const line of lines.slice(start + 1)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const lead = line.length - line.trimStart().length;
    if (lead === 0) break;
    if (indent < 0) indent = lead;
    if (lead === indent) {
      close();
      const key = line.trim().match(/^["']?([^"':]+)["']?:/);
      current = key ? key[1].trim() : null;
    } else if (lead > indent) {
      if (childIndent < 0) childIndent = lead;
      if (lead === childIndent && /^enabled:\s*(false|no|off)\s*$/i.test(line.trim())) disabled = true;
    }
  }
  close();
  return names;
}

/** Fallback when Hermes can't list skills: every SKILL.md under ~/.hermes/skills (read-only), category = top folder. */
export function skillsFromFiles(root: string, maxDepth = 4): (string | null)[] {
  const out: (string | null)[] = [];
  const walk = (dir: string, depth: number, top: string | null) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (depth > 0 && entries.some((e) => e.isFile() && e.name === 'SKILL.md')) {
      out.push(depth > 1 ? top : null);
      return;
    }
    if (depth >= maxDepth) return;
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      walk(join(dir, e.name), depth + 1, top ?? e.name);
    }
  };
  walk(root, 0, null);
  return out;
}

async function gather(): Promise<Capabilities> {
  let context: string[] = [];
  try {
    if (existsSync(config.contextFile)) context = contextLabels(readFileSync(config.contextFile, 'utf8'));
  } catch {}

  let apps: string[] = [];
  try {
    apps = mcpServerNames(readFileSync(join(config.hermesHome, 'config.yaml'), 'utf8'));
  } catch {}

  const [skillRes, toolRes] = await Promise.allSettled([hermes.skills(), hermes.toolsets()]);
  let skills = skillCounts([]);
  let skills_from: Capabilities['skills_from'] = 'none';
  const listed = skillRes.status === 'fulfilled' ? skillRes.value?.data : undefined;
  if (Array.isArray(listed)) {
    skills = skillCounts(listed.map((s: any) => (typeof s?.category === 'string' ? s.category : null)));
    skills_from = 'hermes';
  } else {
    const found = skillsFromFiles(join(config.hermesHome, 'skills'));
    if (found.length) {
      skills = skillCounts(found);
      skills_from = 'files';
    }
  }
  const toolsets = toolRes.status === 'fulfilled' ? enabledToolsets(toolRes.value?.data) : null;

  return { context, skills, skills_from, toolsets, apps, checked_at: Date.now() };
}

const TTL_MS = 5 * 60_000;
let cached: Capabilities | null = null;
let inflight: Promise<Capabilities> | null = null;

/** Cached for a few minutes so opening Settings or an empty thread doesn't hit Hermes every time. */
export function capabilities(): Promise<Capabilities> {
  if (cached && Date.now() - cached.checked_at < TTL_MS) return Promise.resolve(cached);
  inflight ??= gather()
    .then((c) => (cached = c))
    .finally(() => (inflight = null));
  return inflight;
}
