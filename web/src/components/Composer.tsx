import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { Attachment } from '../../../shared/types';
import { api } from '../api';
import { clockLabel, useAudioRecorder } from '../hooks/useAudioRecorder';
import { useStore } from '../store';
import { Icon } from '../ui';
import { Attachments } from './Attachments';

export interface ComposerHandle {
  prefill: (text: string) => void;
  focus: () => void;
}

const SpeechRecognition: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
/** Long enough for a walk-and-talk memo, short enough that a forgotten recording doesn't fill the disk. */
const MAX_RECORD_SECONDS = 180;

export const Composer = forwardRef<ComposerHandle, { onSent?: () => void; hidden?: boolean }>(function Composer({ onSent, hidden = false }, ref) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [listening, setListening] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // "Run in background": the next send starts its own task instead of going to the chat, so it runs alongside.
  const [bg, setBg] = useState(false);
  const [files, setFiles] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(0);
  const [transcribing, setTranscribing] = useState(false);
  const busy = useStore((s) => s.agent.busy);
  const queued = useStore((s) => s.agent.queued);
  const hermesDown = useStore((s) => s.agent.hermes === 'down');
  const ta = useRef<HTMLTextAreaElement>(null);
  const rec = useRef<any>(null);
  const base = useRef('');
  const camera = useRef<HTMLInputElement>(null);
  const library = useRef<HTMLInputElement>(null);
  const filesLenRef = useRef(0);
  filesLenRef.current = files.length;
  const uploadingRef = useRef(0);
  const stoppingRef = useRef(false);
  const recorder = useAudioRecorder();

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
    if (hidden) return;
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [text, hidden]);

  useEffect(
    () => () => {
      try {
        rec.current?.abort?.() ?? rec.current?.stop?.();
      } catch {}
      rec.current = null;
    },
    [],
  );

  // A recording left running would hold the microphone and the battery; cap it and use what was captured.
  useEffect(() => {
    if (recorder.state !== 'recording' || recorder.seconds < MAX_RECORD_SECONDS) return;
    void finishRecording();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recorder.seconds, recorder.state]);

  function noteError(message: string) {
    setErr(message);
  }

  async function uploadFiles(list: FileList | null) {
    if (!list?.length) return;
    const slots = Math.max(0, 6 - filesLenRef.current - uploadingRef.current);
    const picked = Array.from(list).slice(0, slots);
    if (!picked.length) {
      noteError('Up to six files per message.');
      return;
    }
    if (list.length > slots) noteError('Up to six files per message.');
    else setErr(null);
    uploadingRef.current += picked.length;
    setUploading((n) => n + picked.length);
    for (const file of picked) {
      try {
        const { attachment } = await api.upload(file);
        filesLenRef.current += 1;
        setFiles((f) => [...f, attachment]);
      } catch (e: any) {
        noteError(e?.message ?? `Could not upload ${file.name || 'that file'}.`);
      } finally {
        uploadingRef.current = Math.max(0, uploadingRef.current - 1);
        setUploading((n) => Math.max(0, n - 1));
      }
    }
  }

  async function finishRecording() {
    if (stoppingRef.current) return;
    stoppingRef.current = true;
    try {
      const blob = await recorder.stop();
      if (!blob) return;
      setTranscribing(true);
      setErr(null);
      try {
        const { text: heard, attachment, error } = await api.transcribe(blob);
        filesLenRef.current += 1;
        setFiles((f) => [...f, attachment]);
        const said = heard.trim();
        if (error && !said) {
          noteError(`${error} The memo is attached so you can replay or send it.`);
          return;
        }
        if (!said) {
          noteError("I couldn't make out any words. The memo is attached so you can replay it.");
          return;
        }
        if (error) noteError(error);
        setText((t) => (t.trim() ? `${t.replace(/\s*$/, ' ')}${said}` : said));
        requestAnimationFrame(() => ta.current?.focus());
      } catch (e: any) {
        noteError(e?.message ?? 'Could not transcribe that memo.');
      } finally {
        setTranscribing(false);
      }
    } finally {
      stoppingRef.current = false;
    }
  }

  async function toggleRecord() {
    if (transcribing || stoppingRef.current) return;
    if (recorder.state === 'recording') {
      await finishRecording();
      return;
    }
    setErr(null);
    await recorder.start();
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
    r.onend = () => {
      if (rec.current === r) rec.current = null;
      setListening(false);
    };
    r.onerror = () => {
      if (rec.current === r) rec.current = null;
      setListening(false);
    };
    rec.current = r;
    r.start();
    setListening(true);
  }

  async function send(background = bg) {
    const t = text.trim();
    if ((!t && !files.length) || sending || uploading > 0) return;
    rec.current?.stop();
    setSending(true);
    setErr(null);
    onSent?.();
    const ids = files.map((f) => f.id);
    // Clear optimistically. Waiting for the round trip meant a message typed while the POST was in flight was wiped
    // when it finally resolved; on failure the draft goes back, but never over something newer.
    filesLenRef.current = 0;
    setText('');
    setFiles([]);
    setBg(false);
    try {
      await (background ? api.startTask(t, ids) : api.send(t, ids));
    } catch (e: any) {
      setText((cur) => (cur.trim() ? cur : t));
      setFiles((cur) => (cur.length ? cur : files));
      setBg(background);
      setErr(e.message ?? 'Could not send');
    } finally {
      setSending(false);
    }
  }

  const recording = recorder.state === 'recording';
  const showStop = busy && !text.trim() && !files.length;
  const canSend = (!!text.trim() || files.length > 0) && uploading === 0 && !transcribing;
  return (
    <div className="composer-wrap" hidden={hidden}>
      {queued > 0 && (
        <div className="composer-hint">
          Queued {queued} message{queued > 1 ? 's' : ''}. {hermesDown ? "Hermes is offline; they go out as soon as it's back." : "I'll pick it up when this step finishes."}
        </div>
      )}
      {recording && (
        <div className="composer-hint recording">
          <span className="rec-dot" aria-hidden="true" />
          Recording {clockLabel(recorder.seconds)} · tap the mic again to stop and transcribe.
          <button className="hint-action" onClick={() => recorder.cancel()} type="button">
            Discard
          </button>
        </div>
      )}
      {transcribing && <div className="composer-hint">Transcribing on this machine…</div>}
      {(err || recorder.error) && <div className="composer-hint error">{err || recorder.error}</div>}
      {files.length > 0 && <Attachments list={files} onRemove={(id) => setFiles((f) => f.filter((a) => a.id !== id))} />}
      {uploading > 0 && <div className="composer-hint">Uploading {uploading} file{uploading > 1 ? 's' : ''}…</div>}
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
      <div className={`composer ${listening || recording ? 'listening' : ''} ${bg ? 'bg' : ''}`}>
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
        {/* Both are the same file picker to the browser; `capture` is what opens the camera directly on iOS/Android. */}
        <input
          ref={camera}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={(e) => {
            uploadFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <input
          ref={library}
          type="file"
          accept="image/*,application/pdf,text/plain,text/markdown,text/csv,audio/*"
          multiple
          hidden
          onChange={(e) => {
            uploadFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <button className="icon-btn attach" onClick={() => camera.current?.click()} aria-label="Take a photo" title="Take a photo">
          <Icon.camera size={20} />
        </button>
        <button className="icon-btn attach" onClick={() => library.current?.click()} aria-label="Attach a file" title="Attach a file">
          <Icon.attach size={19} />
        </button>
        {recorder.supported ? (
          <button
            className={`icon-btn mic ${recording ? 'on' : ''}`}
            onClick={toggleRecord}
            aria-label={recording ? 'Stop recording' : 'Record a voice memo'}
            title={recording ? 'Stop and transcribe' : 'Voice memo'}
            disabled={transcribing}
          >
            {recording ? <Icon.stop size={18} /> : <Icon.mic size={20} />}
          </button>
        ) : (
          SpeechRecognition && (
            <button className={`icon-btn mic ${listening ? 'on' : ''}`} onClick={toggleMic} aria-label={listening ? 'Stop dictation' : 'Dictate'}>
              <Icon.mic size={20} />
            </button>
          )
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
          <button className="icon-btn send" onClick={() => send()} disabled={!canSend || sending} aria-label={bg ? 'Start task' : 'Send'}>
            <Icon.send size={20} />
          </button>
        )}
      </div>
    </div>
  );
});
