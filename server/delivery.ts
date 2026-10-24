import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

// Paths the agent may never hand to the phone, even by accident.
const DENY = /(^|\/)(\.ssh|\.gnupg|\.aws|\.config\/gcloud|Keychains)(\/|$)|(^|\/)\.env(\.|$)|auth\.json$|credentials|\.pem$|\.p12$|\.key$|id_(rsa|ed25519|ecdsa)|internal\.token$|duet\.db/i;

/** Resolve symlinks before applying the secrets denylist, since copyFileSync follows them too. */
export function deliverySource(path: string): string {
  if (!isAbsolute(path)) throw new Error('path must be absolute');
  const requested = resolve(path);
  if (DENY.test(requested)) throw new Error('that path looks like secrets; refusing to deliver it');
  const src = realpathSync(requested);
  if (DENY.test(src)) throw new Error('that path looks like secrets; refusing to deliver it');
  return src;
}
