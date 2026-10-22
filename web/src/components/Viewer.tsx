import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { Icon, Markdown, bytesLabel } from '../ui';

export function Viewer({ fileId, onClose }: { fileId: string; onClose: () => void }) {
  const file = useStore((s) => s.files.find((f) => f.id === fileId));
  const [text, setText] = useState<string | null>(null);
  const src = `/api/files/${encodeURIComponent(fileId)}`;
  const kind = !file
    ? 'none'
    : file.mime.startsWith('image/')
      ? 'image'
      : file.mime === 'text/html' || file.mime === 'application/pdf'
        ? 'frame'
        : file.mime === 'text/markdown' || /\.md$/i.test(file.name)
          ? 'markdown'
          : file.mime.startsWith('text/') || /json|csv/.test(file.mime)
            ? 'text'
            : 'download';

  useEffect(() => {
    if (kind !== 'markdown' && kind !== 'text') return;
    fetch(src, { credentials: 'include' })
      .then((r) => r.text())
      .then(setText)
      .catch(() => setText('Could not load this file.'));
  }, [src, kind]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet viewer" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <header className="sheet-head">
          <div className="sheet-title">
            <strong>{file?.title ?? 'File'}</strong>
            {file && (
              <span className="muted">
                {file.name} · {bytesLabel(file.size)}
              </span>
            )}
          </div>
          <a className="btn btn-ghost small" href={`${src}?download=1`}>
            Download
          </a>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon.close size={20} />
          </button>
        </header>
        <div className="viewer-body">
          {kind === 'image' && <img src={src} alt={file!.title} />}
          {/* HTML deliverables run sandboxed without same-origin, so they can't reach the API. */}
          {kind === 'frame' && <iframe src={src} title={file!.title} sandbox="allow-scripts allow-popups allow-downloads" />}
          {kind === 'markdown' && text !== null && <Markdown text={text} className="doc" />}
          {kind === 'text' && text !== null && <pre className="doc-pre">{text}</pre>}
          {kind === 'download' && <p className="muted pad">No preview for this type. Use Download.</p>}
        </div>
      </div>
    </div>
  );
}
