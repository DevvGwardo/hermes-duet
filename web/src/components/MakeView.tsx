import { useStore } from '../store';
import { Icon, bytesLabel, fileIcon, relLabel } from '../ui';

const STARTERS = [
  { icon: Icon.deck, label: 'A deck', prompt: 'Make me a deck about ' },
  { icon: Icon.chart, label: 'A dashboard', prompt: 'Build me a dashboard that tracks ' },
  { icon: Icon.sheet, label: 'A spreadsheet', prompt: 'Make a spreadsheet for ' },
  { icon: Icon.doc, label: 'A brief', prompt: 'Write me a one-page brief on ' },
];

export function MakeView({ onStart, onOpenFile }: { onStart: (prompt: string) => void; onOpenFile: (id: string) => void }) {
  const files = useStore((s) => s.files);
  return (
    <div className="pane make-pane">
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
