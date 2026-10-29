import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import { useDialogTrap } from '../hooks/useDialogTrap';
import { Icon, Markdown, bytesLabel } from '../ui';

/**
 * The viewer: a delivered file on its phone. HTML runs in a sandboxed frame (no cookies, no API access) with the
 * Duet bridge appended by the server, so buttons inside a dashboard come back as messages here.
 *
 * `compareId` turns it into a version slider for a standing page: the previous version sits on top, clipped to the
 * left of the handle, so sliding shows what changed between yesterday's page and today's.
 */
export function Viewer({ fileId, compareId, onClose }: { fileId: string; compareId?: string | null; onClose: () => void }) {
  const file = useStore((s) => s.files.find((f) => f.id === fileId));
  const older = useStore((s) => s.files.find((f) => f.id === compareId));
  const [text, setText] = useState<string | null>(null);
  const [olderText, setOlderText] = useState<string | null>(null);
  const [split, setSplit] = useState(50);
  const [note, setNote] = useState<string | null>(null);
  const frame = useRef<HTMLIFrameElement | null>(null);
  const dialog = useRef<HTMLDivElement | null>(null);
  useDialogTrap(dialog);
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
    if (!compareId) return;
    fetch(`/api/files/${encodeURIComponent(compareId)}`, { credentials: 'include' })
      .then((r) => r.text())
      .then(setOlderText)
      .catch(() => setOlderText('Could not load the previous version.'));
  }, [compareId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // A dashboard's buttons: only messages from *this* frame count, and only the two shapes the bridge sends.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const win = frame.current?.contentWindow;
      if (!win || e.source !== win || !e.data || typeof e.data !== 'object') return;
      const msg = e.data as { type?: string; data?: any };
      if (msg.type === 'duet_action') {
        const action = String(msg.data?.action ?? '').slice(0, 64);
        if (!action) return;
        api
          .deliverableAction(fileId, action, msg.data?.payload)
          .then(() => setNote(`Sent “${action}” to Hermes.`))
          .catch((err) => setNote(err?.message ?? 'That did not go through.'));
      } else if (msg.type === 'duet_approval') {
        api
          .deliverableApproval(fileId, { title: msg.data?.title, summary: msg.data?.summary, action_label: msg.data?.action_label })
          .then(() => setNote('Approval card posted. Check Needs you.'))
          .catch((err) => setNote(err?.message ?? 'Could not post that approval.'));
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [fileId]);

  function print() {
    try {
      frame.current?.contentWindow?.print();
      return;
    } catch {}
    window.open(src, '_blank', 'noopener');
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(text ?? '');
      setNote('Copied.');
    } catch {
      setNote('Could not copy on this device.');
    }
  }

  const canCopy = (kind === 'markdown' || kind === 'text') && text !== null;

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div ref={dialog} className="sheet viewer" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <header className="sheet-head">
          <div className="sheet-title">
            <strong>{file?.title ?? 'File'}</strong>
            {file && (
              <span className="muted">
                {file.name} · {bytesLabel(file.size)}
              </span>
            )}
            {compareId && older && (
              <span className="muted compare-label">vs {new Date(older.created_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>
            )}
          </div>
          {kind === 'frame' && (
            <button className="btn btn-ghost small" onClick={print}>
              Print
            </button>
          )}
          {canCopy && (
            <button className="btn btn-ghost small" onClick={copy}>
              Copy
            </button>
          )}
          <a className="btn btn-ghost small" href={`${src}?download=1`}>
            Download
          </a>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon.close size={20} />
          </button>
        </header>
        {note && (
          <div className="viewer-note" onClick={() => setNote(null)}>
            {note}
          </div>
        )}
        {compareId ? (
          <div className="compare">
            <div className="compare-stage">
              <div className="compare-pane">
                {kind === 'frame' ? (
                  <iframe src={src} title={file?.title ?? 'Current version'} sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals" />
                ) : kind === 'markdown' ? (
                  text !== null && <Markdown text={text} className="doc" />
                ) : (
                  text !== null && <pre className="doc-pre">{text}</pre>
                )}
              </div>
              <div className="compare-pane compare-older" style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}>
                {kind === 'frame' ? (
                  <iframe
                    src={`/api/files/${encodeURIComponent(compareId)}`}
                    title="Previous version"
                    sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads"
                  />
                ) : kind === 'markdown' ? (
                  olderText !== null && <Markdown text={olderText} className="doc" />
                ) : (
                  olderText !== null && <pre className="doc-pre">{olderText}</pre>
                )}
              </div>
              <span className="compare-tag left">Previous</span>
              <span className="compare-tag right">Now</span>
            </div>
            <label className="compare-slider">
              <span className="muted">Slide to compare</span>
              <input type="range" min={0} max={100} value={split} onChange={(e) => setSplit(Number(e.target.value))} aria-label="Compare previous and current version" />
            </label>
          </div>
        ) : (
          <div className="viewer-body">
            {kind === 'image' && <img src={src} alt={file!.title} />}
            {/* HTML deliverables run sandboxed without same-origin, so they can't reach the API. The server appends the
                Duet bridge; its buttons post messages that this component turns into agent turns or approval cards. */}
            {kind === 'frame' && (
              <iframe
                ref={frame}
                src={src}
                title={file!.title}
                sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals"
              />
            )}
            {kind === 'markdown' && text !== null && <Markdown text={text} className="doc" />}
            {kind === 'text' && text !== null && <pre className="doc-pre">{text}</pre>}
            {kind === 'download' && <p className="muted pad">No preview for this type. Use Download.</p>}
          </div>
        )}
      </div>
    </div>
  );
}