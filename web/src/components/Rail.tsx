import { useStore } from '../store';
import { Icon, fileIcon, relLabel } from '../ui';

/** Desktop-only context rail: what needs you, what's running, what just landed. */
export function Rail({ onJump, onOpenFile, onShowTasks }: { onJump: (id: string) => void; onOpenFile: (id: string) => void; onShowTasks: () => void }) {
  const pending = useStore((s) => s.pending);
  const tasks = useStore((s) => s.tasks);
  const files = useStore((s) => s.files);
  const active = tasks.filter((t) => ['running', 'queued', 'waiting'].includes(t.status));

  return (
    <aside className="rail">
      <section className="rail-section">
        <h2 className="eyebrow">
          Needs you {pending.length > 0 && <span className="count warm">{pending.length}</span>}
        </h2>
        {pending.length === 0 ? (
          <p className="rail-empty">Nothing waiting on you.</p>
        ) : (
          <ul className="rail-list">
            {pending.map((c) => (
              <li key={c.id}>
                <button className="rail-row attention" onClick={() => onJump(c.id)}>
                  <span className="glow-dot warm" />
                  <span className="rail-main">
                    <span className="rail-title">{c.card!.title}</span>
                    <span className="rail-sub">
                      {c.card!.type === 'approval' ? 'Approval' : 'Question'} · {relLabel(c.created_at)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rail-section">
        <h2 className="eyebrow">
          Working on {active.length > 0 && <span className="count">{active.length}</span>}
        </h2>
        {active.length === 0 ? (
          <p className="rail-empty">Nothing in flight. Hand me something bigger and it'll show up here.</p>
        ) : (
          <ul className="rail-list">
            {active.map((t) => {
              const done = t.steps.filter((s) => s.done).length;
              const pct = t.steps.length ? (done / t.steps.length) * 100 : t.status === 'running' ? 35 : 0;
              return (
                <li key={t.id}>
                  <button className="rail-row" onClick={onShowTasks}>
                    <span className={`glow-dot ${t.status === 'waiting' ? 'warm' : t.status === 'running' ? 'live' : ''}`} />
                    <span className="rail-main">
                      <span className="rail-title">{t.title}</span>
                      <span className="rail-sub">{t.status === 'waiting' ? 'Waiting on you' : t.progress?.replace(/^· /, '') || (t.status === 'queued' ? 'Queued' : 'Working')}</span>
                      <span className={`mini-bar ${t.status === 'running' && !t.steps.length ? 'indeterminate' : ''}`}>
                        <span style={{ width: `${pct}%` }} />
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="rail-section">
        <h2 className="eyebrow">Recent files</h2>
        {files.length === 0 ? (
          <p className="rail-empty">Docs, decks and dashboards land here.</p>
        ) : (
          <ul className="rail-list">
            {files.slice(0, 6).map((f) => {
              const FIcon = fileIcon(f.mime, f.name);
              return (
                <li key={f.id}>
                  <button className="rail-row" onClick={() => onOpenFile(f.id)}>
                    <span className="file-icon small">
                      <FIcon size={16} />
                    </span>
                    <span className="rail-main">
                      <span className="rail-title">{f.title}</span>
                      <span className="rail-sub">{relLabel(f.created_at)}</span>
                    </span>
                    <Icon.chevron size={16} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </aside>
  );
}
