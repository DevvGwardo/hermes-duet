import { type RefObject, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Item, Task, TrackedFollowUp } from '../../../shared/types';
import { api } from '../api';
import { visibleFiles } from '../edit';
import { isTopDialog, useDialogTrap } from '../hooks/useDialogTrap';
import { STATUS_LABEL } from '../labels';
import { appendOlderTasks, useStore } from '../store';
import { Icon, Markdown, relLabel, timeLabel } from '../ui';
import { FileRow, SourceChips } from './CardView';
import { VoiceHints, VoiceHoldHud, VoiceLockedBar, VoiceRetryCard, handleVoiceShortcut, useVoiceDictation } from './VoiceInput';

export function TasksView({
  onJump,
  onOpenFile,
  openTaskId,
  onOpenTask,
}: {
  onJump: (itemId: string) => void;
  onOpenFile: (id: string) => void;
  openTaskId?: string | null;
  onOpenTask?: (id: string | null) => void;
}) {
  const tasks = useStore((s) => s.tasks);
  const pendingCards = useStore((s) => s.pending);
  const followUps = useStore((s) => s.followUps);
  const hasMoreTasks = useStore((s) => s.hasMoreTasks);
  const [localOpenId, setLocalOpenId] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderErr, setOlderErr] = useState<string | null>(null);
  const openId = onOpenTask ? (openTaskId ?? null) : localOpenId;
  const setOpenId = onOpenTask ?? setLocalOpenId;
  const openTask = tasks.find((t) => t.id === openId) ?? null;

  const active = tasks.filter((t) => t.status === 'running' || t.status === 'queued');
  const waiting = tasks.filter((t) => t.status === 'waiting');
  const finished = tasks.filter((t) => ['done', 'failed', 'cancelled'].includes(t.status));
  const openFollowUps = followUps.filter((f) => f.status === 'open');

  async function loadOlderTasks() {
    if (loadingOlder) return;
    setLoadingOlder(true);
    setOlderErr(null);
    try {
      const oldest = finished.length ? Math.min(...finished.map((t) => t.updated_at)) : Date.now() - 7 * 86400_000;
      const r = await api.olderTasks(oldest);
      appendOlderTasks(r.tasks, r.has_more);
    } catch (e: any) {
      setOlderErr(e?.message ?? 'Could not load older tasks.');
    } finally {
      setLoadingOlder(false);
    }
  }

  return (
    <div className="pane tasks-pane">
      {pendingCards.length > 0 && (
        <section>
          <h2 className="section-title">Needs you</h2>
          <ul className="list">
            {pendingCards.map((c) => (
              <li key={c.id}>
                <button className="row" onClick={() => onJump(c.id)}>
                  <span className="row-dot attention" />
                  <span className="row-main">
                    <span className="row-title">{c.card!.title}</span>
                    <span className="row-sub">{c.card!.type === 'approval' ? 'Approval' : 'Question'} · {relLabel(c.created_at)}</span>
                  </span>
                  <Icon.chevron size={18} />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <FollowUpSection list={openFollowUps} />

      <TaskSection title="In progress" tasks={[...waiting, ...active]} onOpen={setOpenId} empty="Nothing running. Ask for something big and I'll track it here." />
      {(finished.length > 0 || hasMoreTasks) && (
        <section>
          <h2 className="section-title">Recently finished</h2>
          {finished.length > 0 && (
            <ul className="list">
              {finished.map((t) => (
                <TaskRow key={t.id} task={t} onOpen={setOpenId} />
              ))}
            </ul>
          )}
          {olderErr && <p className="card-error pad">{olderErr}</p>}
          {hasMoreTasks && (
            <div className="tasks-older-wrap">
              <button type="button" className="btn btn-ghost small" disabled={loadingOlder} onClick={() => void loadOlderTasks()}>
                {loadingOlder ? 'Loading…' : 'Load older tasks'}
              </button>
            </div>
          )}
        </section>
      )}
      {openTask && <TaskSheet task={openTask} onClose={() => setOpenId(null)} onOpenFile={onOpenFile} />}
    </div>
  );
}

function FollowUpSection({ list }: { list: TrackedFollowUp[] }) {
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [recipient, setRecipient] = useState('');
  const [hours, setHours] = useState('48');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const now = Date.now();

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setBusyId('add');
    setErr(null);
    try {
      await api.createFollowUp({
        title: title.trim(),
        ...(recipient.trim() ? { recipient: recipient.trim() } : {}),
        due_hours: Math.max(1, Number(hours) || 48),
      });
      setTitle('');
      setRecipient('');
      setAdding(false);
    } catch (e: any) {
      setErr(e?.message ?? 'Could not add follow-up.');
    } finally {
      setBusyId(null);
    }
  }

  async function settle(id: string, status: 'resolved' | 'dismissed') {
    setBusyId(id);
    setErr(null);
    try {
      await api.resolveFollowUp(id, status);
    } catch (e: any) {
      setErr(e?.message ?? 'Could not update follow-up.');
    } finally {
      setBusyId(null);
    }
  }

  if (!list.length && !adding) {
    return (
      <section>
        <div className="section-head">
          <h2 className="section-title">Waiting on replies</h2>
          <button type="button" className="link" onClick={() => setAdding(true)}>
            + Track reply
          </button>
        </div>
        <p className="muted pad small">Quiet outbound emails or requests land here so they surface if nobody replies.</p>
      </section>
    );
  }

  return (
    <section>
      <div className="section-head">
        <h2 className="section-title">Waiting on replies</h2>
        <button type="button" className="link" onClick={() => setAdding((v) => !v)}>
          {adding ? 'Cancel' : '+ Track reply'}
        </button>
      </div>
      {err && <p className="card-error pad" role="alert">{err}</p>}
      {adding && (
        <form className="followup-form" onSubmit={add}>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Waiting on reply about…" aria-label="Follow-up title" maxLength={160} />
          <div className="followup-form-row">
            <input value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="Who (optional)" aria-label="Recipient" maxLength={140} />
            <input type="number" min={1} max={2160} value={hours} onChange={(e) => setHours(e.target.value)} aria-label="Due hours" title="Hours until overdue" />
            <button type="submit" className="btn btn-primary small" disabled={busyId === 'add' || !title.trim()}>
              {busyId === 'add' ? 'Saving…' : 'Track'}
            </button>
          </div>
        </form>
      )}
      <ul className="list">
        {list.map((f) => {
          const overdue = f.due_at <= now;
          const diffH = Math.max(1, Math.round(Math.abs(f.due_at - now) / 3600_000));
          const when = overdue ? `Overdue · ${diffH}h` : diffH >= 48 ? `Due in ${Math.round(diffH / 24)}d` : `Due in ${diffH}h`;
          return (
            <li key={f.id} className={`followup-row ${overdue ? 'is-overdue' : ''}`}>
              <div className="row followup-item">
                <span className={`row-dot ${overdue ? 'attention' : 'waiting'}`} />
                <span className="row-main">
                  <span className="row-title">{f.title}</span>
                  <span className="row-sub">
                    {f.recipient ? `Waiting on ${f.recipient} · ` : ''}
                    {f.destination ? `${f.destination} · ` : ''}
                    {when}
                  </span>
                </span>
                <span className="followup-actions">
                  <button type="button" className="btn btn-ghost small" disabled={busyId === f.id} onClick={() => void settle(f.id, 'resolved')}>
                    Replied
                  </button>
                  <button type="button" className="icon-btn" disabled={busyId === f.id} onClick={() => void settle(f.id, 'dismissed')} aria-label={`Dismiss ${f.title}`} title="Dismiss">
                    <Icon.close size={15} />
                  </button>
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function TaskSection({ title, tasks, empty, onOpen }: { title: string; tasks: Task[]; empty?: string; onOpen: (id: string) => void }) {
  return (
    <section>
      <h2 className="section-title">{title}</h2>
      {tasks.length === 0 ? (
        <p className="muted pad">{empty}</p>
      ) : (
        <ul className="list">
          {tasks.map((t) => (
            <TaskRow key={t.id} task={t} onOpen={onOpen} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** One row in the list. Tapping opens the task's detail sheet; the row itself only summarizes. */
function TaskRow({ task, onOpen }: { task: Task; onOpen: (id: string) => void }) {
  const done = task.steps.filter((s) => s.done).length;
  return (
    <li className={`task task-${task.status}`}>
      <button className="row" onClick={() => onOpen(task.id)}>
        <span className={`row-dot ${task.status}`} />
        <span className="row-main">
          <span className="row-title">{task.title}</span>
          <span className="row-sub">
            {task.background ? '' : 'In chat · '}
            {confirmLabel(task)}
            {task.steps.length > 0 && ` · ${done}/${task.steps.length}`} · {relLabel(task.updated_at)}
          </span>
        </span>
        <Icon.chevron size={18} />
      </button>
    </li>
  );
}

/** The one line a row shows about completion: user-confirmed, looks-done, or the plain status. */
function confirmLabel(task: Task): string {
  if (task.confirmed_at) return 'Confirmed by you';
  if (task.status === 'done') return 'Looks done — confirm';
  return STATUS_LABEL[task.status];
}

/**
 * A task's detail sheet: title, status, steps with done state, result, sources, the files it delivered, follow-ups,
 * and a composer that steers it while it runs. Sheet, not inline expansion, so a long result stays readable on a phone.
 */
function TaskSheet({ task, onClose, onOpenFile }: { task: Task; onClose: () => void; onOpenFile: (id: string) => void }) {
  const dialog = useRef<HTMLDivElement | null>(null);
  useDialogTrap(dialog, () => {
    if (dialog.current?.querySelector('.task-composer-row.listening')) return false;
    onClose();
  });
  const files = useStore((s) => s.files);
  const channels = useStore((s) => s.channels);
  const storeHandover = useStore((s) => s.items.find((i) => i.id === task.handover_id));
  const [fetchedHandover, setFetchedHandover] = useState<Item | null>(null);
  const [handoverErr, setHandoverErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sent, setSent] = useState<Record<number, boolean>>({});

  useEffect(() => {
    setSent({});
    setErr(null);
    setBusy(null);
  }, [task.id]);

  useEffect(() => {
    setFetchedHandover(null);
    setHandoverErr(null);
    if (storeHandover || !task.handover_id) return;
    let live = true;
    api
      .item(task.handover_id)
      .then(
        (r) => live && setFetchedHandover(r.item),
        (e: any) => live && setHandoverErr(e?.message ?? 'Could not load handover card.'),
      );
    return () => {
      live = false;
    };
  }, [task.handover_id, !!storeHandover]);
  const handover = storeHandover ?? (fetchedHandover?.id === task.handover_id ? fetchedHandover : undefined);
  const own = visibleFiles(files.filter((f) => f.task_id === task.id));

  const done = task.steps.filter((s) => s.done).length;
  const live = task.status === 'running' || task.status === 'waiting';
  const confirmed = !!task.confirmed_at;
  const canRetry =
    task.status === 'failed' &&
    !!task.handover_id &&
    (handover ? !!handover.card?.retry && !handover.card?.decision : !!task.instructions);

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    setErr(null);
    try {
      await fn();
    } catch (e: any) {
      setErr(e?.message ?? 'That did not go through.');
    } finally {
      setBusy(null);
    }
  }

  async function retryTask() {
    if (!task.handover_id) return;
    await run('retry', async () => {
      const res = await api.act(task.handover_id!, 'retry');
      if (res?.item) setFetchedHandover(res.item);
    });
  }

  async function followUp(i: number) {
    if (!task.handover_id || sent[i] || !!busy) return;
    setSent((s) => ({ ...s, [i]: true }));
    setErr(null);
    try {
      const res = await api.act(task.handover_id, 'follow_up', String(i));
      if (res?.item) setFetchedHandover(res.item);
    } catch (e: any) {
      setSent((s) => ({ ...s, [i]: false }));
      setErr(e?.message ?? 'That did not go through.');
    }
  }

  const sheet = (
    <div className="sheet-backdrop task-sheet-backdrop" onClick={onClose}>
      <div className="sheet task-sheet" role="dialog" aria-modal="true" aria-label={task.title} ref={dialog} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Back to tasks">
            <Icon.close size={18} />
          </button>
          <div className="sheet-title">
            <strong>{task.title}</strong>
            <span className="muted">
              {task.background ? '' : 'In chat · '}
              {confirmLabel(task)}
              {task.steps.length > 0 && ` · ${done}/${task.steps.length}`} · {relLabel(task.updated_at)}
            </span>
          </div>
        </div>

        <div className="sheet-body task-sheet-body">
          {task.progress && <p className="task-progress">{task.progress.replace(/^· /, '')}</p>}

          {task.status === 'done' && !confirmed && (
            <div className="task-confirm">
              <span>Looks done — confirm</span>
              <button className="btn btn-primary small" disabled={!!busy} onClick={() => run('confirm', () => api.confirmTask(task.id))}>
                {busy === 'confirm' ? 'Marking…' : 'Mark done'}
              </button>
            </div>
          )}
          {confirmed && (
            <div className="task-confirm is-confirmed">
              <span>
                <Icon.check size={16} /> Confirmed by you{task.confirmed_at ? ` · ${timeLabel(task.confirmed_at)}` : ''}
              </span>
              <button className="link" disabled={!!busy} onClick={() => run('reopen', () => api.reopenTask(task.id))}>
                Undo
              </button>
            </div>
          )}

          {channels.length > 1 && (
            <label className="setting-row task-channel-row">
              <span>Channel</span>
              <select
                aria-label="Task channel"
                disabled={!!busy}
                value={task.channel_id ?? channels[0]?.id ?? ''}
                onChange={(e) => void run('channel', () => api.moveTaskChannel(task.id, e.target.value))}
              >
                {channels.map((c) => (
                  <option key={c.id} value={c.id}>
                    #{c.slug}
                  </option>
                ))}
              </select>
            </label>
          )}

          {task.steps.length > 0 && (
            <ul className="task-steps">
              {task.steps.map((s, i) => (
                <li key={i} className={s.done ? 'done' : ''}>
                  <span className="tick">{s.done ? <Icon.check size={13} /> : null}</span>
                  {s.text}
                </li>
              ))}
            </ul>
          )}

          {task.result && <Markdown text={task.result} className="task-result" />}

          {task.sources?.length ? (
            <section aria-label="Sources">
              <h3 className="section-title">Sources</h3>
              <SourceChips sources={task.sources} onOpenFile={onOpenFile} />
            </section>
          ) : null}

          {own.map((f) => (
            <FileRow key={f.id} fileId={f.id} onOpen={onOpenFile} />
          ))}

          {task.follow_ups?.length && task.handover_id ? (
            <div className="follow-ups">
              {task.follow_ups.map((f, i) => {
                const used = sent[i] || handover?.card?.follow_ups?.[i]?.used || f.used;
                return (
                  <button key={i} className="chip" disabled={!!busy || used} onClick={() => followUp(i)}>
                    {used ? 'On it' : f.label}
                  </button>
                );
              })}
            </div>
          ) : null}

          <div className="task-actions">
            {live && (
              <button className="btn btn-ghost small" disabled={!!busy} onClick={() => run('cancel', () => api.cancelTask(task.id))}>
                {busy === 'cancel' ? 'Stopping…' : task.background ? 'Cancel task' : 'Stop'}
              </button>
            )}
            {canRetry && (
              <button className="btn btn-ghost small" disabled={!!busy} onClick={retryTask}>
                {busy === 'retry' ? 'Starting…' : 'Try again'}
              </button>
            )}
          </div>
          {task.status === 'failed' && handover?.card?.decision && (
            <p className="muted small">
              {handover.card.decision}
              {handover.card.decided_at ? ` · ${timeLabel(handover.card.decided_at)}` : ''}
            </p>
          )}
          {handoverErr && !handover && !canRetry && task.status === 'failed' && (
            <p className="muted small">{handoverErr}</p>
          )}
          {err && (
            <p className="card-error" role="alert">
              {err}
            </p>
          )}
        </div>

        {live ? (
          <TaskComposer taskId={task.id} dialogRef={dialog} />
        ) : task.status === 'queued' ? (
          <p className="task-composer-hint">Starts soon — steering opens once it runs.</p>
        ) : null}
      </div>
    </div>
  );
  return typeof document !== 'undefined' ? createPortal(sheet, document.body) : sheet;
}

/** Steer the task while it runs. The server refuses with a 409 when there is no live run, and that refusal is shown. */
function TaskComposer({ taskId, dialogRef }: { taskId: string; dialogRef: RefObject<HTMLDivElement | null> }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);

  const voice = useVoiceDictation({
    text,
    setText,
    textareaRef: ta,
    disabled: busy,
    allowAttachmentFallback: false,
  });

  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTopDialog(dialogRef.current)) handleVoiceShortcut(e, voiceRef.current, busyRef.current);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [dialogRef]);

  async function send() {
    const t = text.trim();
    if (!t || busy || voice.isActive || voice.isTranscribing) return;
    setBusy(true);
    setErr(null);
    setNote(null);
    try {
      const r = await api.messageTask(taskId, t);
      setText('');
      setNote(r.delivered ? 'Sent to the running task.' : 'The run was between steps — it picks this up next.');
    } catch (e: any) {
      setErr(e?.message ?? 'That did not go through.');
    } finally {
      setBusy(false);
    }
  }

  const lockedBarOpen = voice.mode === 'locked' || voice.mode === 'listening';

  return (
    <div className="task-composer">
      {note && <p className="composer-hint">{note}</p>}
      <VoiceHints
        isTranscribing={voice.isTranscribing}
        notice={voice.notice}
        error={err || voice.error}
        statusMessage={voice.statusMessage}
      />
      {voice.failedTake && (
        <VoiceRetryCard
          take={voice.failedTake}
          onRetry={() => void voice.retryFailed()}
          onDiscard={voice.discardFailed}
        />
      )}
      <div className="composer-anchor">
        {voice.mode === 'holding' && (
          <VoiceHoldHud seconds={voice.seconds} analyser={voice.analyser} holdFeedback={voice.holdFeedback} />
        )}
        <div className={`task-composer-row ${voice.isActive ? 'listening' : ''} ${lockedBarOpen ? 'is-locked' : ''}`}>
          <textarea
            ref={ta}
            aria-label="Steer this task"
            placeholder="Steer it mid-run…"
            value={text}
            rows={1}
            tabIndex={lockedBarOpen ? -1 : undefined}
            aria-hidden={lockedBarOpen || undefined}
            onChange={(e) => setText(e.target.value)}
            onSelect={voice.snapshotSelection}
            onKeyUp={voice.snapshotSelection}
            onBlur={voice.snapshotSelection}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !(e.nativeEvent as any).isComposing) {
                e.preventDefault();
                if (voice.isActive) {
                  void voice.confirm();
                } else {
                  void send();
                }
              }
            }}
          />
          {voice.voiceVisible && (
            <button
              {...voice.micButtonProps}
              tabIndex={lockedBarOpen ? -1 : undefined}
              aria-hidden={lockedBarOpen || undefined}
              className={`icon-btn mic mic-btn ${voice.isActive ? 'on' : ''}`}
              title={voice.isActive ? 'Stop and transcribe (⌘⇧M / Ctrl+Shift+M)' : 'Dictate steering message'}
            >
              {voice.isActive ? <Icon.stop size={18} /> : <Icon.mic size={19} />}
            </button>
          )}
          <button
            type="button"
            className="btn btn-primary small"
            tabIndex={lockedBarOpen ? -1 : undefined}
            aria-hidden={lockedBarOpen || undefined}
            disabled={busy || !text.trim() || voice.isActive || voice.isTranscribing}
            onClick={() => void send()}
          >
            {busy ? 'Sending…' : 'Send'}
          </button>
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
}
