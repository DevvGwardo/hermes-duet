import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { Attachment } from '../../../shared/types';
import { api } from '../api';
import { useStore } from '../store';
import { Icon } from '../ui';
import { Attachments } from './Attachments';
import { VoiceHints, VoiceHoldHud, VoiceLockedBar, VoiceRetryCard, useVoiceDictation } from './VoiceInput';

export interface ComposerHandle {
  prefill: (text: string) => void;
  focus: () => void;
}

export const Composer = forwardRef<ComposerHandle, { onSent?: () => void; hidden?: boolean }>(function Composer({ onSent, hidden = false }, ref) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // "Run in background": the next send starts its own task instead of going to the chat, so it runs alongside.
  const [bg, setBg] = useState(false);
  const [files, setFiles] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(0);
  const busy = useStore((s) => s.agent.busy);
  const queued = useStore((s) => s.agent.queued);
  const hermesDown = useStore((s) => s.agent.hermes === 'down');
  const ta = useRef<HTMLTextAreaElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const library = useRef<HTMLInputElement>(null);
  const filesLenRef = useRef(0);
  filesLenRef.current = files.length;
  const uploadingRef = useRef(0);

  const voice = useVoiceDictation({
    text,
    setText,
    textareaRef: ta,
    disabled: sending,
    hidden,
    allowAttachmentFallback: true,
    canAttachMore: () => filesLenRef.current + uploadingRef.current < 6,
    onAttach: (attachment) => {
      filesLenRef.current += 1;
      setFiles((f) => [...f, attachment]);
    },
  });

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

  useEffect(() => {
    if (hidden) return;
    const onKey = (e: KeyboardEvent) => {
      const dialogOpen = !!document.querySelector('.sheet, .browser-pane');
      if (dialogOpen) return;

      if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'm') {
        if (!voice.voiceVisible || sending || voice.isTranscribing) return;
        e.preventDefault();
        voice.toggle();
        return;
      }

      if (e.key === 'Escape' && voice.isActive) {
        e.preventDefault();
        e.stopPropagation();
        voice.cancel();
        return;
      }

      if (
        e.key === 'Enter' &&
        !e.shiftKey &&
        !e.isComposing &&
        (voice.mode === 'locked' || voice.mode === 'listening')
      ) {
        const target = e.target as HTMLElement | null;
        if (target?.closest?.('button')) return;
        e.preventDefault();
        void voice.confirm();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hidden, sending, voice]);

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

  async function send(background = bg) {
    const t = text.trim();
    if ((!t && !files.length) || sending || uploading > 0 || voice.isActive || voice.isTranscribing) return;
    setSending(true);
    setErr(null);
    onSent?.();
    const attached = files;
    const ids = attached.map((f) => f.id);
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
      setFiles((cur) => (cur.length ? cur : attached));
      setBg(background);
      setErr(e.message ?? 'Could not send');
    } finally {
      setSending(false);
    }
  }

  const lockedBarOpen = voice.mode === 'locked' || voice.mode === 'listening';
  const showStop = busy && !text.trim() && !files.length && !voice.isActive;
  const canSend = (!!text.trim() || files.length > 0) && uploading === 0 && !voice.isActive && !voice.isTranscribing;

  return (
    <div className="composer-wrap" hidden={hidden}>
      {queued > 0 && (
        <div className="composer-hint">
          Queued {queued} message{queued > 1 ? 's' : ''}. {hermesDown ? "Hermes is offline; they go out as soon as it's back." : "I'll pick it up when this step finishes."}
        </div>
      )}
      <VoiceHints
        isTranscribing={voice.isTranscribing}
        notice={voice.notice}
        error={err || voice.error}
        statusMessage={voice.statusMessage}
      />
      {voice.failedTake && (
        <VoiceRetryCard
          take={voice.failedTake}
          allowAttach
          canAttach={files.length + uploading < 6}
          onRetry={() => void voice.retryFailed()}
          onAttach={() => void voice.attachFailed()}
          onDiscard={voice.discardFailed}
        />
      )}
      {files.length > 0 && (
        <Attachments
          list={files}
          onRemove={(id) => {
            setFiles((f) => f.filter((a) => a.id !== id));
            void api.deleteUpload(id).catch(() => {});
          }}
        />
      )}
      {uploading > 0 && <div className="composer-hint">Uploading {uploading} file{uploading > 1 ? 's' : ''}…</div>}
      {bg ? (
        <div className="composer-hint bg">Runs as its own task, alongside the chat. Follow it in Tasks.</div>
      ) : (
        busy &&
        text.trim() && (
          <div className="composer-hint">
            This goes into the current turn.
            <button type="button" className="hint-action" onMouseDown={(e) => e.preventDefault()} onClick={() => send(true)} disabled={sending || voice.isActive}>
              Run separately
            </button>
          </div>
        )
      )}
      <div className="composer-anchor">
        {voice.mode === 'holding' && (
          <VoiceHoldHud seconds={voice.seconds} analyser={voice.analyser} holdFeedback={voice.holdFeedback} />
        )}
        <div className={`composer ${voice.isActive ? 'listening' : ''} ${lockedBarOpen ? 'is-locked' : ''} ${bg ? 'bg' : ''}`}>
          <textarea
            ref={ta}
            rows={1}
            value={text}
            tabIndex={lockedBarOpen ? -1 : undefined}
            aria-hidden={lockedBarOpen || undefined}
            placeholder={bg ? 'Run in the background…' : busy ? 'Steer, or add something…' : 'Message Hermes Duet'}
            onChange={(e) => setText(e.target.value)}
            onSelect={voice.snapshotSelection}
            onKeyUp={voice.snapshotSelection}
            onBlur={voice.snapshotSelection}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !(e.nativeEvent as any).isComposing) {
                if (voice.isActive) {
                  e.preventDefault();
                  void voice.confirm();
                  return;
                }
                if (window.matchMedia('(pointer: fine)').matches) {
                  e.preventDefault();
                  void send(bg || e.metaKey || e.ctrlKey);
                }
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
              void uploadFiles(e.target.files);
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
              void uploadFiles(e.target.files);
              e.target.value = '';
            }}
          />
          <button
            type="button"
            className="icon-btn attach"
            tabIndex={lockedBarOpen ? -1 : undefined}
            aria-hidden={lockedBarOpen || undefined}
            onClick={() => camera.current?.click()}
            aria-label="Take a photo"
            title="Take a photo"
          >
            <Icon.camera size={20} />
          </button>
          <button
            type="button"
            className="icon-btn attach"
            tabIndex={lockedBarOpen ? -1 : undefined}
            aria-hidden={lockedBarOpen || undefined}
            onClick={() => library.current?.click()}
            aria-label="Attach a file"
            title="Attach a file"
          >
            <Icon.attach size={19} />
          </button>
          {voice.voiceVisible && (
            <button
              {...voice.micButtonProps}
              tabIndex={lockedBarOpen ? -1 : undefined}
              aria-hidden={lockedBarOpen || undefined}
              className={`icon-btn mic mic-btn ${voice.isActive ? 'on' : ''}`}
              title={voice.isActive ? 'Stop and transcribe (⌘⇧M / Ctrl+Shift+M)' : 'Voice memo — tap to toggle, hold to talk (⌘⇧M / Ctrl+Shift+M)'}
            >
              {voice.isActive ? <Icon.stop size={18} /> : <Icon.mic size={20} />}
            </button>
          )}
          <button
            type="button"
            className={`icon-btn bg-toggle ${bg ? 'on' : ''}`}
            tabIndex={lockedBarOpen ? -1 : undefined}
            aria-hidden={lockedBarOpen || undefined}
            onMouseDown={(e) => e.preventDefault() /* keep the keyboard up */}
            onClick={() => setBg((b) => !b)}
            aria-pressed={bg}
            aria-label="Run in background"
            title="Run in background (⌘↵ / Ctrl+↵)"
          >
            <Icon.tasks size={19} />
          </button>
          {showStop && !bg ? (
            <button
              type="button"
              className="icon-btn send stop"
              tabIndex={lockedBarOpen ? -1 : undefined}
              aria-hidden={lockedBarOpen || undefined}
              onClick={() => api.stop()}
              aria-label="Stop"
            >
              <Icon.stop size={18} />
            </button>
          ) : (
            <button
              type="button"
              className="icon-btn send"
              tabIndex={lockedBarOpen ? -1 : undefined}
              aria-hidden={lockedBarOpen || undefined}
              onClick={() => void send()}
              disabled={!canSend || sending}
              aria-label={bg ? 'Start task' : 'Send'}
            >
              <Icon.send size={20} />
            </button>
          )}
          {lockedBarOpen && (
            <VoiceLockedBar
              mode={voice.mode}
              seconds={voice.seconds}
              analyser={voice.analyser}
              interimText={voice.interimText}
              onCancel={voice.cancel}
              onConfirm={() => void voice.confirm()}
            />
          )}
        </div>
      </div>
    </div>
  );
});
