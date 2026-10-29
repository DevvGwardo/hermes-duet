import { useState } from 'react';
import { shelf } from '../../../shared/shelf';
import type { FileEntry, Page, Task } from '../../../shared/types';
import { api } from '../api';
import { useStore } from '../store';
import { Icon, bytesLabel, dayLabel, fileIcon, relLabel, timeLabel } from '../ui';

const STARTERS = [
  { icon: Icon.deck, label: 'A deck', prompt: 'Make me a deck about ' },
  { icon: Icon.chart, label: 'A dashboard', prompt: 'Build me a dashboard that tracks ' },
  { icon: Icon.sheet, label: 'A spreadsheet', prompt: 'Make a spreadsheet for ' },
  { icon: Icon.doc, label: 'A brief', prompt: 'Write me a one-page brief on ' },
];

export function MakeView({ onStart, onOpenFile, onCompare }: { onStart: (prompt: string) => void; onOpenFile: (id: string) => void; onCompare?: (current: string, previous: string) => void }) {
  const files = useStore((s) => s.files);
  const pages = useStore((s) => s.pages);
  const tasks = useStore((s) => s.tasks);
  const shown = shelf(files, pages.map((p) => p.id));
  // Every delivered version of a page stays in the files list; the newest one is current, the one before it is what
  // "Compare" slides against.
  const versionsOf = (page: Page) =>
    files.filter((f) => f.page_id === page.id).sort((a, b) => b.created_at - a.created_at);
  return (
    <div className="pane make-pane">
      {pages.length > 0 && (
        <section>
          <h2 className="section-title">Every morning</h2>
          <ul className="list">
            {pages.map((p) => {
              const previous = versionsOf(p).find((f) => f.id !== p.file_id);
              return (
                <li key={p.id}>
                  <PageRow
                    page={p}
                    file={files.find((f) => f.id === p.file_id)}
                    task={tasks.find((t) => t.id === p.task_id)}
                    previous={previous}
                    onOpen={() => onOpenFile(p.file_id)}
                    onCompare={previous && onCompare ? () => onCompare(p.file_id, previous.id) : undefined}
                  />
                </li>
              );
            })}
          </ul>
        </section>
      )}
      <section>
        <h2 className="section-title">Make something</h2>
        <div className="starters">
          {STARTERS.map((s) => (
            <button key={s.label} className="starter" onClick={() => onStart(s.prompt)}>
              <s.icon size={22} />
              <span>{s.label}</span>
            </button>
          ))}
        </div>
      </section>
      <section>
        <h2 className="section-title">Your files</h2>
        {shown.length === 0 ? (
          <p className="muted pad">Docs, sheets, decks and dashboards I finish for you land here.</p>
        ) : (
          <ul className="list">
            {shown.map((f) => {
              const FIcon = fileIcon(f.mime, f.name);
              return (
                <li key={f.id}>
                  <button className="row" onClick={() => onOpenFile(f.id)}>
                    <span className="file-icon">
                      <FIcon size={20} />
                    </span>
                    <span className="row-main">
                      <span className="row-title">{f.title}</span>
                      <span className="row-sub">
                        {f.name} · {bytesLabel(f.size)} · {relLabel(f.created_at)}
                      </span>
                    </span>
                    <Icon.chevron size={18} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

/**
 * A standing page: when its current version arrived, and the one thing that changed (or why nothing did).
 * "Stop refreshing" takes a second tap to confirm; the row disappears when the server's page_removed event lands.
 */
function PageRow({
  page,
  file,
  task,
  previous,
  onOpen,
  onCompare,
}: {
  page: Page;
  file?: FileEntry;
  task?: Task;
  previous?: FileEntry;
  onOpen: () => void;
  onCompare?: () => void;
}) {
  const FIcon = file ? fileIcon(file.mime, file.name) : Icon.file;
  const at = page.refreshed_at ?? page.created_at;
  const day = dayLabel(at);
  const refreshing = !!task && ['queued', 'running', 'waiting'].includes(task.status);
  const note = refreshing
    ? { text: 'Refreshing now…', cls: '' }
    : page.last_ok === false
      ? { text: `Didn’t refresh: ${page.last_result ?? 'no reason given'}`, cls: ' failed' }
      : page.last_ok && page.changed
        ? { text: page.changed, cls: '' }
        : null;
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const stop = async () => {
    setBusy(true);
    setErr('');
    try {
      await api.stopPage(page.id);
    } catch (e: any) {
      setErr(e?.message ?? 'Could not stop it.');
      setBusy(false);
    }
  };
  return (
    <>
      <button className="row" onClick={onOpen}>
        <span className="file-icon">
          <FIcon size={20} />
        </span>
        <span className="row-main">
          <span className="row-title">{page.title}</span>
          <span className="row-sub">Refreshed {day === 'Today' ? timeLabel(at) : `${day}, ${timeLabel(at)}`}</span>
          {note && <span className={`page-change${note.cls}`}>{note.text}</span>}
        </span>
        <Icon.chevron size={18} />
      </button>
      <div className="page-actions">
        {onCompare && previous && (
          <button className="btn btn-ghost small" onClick={onCompare}>
            Compare with {dayLabel(previous.created_at) === 'Yesterday' ? 'yesterday' : new Date(previous.created_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}
          </button>
        )}
        {confirm ? (
          <>
            <span className="muted">{refreshing ? 'Cancel today’s refresh and stop?' : 'Stop refreshing every morning?'} Its files stay.</span>
            <button className="btn btn-ghost small" disabled={busy} onClick={stop}>
              Stop
            </button>
            <button className="btn btn-ghost small" disabled={busy} onClick={() => setConfirm(false)}>
              Keep
            </button>
          </>
        ) : (
          <button className="btn btn-ghost small" onClick={() => setConfirm(true)}>
            Stop refreshing
          </button>
        )}
      </div>
      {err && <p className="card-error page-error">{err}</p>}
    </>
  );
}
