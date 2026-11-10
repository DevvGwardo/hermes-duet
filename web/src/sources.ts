/**
 * Only absolute http(s) URLs ever become links. Anything else (a deep link,
 * `javascript:`, a bare host) renders as a plain label, so a crafted source
 * can't run code or jump the app somewhere unexpected.
 */
export function isSafeSourceUrl(url: string | undefined): url is string {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}
