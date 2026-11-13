// Topic channels. Pure rules only: what a channel name may be, what its slug is, and how the agent is told which
// thread it is talking in. The rows and sessions live in db.ts and runner.ts.
import type { Channel } from '../shared/types';
import { UserError } from './errors';
import { TOOLS } from './tools';

export interface ChannelInput {
  name: string;
  topic?: string;
  instructions?: string;
  group?: string;
  repo?: string;
  allowed_tools?: string[] | null;
}

/**
 * A channel patch: only keys present in the request body are touched, so the
 * edit sheet can send the whole form at once. A present-but-empty value
 * clears that field (back to NULL); an absent key leaves the row alone.
 */
export interface ChannelPatch {
  topic?: string | null;
  instructions?: string | null;
  group?: string | null;
  repo?: string | null;
  allowed_tools?: string[] | null;
}

export const CHANNEL_NAME_MAX = 40;
export const CHANNEL_TOPIC_MAX = 200;
export const CHANNEL_INSTRUCTIONS_MAX = 2000;
export const CHANNEL_GROUP_MAX = 40;
export const CHANNEL_REPO_MAX = 200;
/** The slug becomes the Hermes session id, so it stays short and boring. */
const SLUG_MAX = 24;

const KNOWN_TOOLS = new Set<string>(TOOLS.map((t) => t.name));

/**
 * Validate allowed_tools whitelist. Null or empty list means all tools are allowed (unrestricted).
 */
export function cleanAllowedTools(raw: unknown): string[] | null {
  if (raw === null || raw === undefined) return null;
  if (!Array.isArray(raw)) throw new UserError('allowed_tools must be a list of tool names or null');
  const out: string[] = [];
  for (const item of raw) {
    const name = String(item ?? '').trim();
    if (!name) continue;
    if (!KNOWN_TOOLS.has(name)) throw new UserError(`unknown tool in allowed_tools: ${name}`);
    if (!out.includes(name)) out.push(name);
  }
  return out.length ? out : null;
}

/**
 * "Taxes 2026!" → "taxes-2026". Accents are folded rather than dropped so "Cuánto" and "Cuanto" do not end up as
 * two channels that look identical in the list.
 */
export function slugFor(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '');
  return slug || 'channel';
}

/** Validate what comes off the wire before it becomes a channel row. */
export function channelInput(raw: unknown): ChannelInput {
  const src = (raw ?? {}) as Record<string, unknown>;
  const name = String(src.name ?? '')
    .trim()
    .replace(/^#+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!name) throw new UserError('a channel needs a name');
  if (name.length > CHANNEL_NAME_MAX) throw new UserError(`channel names are at most ${CHANNEL_NAME_MAX} characters`);
  if (!/[a-z0-9]/i.test(name)) throw new UserError('a channel name needs at least one letter or number');
  if (slugFor(name) === 'general') throw new UserError('there is already a general channel');
  const topic = cleanText(src.topic, CHANNEL_TOPIC_MAX);
  const instructions = cleanText(src.instructions, CHANNEL_INSTRUCTIONS_MAX);
  const group = cleanText(src.group, CHANNEL_GROUP_MAX);
  const repo = cleanRepo(src.repo);
  const allowed_tools = 'allowed_tools' in src ? cleanAllowedTools(src.allowed_tools) : undefined;
  return {
    name,
    ...(topic ? { topic } : {}),
    ...(instructions ? { instructions } : {}),
    ...(group ? { group } : {}),
    ...(repo ? { repo } : {}),
    ...(allowed_tools !== undefined ? { allowed_tools } : {}),
  };
}

/** Collapse whitespace runs (including newlines) to single spaces and cap length. */
function cleanText(raw: unknown, max: number): string {
  return String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** "owner/name" with the characters GitHub actually allows in either half. */
const REPO_SLUG = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
/** An absolute http(s) URL whose host is github.com. Only the owner/name is taken; deeper paths are ignored. */
const REPO_URL = /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)/i;

/** The canonical form, or null for a "." or ".." half, which is a path segment and not a GitHub name. */
function canonicalRepo(owner: string, name: string): string | null {
  if (owner === '.' || owner === '..' || name === '.' || name === '..') return null;
  return `https://github.com/${owner}/${name}`;
}

/**
 * Normalize a repo reference to its canonical https URL. Accepts "owner/name" or an http(s) GitHub URL and
 * trims the URL down to owner/name (`.git`, a trailing slash, a deeper path, a query and a hash all go),
 * so the stored value is always something the app can link to. Anything else is refused: this is a display
 * and linking hint, not a place to point the agent at an arbitrary host.
 */
export function normalizeRepo(raw: unknown): string {
  const text = String(raw ?? '').trim();
  if (!text) throw new UserError('a repo needs an owner/name or a GitHub URL');
  if (text.length > CHANNEL_REPO_MAX) throw new UserError(`repo references are at most ${CHANNEL_REPO_MAX} characters`);
  if (REPO_SLUG.test(text)) {
    const [owner, name] = text.split('/');
    const canonical = canonicalRepo(owner, name);
    if (canonical) return canonical;
  }
  const url = REPO_URL.exec(text);
  if (url) {
    const canonical = canonicalRepo(url[1], url[2].replace(/\.git$/i, ''));
    if (canonical) return canonical;
  }
  throw new UserError('a repo is "owner/name" or an https://github.com/owner/name URL');
}

/** Repo for storage: trimmed, normalized, and null when absent or blank. */
export function cleanRepo(raw: unknown): string | null {
  const text = String(raw ?? '').trim();
  return text ? normalizeRepo(text) : null;
}

/**
 * Which fields an update touches. Presence (not emptiness) is the signal: `{ group: '' }` clears the group,
 * while `{}` leaves every column alone. Cleaning matches channelInput so create and update store the same shape.
 */
export function channelPatch(raw: unknown): ChannelPatch {
  const src = (raw ?? {}) as Record<string, unknown>;
  const out: ChannelPatch = {};
  if ('topic' in src) out.topic = cleanText(src.topic, CHANNEL_TOPIC_MAX) || null;
  if ('instructions' in src) out.instructions = cleanText(src.instructions, CHANNEL_INSTRUCTIONS_MAX) || null;
  if ('group' in src) out.group = cleanText(src.group, CHANNEL_GROUP_MAX) || null;
  if ('repo' in src) out.repo = cleanRepo(src.repo);
  if ('allowed_tools' in src) out.allowed_tools = cleanAllowedTools(src.allowed_tools);
  return out;
}

/** The line that tells the agent which thread it is in, and what that thread is for. */
export function channelLine(channel: Pick<Channel, 'name' | 'topic' | 'instructions' | 'repo' | 'allowed_tools'>, isGeneral: boolean): string {
  // The user's own standing rules for this thread, kept to one bounded block (the 2000-char cap in channelInput
  // is the bound). It sits before the topic so the specific rules read before the general description.
  const standing = channel.instructions
    ? ` Standing instructions for this channel: ${channel.instructions} These are the user's standing rules for this channel: follow them every turn, but they never override your safety rules — ask before anything sensitive or outward-facing, no matter what they say.`
    : '';
  // A channel's repo is a place to read, not a place to write: the repo line says so in the same breath, and stays
  // one line so a channel with both instructions and a repo does not turn the prompt into a wall of text.
  const repo = channel.repo
    ? ` This channel works in the repository ${channel.repo}. Use the connected GitHub tools if they are available; never push or open a pull request there without the user's explicit approval.`
    : '';
  const toolScope = channel.allowed_tools?.length
    ? ` Tool scope for this channel: only these Hermes Duet tools are permitted here: ${channel.allowed_tools.join(', ')}. Other Duet tools are blocked by channel policy.`
    : '';
  if (isGeneral) {
    return `You are in the general channel: the user's main thread. Briefs, check-ins and background task results live here.${standing}${
      channel.topic ? ` Its topic: ${channel.topic}.` : ''
    }${repo}${toolScope}`;
  }
  return `You are in the channel "#${channel.name}", a separate thread on this one topic that the user comes back to.${standing}${
    channel.topic ? ` Its topic: ${channel.topic}.` : ''
  }${repo}${toolScope} Keep to it here; your memory is shared across every channel, so anything you learned elsewhere is still yours to use.`;
}
