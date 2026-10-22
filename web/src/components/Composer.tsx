import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import { Icon } from '../ui';

export interface ComposerHandle {
  prefill: (text: string) => void;
  focus: () => void;
}

const SpeechRecognition: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

export const Composer = forwardRef<ComposerHandle, { onSent?: () => void }>(function Composer({ onSent }, ref) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [listening, setListening] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // "Run in background": the next send starts its own task instead of going to the chat, so it runs alongside.
  const [bg, setBg] = useState(false);
  const busy = useStore((s) => s.agent.busy);
  const queued = useStore((s) => s.agent.queued);
  const hermesDown = useStore((s) => s.agent.hermes === 'down');
  const ta = useRef<HTMLTextAreaElement>(null);
  const rec = useRef<any>(null);
  const base = useRef('');

  useImperativeHandle(ref, () => ({
    prefill(t: string) {
      setText(t);
      requestAnimationFrame(() => {
        ta.current?.focus();
        ta.current?.setSelectionRange(t.length, t.length);
      });
    },
    focus() {
      ta.current?.focus();
    },
  }));

  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [text]);

  async function send(background = bg) {
    const t = text.trim();
    if (!t || sending) return;
    rec.current?.stop();
    setSending(true);
    setErr(null);
    onSent?.();
    try {
      await (background ? api.startTask(t) : api.send(t));
      setText('');
      setBg(false);
    } catch (e: any) {
      setErr(e.message ?? 'Could not send');
    } finally {
      setSending(false);
    }
  }

  function toggleMic() {
    if (listening) {
      rec.current?.stop();
      return;
    }
    const r = new SpeechRecognition();
    r.lang = navigator.language || 'en-US';
    r.interimResults = true;
    r.continuous = true;
    base.current = text ? text.replace(/\s*$/, ' ') : '';
    r.onresult = (e: any) => {
      let out = '';
      for (let i = 0; i < e.results.length; i++) out += e.results[i][0].transcript;
      setText(base.current + out);
    };
    r.onend = () => setListening(false);
    r.onerror = () => setListening(false);
    rec.current = r;
    r.start();
    setListening(true);
  }

  const showStop = busy && !text.trim();
  return (
    <div className="composer-wrap">
      {queued > 0 && (
        <div className="composer-hint">
          Queued {queued} message{queued > 1 ? 's' : ''}. {hermesDown ? "Hermes is offline; they go out as soon as it's back." : "I'll pick it up when this step finishes."}
        </div>
      )}
      {err && <div className="composer-hint error">{err}</div>}
      {bg ? (
        <div className="composer-hint bg">Runs as its own task, alongside the chat. Follow it in Tasks.</div>
      ) : (
        busy &&
        text.trim() && (
          <div className="composer-hint">
            This goes into the current turn.
            <button className="hint-action" onMouseDown={(e) => e.preventDefault()} onClick={() => send(true)} disabled={sending}>
              Run separately
            </button>
          </div>
        )
      )}
      <div className={`composer ${listening ? 'listening' : ''} ${bg ? 'bg' : ''}`}>
        <textarea
          ref={ta}
          rows={1}
          value={text}
          placeholder={bg ? 'Run in the background…' : busy ? 'Steer, or add something…' : 'Message Hermes Duet'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !(e.nativeEvent as any).isComposing && window.matchMedia('(pointer: fine)').matches) {
              e.preventDefault();
              send(bg || e.metaKey || e.ctrlKey);
            }
          }}
          enterKeyHint="send"
        />
        {SpeechRecognition && (
          <button className={`icon-btn mic ${listening ? 'on' : ''}`} onClick={toggleMic} aria-label={listening ? 'Stop dictation' : 'Dictate'}>
            <Icon.mic size={20} />
          </button>
        )}
        <button
          className={`icon-btn bg-toggle ${bg ? 'on' : ''}`}
          onMouseDown={(e) => e.preventDefault() /* keep the keyboard up */}
          onClick={() => setBg((b) => !b)}
          aria-pressed={bg}
          aria-label="Run in background"
          title="Run in background (⌘↵ / Ctrl+↵)"
        >
          <Icon.tasks size={19} />
        </button>
        {showStop && !bg ? (
          <button className="icon-btn send stop" onClick={() => api.stop()} aria-label="Stop">
            <Icon.stop size={18} />
          </button>
        ) : (
          <button className="icon-btn send" onClick={() => send()} disabled={!text.trim() || sending} aria-label={bg ? 'Start task' : 'Send'}>
            <Icon.send size={20} />
          </button>
        )}
      </div>
    </div>
  );
});
