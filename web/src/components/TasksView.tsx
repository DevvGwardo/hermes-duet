import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Item, Task } from '../../../shared/types';
import { api } from '../api';
import { visibleFiles } from '../edit';
import { isTopDialog, useDialogTrap } from '../hooks/useDialogTrap';
import { STATUS_LABEL } from '../labels';
import { useStore } from '../store';
import { Icon, Markdown, relLabel, timeLabel } from '../ui';
import { FileRow, SourceChips } from './CardView';

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
  const [localOpenId, setLocalOpenId] = useState<string | null>(null);
  const openId = onOpenTask ? (openTaskId ?? null) : localOpenId;
  const setOpenId = onOpenTask ?? setLocalOpenId;
  const openTask = tasks.find((t) => t.id === openId) ?? null;

  const active = tasks.filter((t) => t.status === 'running' || t.status === 'queued');
  const waiting = tasks.filter((t) => t.status === 'waiting');
  const finished = tasks.filter((t) => ['done', 'failed', 'cancelled'].includes(t.status)).slice(0, 30);

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

      <TaskSection title="In progress" tasks={[...waiting, ...active]} onOpen={setOpenId} empty="Nothing running. Ask for something big and I'll track it here." />
      {finished.length > 0 && <TaskSection title="Recently finished" tasks={finished} onOpen={setOpenId} />}
      {openTask && <TaskSheet task={openTask} onClose={() => setOpenId(null)} onOpenFile={onOpenFile} />}
    </div>
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
  useDialogTrap(dialog);
  const files = useStore((s) => s.files);
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !isTopDialog(dialog.current)) return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

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
          <button className="icon-btn" onClick={onClose} aria-label="Back to tasks">
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
          <TaskComposer taskId={task.id} />
        ) : task.status === 'queued' ? (
          <p className="task-composer-hint">Starts soon — steering opens once it runs.</p>
        ) : null}
      </div>
    </div>
  );
  return typeof document !== 'undefined' ? createPortal(sheet, document.body) : sheet;
}

/** Steer the task while it runs. The server refuses with a 409 when there is no live run, and that refusal is shown. */
function TaskComposer({ taskId }: { taskId: string }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function send() {
    const t = text.trim();
    if (!t || busy) return;
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

  return (
    <div className="task-composer">
      {note && <p className="composer-hint">{note}</p>}
      {err && (
        <p className="composer-hint error" role="alert">
          {err}
        </p>
      )}
      <div className="task-composer-row">
        <textarea
          aria-label="Steer this task"
          placeholder="Steer it mid-run…"
          value={text}
          rows={1}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !(e.nativeEvent as any).isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button className="btn btn-primary small" disabled={busy || !text.trim()} onClick={() => void send()}>
          {busy ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  );
}
