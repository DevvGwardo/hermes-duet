// What an agent reply is allowed to load. Kept out of the React layer so the rule is testable.

/**
 * An image in a delivered/received reply may only be one the app itself serves, or an inline data: image. Anything
 * else is a remote fetch the phone makes on render — a tracking pixel, an IP leak, or a beacon that tells a third
 * party the agent opened a page. The markdown renderer drops those rather than proxying them.
 */
export function sameOriginImage(src: string): boolean {
  const s = String(src ?? '').trim();
  if (!s) return false;
  if (/^data:image\//i.test(s)) return true;
  // Root-relative only: "//host/x" is protocol-relative and leaves the origin.
  return s.startsWith('/') && !s.startsWith('//');
}

/** The host an image was dropped from, for the alt text that replaces it. Never the full URL. */
export function droppedImageHost(src: string): string {
  try {
    // Only an absolute URL has a third-party host worth naming; anything else is "remote" rather than the app's own.
    return new URL(String(src ?? '')).host || 'remote';
  } catch {
    return 'remote';
  }
}
