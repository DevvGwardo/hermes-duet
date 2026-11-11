/**
 * A failure whose message was written for the person using the app, not for a log: "send an image, a PDF, text or
 * audio", "a channel name needs at least one letter or number". It carries its own HTTP status so the layer that turns
 * errors into responses (`apiError` in index.ts) returns the sentence instead of guessing from its wording and
 * turning a validation message into an unexplained 500.
 *
 * Anything else thrown at that layer is treated as internal: validation sentences we did not mark here still go
 * through the heuristic, and every other error keeps being replaced by a code, so nothing internal leaks.
 */
export class UserError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 413 | 429 | 503 = 400,
  ) {
    super(message);
    this.name = 'UserError';
  }
}
