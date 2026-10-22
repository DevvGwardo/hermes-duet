import { useEffect, useState } from 'react';
import type { Capabilities } from '../../../shared/types';
import { api } from '../api';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * What the agent starts every turn with: the context file's sources, Hermes skills, enabled toolsets and
 * MCP apps. `compact` is the one-line version under the empty thread; the full list lives in Settings.
 */
export function WhatICanSee({ compact = false }: { compact?: boolean }) {
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.capabilities().then(
      (c) => live && setCaps(c),
      (e) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, []);

  if (compact) {
    if (!caps) return null;
    const parts = [
      caps.context.length ? caps.context.slice(0, 3).join(', ') : '',
      caps.skills.total ? plural(caps.skills.total, 'skill') : '',
      caps.apps.length ? plural(caps.apps.length, 'connected app') : '',
    ].filter(Boolean);
    if (!parts.length) return null;
    return (
      <p className="can-see-line">
        <strong>Already here:</strong> {parts.join(' · ')}
      </p>
    );
  }

  if (error) return <p className="muted small">Couldn't check: {error}</p>;
  if (!caps) return <p className="muted small">Checking…</p>;

  const top = caps.skills.categories.slice(0, 6);
  const more = caps.skills.categories.length - top.length;
  return (
    <dl className="can-see">
      <dt>Your context</dt>
      <dd>{caps.context.length ? caps.context.join(' · ') : <span className="muted">No context file yet. Copy context.example.md to context.local.md on the Mac.</span>}</dd>
      <dt>Skills</dt>
      <dd>
        {caps.skills.total ? (
          <>
            {plural(caps.skills.total, 'skill')}
            {top.length > 0 && (
              <span className="muted">
                {' '}
                ({top.map((c) => `${c.name} ${c.count}`).join(', ')}
                {more > 0 ? `, ${more} more` : ''})
              </span>
            )}
            {caps.skills_from === 'files' && <span className="muted"> · read from ~/.hermes/skills</span>}
          </>
        ) : (
          <span className="muted">Hermes didn't list any.</span>
        )}
      </dd>
      <dt>Tools</dt>
      <dd>{caps.toolsets === null ? <span className="muted">Hermes didn't answer.</span> : caps.toolsets.length ? caps.toolsets.join(' · ') : <span className="muted">None enabled.</span>}</dd>
      <dt>Apps</dt>
      <dd>{caps.apps.length ? caps.apps.join(' · ') : <span className="muted">None besides Duet.</span>}</dd>
    </dl>
  );
}
