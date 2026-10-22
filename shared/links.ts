// Which card a push or link points at. Pushes name it two ways: `card_id` (questions, approvals, interrupted work)
// or only the `?card=` in their URL (briefs, task handovers). Dependency-free so the server's held pushes and the
// web app's notification taps read both the same way.

export function cardOf(p: { card_id?: string | null; url?: string | null }): string | null {
  return p.card_id || p.url?.match(/[?&]card=([^&#]+)/)?.[1] || null;
}
