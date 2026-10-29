// Topic channels. Pure rules only: what a channel name may be, what its slug is, and how the agent is told which
// thread it is talking in. The rows and sessions live in db.ts and runner.ts.
import type { Channel } from '../shared/types';

export interface ChannelInput {
  name: string;
  topic?: string;
}

export const CHANNEL_NAME_MAX = 40;
export const CHANNEL_TOPIC_MAX = 200;
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
  if (!name) throw new Error('a channel needs a name');
  if (name.length > CHANNEL_NAME_MAX) throw new Error(`channel names are at most ${CHANNEL_NAME_MAX} characters`);
  if (!/[a-z0-9]/i.test(name)) throw new Error('a channel name needs at least one letter or number');
  if (slugFor(name) === 'general') throw new Error('there is already a general channel');
  const topic = String(src.topic ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, CHANNEL_TOPIC_MAX);
  return { name, ...(topic ? { topic } : {}) };
}

/** The line that tells the agent which thread it is in, and what that thread is for. */
export function channelLine(channel: Pick<Channel, 'name' | 'topic'>, isGeneral: boolean): string {
  if (isGeneral) {
    return `You are in the general channel: the user's main thread. Briefs, check-ins and background task results live here.${
      channel.topic ? ` Its topic: ${channel.topic}.` : ''
    }`;
  }
  return `You are in the channel "#${channel.name}", a separate thread on this one topic that the user comes back to.${
    channel.topic ? ` Its topic: ${channel.topic}.` : ''
  } Keep to it here; your memory is shared across every channel, so anything you learned elsewhere is still yours to use.`;
}
