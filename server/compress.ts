// Content negotiation for the static build and JSON responses. Kept pure so the HTTP layer and its tests share one
// rule: `br` when the client accepts it, else `gzip`, else nothing. A `q=0` is a refusal, not a preference.

export type Encoding = 'br' | 'gzip';

/** The quality for one coding in an Accept-Encoding header, 0 when absent. `*` covers anything not named. */
function quality(accept: string, coding: string): number {
  let wildcard = 0;
  for (const part of accept.split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    const weight = q === undefined ? 1 : Number(q.slice(2));
    const value = Number.isFinite(weight) ? Math.max(0, Math.min(1, weight)) : 1;
    if (name === coding) return value;
    if (name === '*') wildcard = value;
  }
  return wildcard;
}

export function preferredEncoding(req: Request): Encoding | null {
  const accept = req.headers.get('accept-encoding') ?? '';
  if (!accept) return null;
  if (quality(accept, 'br') > 0) return 'br';
  if (quality(accept, 'gzip') > 0) return 'gzip';
  return null;
}

/** The precompressed sibling to serve (`app.js.br`), or `null` when the build did not produce one. */
export function encodedPath(path: string, encoding: Encoding, exists: (candidate: string) => boolean): string | null {
  const sibling = `${path}.${encoding === 'br' ? 'br' : 'gz'}`;
  return exists(sibling) ? sibling : null;
}

/** `content-encoding` and `vary` for a response that actually used a compressed body. */
export function encodingHeaders(encoding: Encoding | null): Record<string, string> {
  const headers: Record<string, string> = { vary: 'accept-encoding' };
  if (encoding) headers['content-encoding'] = encoding;
  return headers;
}
