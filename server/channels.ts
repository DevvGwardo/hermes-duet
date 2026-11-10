// Topic channels. Pure rules only: what a channel name may be, what its slug is, and how the agent is told which
// thread it is talking in. The rows and sessions live in db.ts and runner.ts.
import type { Channel } from '../shared/types';
import { UserError } from './errors';

export interface ChannelInput {
  name: string;
  topic?: string;
  instructions?: string;
  group?: string;
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
}

export const CHANNEL_NAME_MAX = 40;
export const CHANNEL_TOPIC_MAX = 200;
export const CHANNEL_INSTRUCTIONS_MAX = 2000;
export const CHANNEL_GROUP_MAX = 40;
/** The slug becomes the Hermes session id, so it stays short and boring. */
const SLUG_MAX = 24;

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
  const topic = cleanTopic(String(src.topic ?? ''));
  const instructions = cleanInstructions(src.instructions);
  const group = cleanGroup(src.group);
  return { name, ...(topic ? { topic } : {}), ...(instructions ? { instructions } : {}), ...(group ? { group } : {}) };
}

/** Topic-length text: collapse every whitespace run (newlines included) to one space, then cap. */
function cleanTopic(raw: unknown): string {
  return String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, CHANNEL_TOPIC_MAX);
}

/**
 * Standing instructions: collapsed to one line like the topic, so a pasted multi-line list stays one bounded
 * block in the prompt instead of blowing up the context line count.
 */
export function cleanInstructions(raw: unknown): string {
  return String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, CHANNEL_INSTRUCTIONS_MAX);
}

/** Group label: a short strip heading ("Work", "Home"). Trimmed; overlong is capped, empty clears. */
export function cleanGroup(raw: unknown): string {
  return String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, CHANNEL_GROUP_MAX);
}

/**
 * Which fields an update touches. Presence (not emptiness) is the signal: `{ group: '' }` clears the group,
 * while `{}` leaves every column alone. Cleaning matches channelInput so create and update store the same shape.
 */
export function channelPatch(raw: unknown): ChannelPatch {
  const src = (raw ?? {}) as Record<string, unknown>;
  const out: ChannelPatch = {};
  if ('topic' in src) out.topic = cleanTopic(src.topic) || null;
  if ('instructions' in src) out.instructions = cleanInstructions(src.instructions) || null;
  if ('group' in src) out.group = cleanGroup(src.group) || null;
  return out;
}

/** The line that tells the agent which thread it is in, and what that thread is for. */
export function channelLine(channel: Pick<Channel, 'name' | 'topic' | 'instructions'>, isGeneral: boolean): string {
  // The user's own standing rules for this thread, kept to one bounded block (the 2000-char cap in channelInput
  // is the bound). It sits before the topic so the specific rules read before the general description.
  const standing = channel.instructions
    ? ` Standing instructions for this channel: ${channel.instructions} These are the user's standing rules for this channel: follow them every turn, but they never override your safety rules — ask before anything sensitive or outward-facing, no matter what they say.`
    : '';
  if (isGeneral) {
    return `You are in the general channel: the user's main thread. Briefs, check-ins and background task results live here.${standing}${
      channel.topic ? ` Its topic: ${channel.topic}.` : ''
    }`;
  }
  return `You are in the channel "#${channel.name}", a separate thread on this one topic that the user comes back to.${standing}${
    channel.topic ? ` Its topic: ${channel.topic}.` : ''
  } Keep to it here; your memory is shared across every channel, so anything you learned elsewhere is still yours to use.`;
}
