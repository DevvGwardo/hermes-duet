/** A chat message steered into a live run: `sent` is what Hermes got (with the waiting-cards prefix), `raw` the user's text. */
export interface Steer {
  sent: string;
  raw: string;
  /** Already queued as its own turn, by a refused steer or by replay, so the other path must not queue it again. */
  queued?: boolean;
}

/**
 * The steers the run ended without delivering. Hermes joins undelivered steer text with "\n" (each one
 * stripped) and returns it as `pending_steer` on the terminal event for the client to replay; a steer drained into an
 * earlier tool batch is absent from it. Each steer consumes one occurrence of its text, so two identical messages
 * where only one was delivered replay once. The raw text is replayed, not `pending_steer`, because launch adds a
 * fresh waiting-cards note to the new turn.
 */
/**
 * Where `sent` sits in `rest` as a whole line of the joined payload. A bare `indexOf` also matches inside another
 * steer: with "send it" delivered and "don't send it" still pending, it would consume the delivered text from the
 * middle of the pending one, replay the retracted instruction and lose the real message.
 */
function wholeLineIndex(rest: string, sent: string): number {
  let from = 0;
  for (;;) {
    const at = rest.indexOf(sent, from);
    if (at === -1) return -1;
    const startsLine = at === 0 || rest[at - 1] === '\n';
    const ends = at + sent.length;
    const endsLine = ends === rest.length || /\s/.test(rest[ends]);
    if (startsLine && endsLine) return at;
    from = at + 1;
  }
}

export function undeliveredSteers(steers: Steer[], pending: unknown): Steer[] {
  if (typeof pending !== 'string' || !pending.trim()) return [];
  let rest = pending;
  const matched = new Set<number>();
  // Longest first, so a delivered shorter steer cannot claim a substring of a longer pending one ("yes" inside
  // "yes please"). The returned list stays in the order the user sent them.
  const byLength = steers
    .map((_, i) => i)
    .filter((i) => steers[i].sent.trim())
    .sort((a, b) => steers[b].sent.trim().length - steers[a].sent.trim().length || a - b);
  for (const i of byLength) {
    const sent = steers[i].sent.trim();
    const at = wholeLineIndex(rest, sent);
    if (at === -1) continue;
    rest = rest.slice(0, at) + rest.slice(at + sent.length);
    matched.add(i);
  }
  return steers.filter((s, i) => matched.has(i) && !s.queued);
}
