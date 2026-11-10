import { useEffect, useRef, useState } from 'react';
import type { MemoryState } from '../../../shared/types';
import { api } from '../api';
import { useDialogTrap } from '../hooks/useDialogTrap';
import { Icon } from '../ui';

/**
 * The context file, editable in the app. This is the agent's memory: the one file it reads before the first message
 * of every turn. Saving writes it in place; Reset removes it so the next turn starts clean.
 */
export function MemorySheet({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<MemoryState | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement | null>(null);
  useDialogTrap(dialog);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Capture phase, so the outer Settings sheet's own Escape handler doesn't close both dialogs at once.
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  useEffect(() => {
    let live = true;
    api.memory().then(
      (m) => {
        if (!live) return;
        setState(m);
        setText(m.text);
      },
      (e) => live && setErr(e?.message ?? 'Could not load memory.'),
    );
    return () => {
      live = false;
    };
  }, []);

  async function save() {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const next = await api.saveMemory(text);
      setState(next);
      setText(next.text);
      setMsg('Saved.');
    } catch (e: any) {
      setErr(e?.message ?? 'Could not save.');
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    if (!window.confirm('Clear the memory? The next turn starts with none of this.')) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const next = await api.clearMemory();
      setState(next);
      setText(next.text);
      setMsg('Cleared.');
    } catch (e: any) {
      setErr(e?.message ?? 'Could not clear.');
    } finally {
      setBusy(false);
    }
  }

  const max = state?.max_bytes ?? 32 * 1024;
  const bytes = new TextEncoder().encode(text).length;
  const over = bytes > max;

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div ref={dialog} className="sheet settings memory-sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Memory">
        <header className="sheet-head">
          <div className="sheet-title">
            <strong>Memory</strong>
            <span className="muted">What I start each turn with</span>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon.close size={20} />
          </button>
        </header>
        <div className="settings-body">
          <section>
            <p className="muted small">
              This is the context file on your Mac{state ? ` (${state.path})` : ''}. I read it before your first message every turn. Edit it
              here, or reset it to start clean.
            </p>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={10}
              aria-label="Memory"
              placeholder="- Tasks: run `todo list --today`"
            />
            <div className="memory-meta">
              <span className={over ? 'memory-over' : ''}>
                {text.length} characters · {bytes} B
              </span>
              <span>Limit {max} bytes</span>
            </div>
            {err && <p className="card-error">{err}</p>}
            {msg && <p className="muted small">{msg}</p>}
            <div className="memory-btns">
              <button className="btn btn-primary small" disabled={busy || over} onClick={save}>
                {busy ? 'Saving…' : 'Save'}
              </button>
              <button className="btn btn-ghost small" disabled={busy} onClick={reset}>
                Reset
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
