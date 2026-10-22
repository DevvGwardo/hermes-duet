import type { FileEntry, Page, Task } from '../../../shared/types';
import { useStore } from '../store';
import { Icon, bytesLabel, dayLabel, fileIcon, relLabel, timeLabel } from '../ui';

const STARTERS = [
  { icon: Icon.deck, label: 'A deck', prompt: 'Make me a deck about ' },
  { icon: Icon.chart, label: 'A dashboard', prompt: 'Build me a dashboard that tracks ' },
  { icon: Icon.sheet, label: 'A spreadsheet', prompt: 'Make a spreadsheet for ' },
  { icon: Icon.doc, label: 'A brief', prompt: 'Write me a one-page brief on ' },
];

export function MakeView({ onStart, onOpenFile }: { onStart: (prompt: string) => void; onOpenFile: (id: string) => void }) {
  const files = useStore((s) => s.files);
  const pages = useStore((s) => s.pages);
  const tasks = useStore((s) => s.tasks);
  return (
    <div className="pane make-pane">
      {pages.length > 0 && (
        <section>
          <h2 className="section-title">Every morning</h2>
          <ul className="list">
            {pages.map((p) => (
              <li key={p.id}>
                <PageRow page={p} file={files.find((f) => f.id === p.file_id)} task={tasks.find((t) => t.id === p.task_id)} onOpen={() => onOpenFile(p.file_id)} />
              </li>
            ))}
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
        {files.length === 0 ? (
          <p className="muted pad">Docs, sheets, decks and dashboards I finish for you land here.</p>
        ) : (
          <ul className="list">
            {files.map((f) => {
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

/** A standing page: when its current version arrived, and the one thing that changed (or why nothing did). */
function PageRow({ page, file, task, onOpen }: { page: Page; file?: FileEntry; task?: Task; onOpen: () => void }) {
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
  return (
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
  );
}
