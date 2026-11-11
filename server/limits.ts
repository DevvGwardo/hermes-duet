// Small in-memory guards for the expensive mutations a paired device can trigger. They are abuse brakes, not
// billing state: a restart forgets recent hits, and the only durable brakes (pairing, webhooks) live in SQLite.

import { UserError } from './errors';

export interface LimitResult {
  allowed: boolean;
  /** How long until the oldest hit leaves the window; 0 when allowed. */
  retryAfterMs: number;
}

export class SlidingWindow {
  private hits = new Map<string, number[]>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
  ) {}

  check(key: string, now = Date.now()): LimitResult {
    const since = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > since);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return { allowed: false, retryAfterMs: Math.max(1, recent[0]! + this.windowMs - now) };
    }
    recent.push(now);
    this.hits.set(key, recent);
    // A bounded map: the limiter is per paired device, but a leaked cookie shouldn't grow it forever.
    if (this.hits.size > 2048) this.prune(now);
    return { allowed: true, retryAfterMs: 0 };
  }

  reset() {
    this.hits.clear();
  }

  private prune(now: number) {
    const since = now - this.windowMs;
    for (const [key, values] of this.hits) {
      const recent = values.filter((t) => t > since);
      if (recent.length) this.hits.set(key, recent);
      else this.hits.delete(key);
    }
  }
}

/**
 * Per-device budgets. A person typing quickly sends well under 60 messages a minute; the numbers are high enough to
 * never interrupt real use and low enough that a stuck client or a leaked cookie cannot enqueue unlimited Hermes runs.
 */
export const limits = {
  messages: new SlidingWindow(60, 60_000),
  tasks: new SlidingWindow(20, 60_000),
  briefs: new SlidingWindow(6, 10 * 60_000),
  pushTests: new SlidingWindow(5, 10 * 60_000),
};

export function resetLimits() {
  for (const window of Object.values(limits)) window.reset();
}

// ---------- idempotency for POST /api/messages ----------

const IDEMPOTENCY_TTL_MS = 10 * 60_000;
const IDEMPOTENCY_MAX = 512;
const seen = new Map<string, { itemId: string; at: number }>();
const inflight = new Map<string, { promise: Promise<string | null>; resolve: (id: string | null) => void }>();

/** A client-chosen key for one message. Absent means "no idempotency"; malformed is a caller error. */
export function idempotencyKey(req: Request): string | null {
  const raw = (req.headers.get('idempotency-key') ?? '').trim();
  if (!raw) return null;
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(raw)) throw new UserError('invalid idempotency key', 400);
  return raw;
}

/** The item a previous request with this key created, if it is still remembered and still exists. */
export function idempotentItem(key: string, now = Date.now()): string | null {
  const row = seen.get(key);
  if (!row) return null;
  if (now - row.at > IDEMPOTENCY_TTL_MS) {
    seen.delete(key);
    return null;
  }
  return row.itemId;
}

/** Promise for a concurrent request currently creating the item for `key`, if any. */
export function idempotentInflight(key: string): Promise<string | null> | null {
  return inflight.get(key)?.promise ?? null;
}

/**
 * Claim an in-flight idempotency slot synchronously. Caller MUST re-check `idempotentItem`/`idempotentInflight` right
 * before calling this (with no `await` in between) and always call the returned finisher in `finally`.
 */
export function startIdempotentInflight(key: string): (itemId: string | null) => void {
  let resolve!: (id: string | null) => void;
  const promise = new Promise<string | null>((r) => {
    resolve = r;
  });
  const entry = { promise, resolve };
  inflight.set(key, entry);
  let settled = false;
  return (itemId: string | null) => {
    if (settled) return;
    settled = true;
    if (inflight.get(key) === entry) inflight.delete(key);
    resolve(itemId);
  };
}

export function rememberIdempotent(key: string, itemId: string, now = Date.now()) {
  if (seen.size >= IDEMPOTENCY_MAX) {
    const cutoff = now - IDEMPOTENCY_TTL_MS;
    for (const [k, row] of seen) if (row.at <= cutoff) seen.delete(k);
    // Still full of live entries: drop the oldest insertion. Map preserves insertion order.
    while (seen.size >= IDEMPOTENCY_MAX) seen.delete(seen.keys().next().value as string);
  }
  seen.set(key, { itemId, at: now });
}

export function resetIdempotency() {
  seen.clear();
  for (const [, entry] of inflight) entry.resolve(null);
  inflight.clear();
}
