import { useState } from 'react';
import type { Task } from '../../../shared/types';
import { api } from '../api';
import { useStore } from '../store';
import { Icon, relLabel } from '../ui';

const STATUS_LABEL: Record<Task['status'], string> = {
  queued: 'Queued',
  running: 'Working',
  waiting: 'Waiting on you',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export function TasksView({ onJump }: { onJump: (itemId: string) => void }) {
  const tasks = useStore((s) => s.tasks);
  const pendingCards = useStore((s) => s.pending);

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

      <TaskSection title="In progress" tasks={[...waiting, ...active]} empty="Nothing running. Ask for something big and I'll track it here." />
      {finished.length > 0 && <TaskSection title="Recently finished" tasks={finished} />}
    </div>
  );
}

function TaskSection({ title, tasks, empty }: { title: string; tasks: Task[]; empty?: string }) {
  return (
    <section>
      <h2 className="section-title">{title}</h2>
      {tasks.length === 0 ? (
        <p className="muted pad">{empty}</p>
      ) : (
        <ul className="list">
          {tasks.map((t) => (
            <TaskRow key={t.id} task={t} />
          ))}
        </ul>
      )}
    </section>
  );
}

function TaskRow({ task }: { task: Task }) {
  const [open, setOpen] = useState(task.status === 'running' || task.status === 'waiting');
  const done = task.steps.filter((s) => s.done).length;
  const live = task.status === 'running' || task.status === 'queued' || task.status === 'waiting';
  return (
    <li className={`task task-${task.status}`}>
      <button className="row" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className={`row-dot ${task.status}`} />
        <span className="row-main">
          <span className="row-title">{task.title}</span>
          <span className="row-sub">
            {task.background ? '' : 'In chat · '}
            {STATUS_LABEL[task.status]}
            {task.steps.length > 0 && ` · ${done}/${task.steps.length}`} · {relLabel(task.updated_at)}
          </span>
        </span>
        <Icon.chevron size={18} className={`chev ${open ? 'open' : ''}`} />
      </button>
      {open && (
        <div className="task-detail">
          {task.progress && <p className="task-progress">{task.progress.replace(/^· /, '')}</p>}
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
          {task.result && <p className="task-result">{task.result}</p>}
          {live && (
            <button className="btn btn-ghost small" onClick={() => api.cancelTask(task.id)}>
              {task.background ? 'Cancel task' : 'Stop'}
            </button>
          )}
        </div>
      )}
    </li>
  );
}
