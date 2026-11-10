import { useEffect, useRef, useState } from 'react';
import type { Connector, ConnectorSuggestion } from '../../../shared/types';
import { api } from '../api';
import { useDialogTrap } from '../hooks/useDialogTrap';
import { Icon } from '../ui';

interface SuggestionsResponse {
  suggestions: ConnectorSuggestion[];
  connected: { toolsets: string[] | null; apps: string[]; connectors: Connector[] };
}

/**
 * Read-only connector discovery: what is connected (Hermes toolsets, MCP apps and the native bridges) and
 * what the user might connect next. It never installs, authorizes or tests anything — every hint is
 * guidance to follow by hand, so there is deliberately no action button.
 */
export function ConnectorsSheet({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<SuggestionsResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement | null>(null);
  useDialogTrap(dialog);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    api.suggestions().then(setData, (e) => setErr(e?.message ?? 'Could not load connectors.'));
  }, []);

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        ref={dialog}
        className="sheet connectors-sheet"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Connectors"
      >
        <header className="sheet-head">
          <div className="sheet-title">
            <strong>Connectors</strong>
            <span className="muted">What I can reach, and what to add next</span>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon.close size={20} />
          </button>
        </header>
        <div className="settings-body">
          {err && <p className="card-error">{err}</p>}
          {!data && !err && <p className="muted small">Checking…</p>}
          {data && (
            <>
              <section>
                <h3>Connected</h3>
                <dl className="can-see">
                  <dt>Toolsets</dt>
                  <dd>
                    {data.connected.toolsets === null ? (
                      <span className="muted">Hermes didn't answer.</span>
                    ) : data.connected.toolsets.length ? (
                      data.connected.toolsets.join(' · ')
                    ) : (
                      <span className="muted">None enabled.</span>
                    )}
                  </dd>
                  <dt>Apps</dt>
                  <dd>{data.connected.apps.length ? data.connected.apps.join(' · ') : <span className="muted">None besides Duet.</span>}</dd>
                </dl>
                <ul className="connector-list">
                  {data.connected.connectors.map((c) => (
                    <li key={c.id} className={`connector ${c.status}`}>
                      <span className={`conn-dot ${c.status}`} aria-hidden="true" />
                      <span className="connector-main">
                        <span className="connector-name">{c.name}</span>
                        <span className="connector-detail">{c.detail}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </section>

              <section>
                <h3>Suggested next</h3>
                {data.suggestions.length === 0 ? (
                  <p className="muted small">Everything looks connected.</p>
                ) : (
                  <ul className="suggest-list">
                    {data.suggestions.map((s) => (
                      <li key={s.id} className="suggest-card">
                        <span className="suggest-title">{s.title}</span>
                        <span className="suggest-detail">{s.detail}</span>
                        {s.hint && <span className="suggest-hint">{s.hint}</span>}
                      </li>
                    ))}
                  </ul>
                )}
                <p className="muted small">Nothing here installs itself. Follow a hint, then test the connector in Settings.</p>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
