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
export function undeliveredSteers(steers: Steer[], pending: unknown): Steer[] {
  if (typeof pending !== 'string' || !pending.trim()) return [];
  let rest = pending;
  const out: Steer[] = [];
  for (const s of steers) {
    const sent = s.sent.trim();
    const at = sent ? rest.indexOf(sent) : -1;
    if (at === -1) continue;
    rest = rest.slice(0, at) + rest.slice(at + sent.length);
    if (!s.queued) out.push(s);
  }
  return out;
}
