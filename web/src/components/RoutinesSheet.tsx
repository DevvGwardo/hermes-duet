import { useEffect, useRef, useState } from 'react';
import type { Routine, RoutineSchedule } from '../../../shared/types';
import { scheduleLabel } from '../../../server/routines';
import { api } from '../api';
import { useStore } from '../store';
import { isTopDialog, useDialogTrap } from '../hooks/useDialogTrap';
import { Icon } from '../ui';

const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

function nextLabel(at: number | undefined, tz: string): string {
  if (!at) return 'not scheduled';
  return new Date(at).toLocaleString('en-US', {
    timeZone: tz,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * User-defined recurring routines: what runs, when it runs next, and the form that creates or edits one. Each run is
 * a background task, so the instructions are the whole job — there is no conversation to lean on.
 */
export function RoutinesSheet({ onClose }: { onClose: () => void }) {
  const routines = useStore((s) => s.routines);
  const channels = useStore((s) => s.channels);
  const timezone = useStore((s) => s.settings?.timezone) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const dialog = useRef<HTMLDivElement | null>(null);
  useDialogTrap(dialog);

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

  const [editing, setEditing] = useState<Routine | null>(null);
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [kind, setKind] = useState<RoutineSchedule['kind']>('daily');
  const [time, setTime] = useState('09:00');
  const [weekdays, setWeekdays] = useState<number[]>([1]);
  const [every, setEvery] = useState(360);
  const [channelId, setChannelId] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const generalId = channels.find((c) => c.slug === 'general')?.id ?? channels[0]?.id;

  useEffect(() => {
    if (editing && !routines.some((r) => r.id === editing.id)) {
      resetForm();
    }
  }, [routines, editing]);

  function startEdit(r: Routine) {
    setEditing(r);
    setTitle(r.title);
    setPrompt(r.prompt);
    setKind(r.schedule.kind);
    setTime(r.schedule.kind === 'interval' ? '09:00' : r.schedule.time);
    setWeekdays(r.schedule.kind === 'weekly' ? [...r.schedule.weekdays] : [1]);
    setEvery(r.schedule.kind === 'interval' ? r.schedule.every_minutes : 360);
    setChannelId(r.channel_id && r.channel_id !== generalId ? r.channel_id : '');
    setErr(null);
  }

  function resetForm() {
    setEditing(null);
    setTitle('');
    setPrompt('');
    setKind('daily');
    setTime('09:00');
    setWeekdays([1]);
    setEvery(360);
    setChannelId('');
    setErr(null);
  }

  const missingWeekdays = kind === 'weekly' && weekdays.length === 0;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (missingWeekdays) {
      setErr('Pick at least one weekday.');
      return;
    }
    setBusy(true);
    setErr(null);
    const schedule: RoutineSchedule =
      kind === 'daily' ? { kind, time } : kind === 'weekly' ? { kind, time, weekdays } : { kind, every_minutes: every };
    try {
      await api.saveRoutine({
        ...(editing ? { routine_id: editing.id } : {}),
        title,
        prompt,
        schedule,
        channel_id: channelId,
      });
      resetForm();
    } catch (e: any) {
      setErr(e?.message ?? 'Could not save that routine.');
    } finally {
      setBusy(false);
    }
  }

  async function runNow(id: string) {
    setBusy(true);
    setErr(null);
    try {
      await api.runRoutine(id);
    } catch (e: any) {
      setErr(e?.message ?? 'Could not run that routine.');
    } finally {
      setBusy(false);
    }
  }

  async function toggle(r: Routine) {
    setBusy(true);
    setErr(null);
    try {
      await (r.enabled ? api.pauseRoutine(r.id) : api.resumeRoutine(r.id));
    } catch (e: any) {
      setErr(e?.message ?? 'Could not change that routine.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    setErr(null);
    try {
      await api.removeRoutine(id);
      if (editing?.id === id) resetForm();
    } catch (e: any) {
      setErr(e?.message ?? 'Could not remove that routine.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        ref={dialog}
        className="sheet routines-sheet"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Routines"
      >
        <header className="sheet-head">
          <div className="sheet-title">
            <strong>Routines</strong>
            <span className="muted">Background tasks on a schedule</span>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon.close size={20} />
          </button>
        </header>
        <div className="settings-body">
          <section>
            <h3>Scheduled</h3>
            {routines.length === 0 && (
              <p className="muted small">No routines yet. Add one below — “every Monday at 9, summarize last week’s messages.”</p>
            )}
            <ul className="list">
              {routines.map((r) => (
                <li key={r.id} className="routine-row">
                  <div className="routine-main">
                    <span className="row-title">{r.title}</span>
                    <span className="row-sub">
                      {scheduleLabel(r.schedule)} · {r.enabled ? `Next ${nextLabel(r.next_run, timezone)}` : 'Paused'}
                    </span>
                    {r.last_result && <span className="row-sub">Last: {r.last_result}</span>}
                  </div>
                  <div className="routine-actions">
                    <button className="btn btn-ghost small" disabled={busy} onClick={() => runNow(r.id)}>
                      Run now
                    </button>
                    <button className="btn btn-ghost small" disabled={busy} onClick={() => toggle(r)}>
                      {r.enabled ? 'Pause' : 'Resume'}
                    </button>
                    <button className="icon-btn" disabled={busy} onClick={() => startEdit(r)} aria-label={`Edit ${r.title}`} title="Edit routine">
                      <Icon.pencil size={16} />
                    </button>
                    <button className="icon-btn" disabled={busy} onClick={() => remove(r.id)} aria-label={`Delete ${r.title}`} title="Delete routine">
                      <Icon.archive size={16} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h3>{editing ? 'Edit routine' : 'New routine'}</h3>
            <form className="routine-form" onSubmit={submit}>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Title, e.g. Weekly inbox summary"
                aria-label="Routine title"
                maxLength={120}
              />
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="What to do each run. It starts a background task with a fresh session, so make it self-contained."
                aria-label="Routine instructions"
                maxLength={6000}
                rows={4}
              />
              <div className="segmented" role="radiogroup" aria-label="Schedule">
                {(['daily', 'weekly', 'interval'] as const).map((k) => (
                  <button
                    type="button"
                    key={k}
                    role="radio"
                    aria-checked={kind === k}
                    className={kind === k ? 'on' : ''}
                    onClick={() => setKind(k)}
                  >
                    {k === 'daily' ? 'Daily' : k === 'weekly' ? 'Weekly' : 'Interval'}
                  </button>
                ))}
              </div>
              {kind !== 'interval' && (
                <label className="routine-field">
                  <span>At</span>
                  <input type="time" value={time} onChange={(e) => setTime(e.target.value)} aria-label="Time of day" />
                </label>
              )}
              {kind === 'weekly' && (
                <>
                  <div className="day-row" role="group" aria-label="Weekdays">
                    {DAY_LABELS.map((label, i) => (
                      <button
                        type="button"
                        key={i}
                        className={`day-chip ${weekdays.includes(i) ? 'on' : ''}`}
                        aria-pressed={weekdays.includes(i)}
                        aria-label={['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][i]}
                        onClick={() => setWeekdays((d) => (d.includes(i) ? d.filter((x) => x !== i) : [...d, i].sort((a, b) => a - b)))}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  {missingWeekdays && <p className="card-error">Pick at least one weekday.</p>}
                </>
              )}
              {kind === 'interval' && (
                <label className="routine-field">
                  <span>Every (minutes)</span>
                  <input
                    type="number"
                    min={15}
                    max={10080}
                    step={1}
                    value={every}
                    onChange={(e) => setEvery(Number(e.target.value))}
                    aria-label="Minutes between runs"
                  />
                </label>
              )}
              <label className="routine-field">
                <span>Channel</span>
                <select value={channelId} onChange={(e) => setChannelId(e.target.value)} aria-label="Channel">
                  <option value="">General</option>
                  {channels
                    .filter((c) => c.slug !== 'general')
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  {channelId && !channels.some((c) => c.id === channelId) && (
                    <option value={channelId}>(archived channel)</option>
                  )}
                </select>
              </label>
              {err && (
                <p className="card-error" role="alert">
                  {err}
                </p>
              )}
              <span className="routine-form-btns">
                <button className="btn btn-primary small" disabled={busy || missingWeekdays} type="submit">
                  {busy ? 'Saving…' : editing ? 'Save changes' : 'Add routine'}
                </button>
                {editing && (
                  <button className="btn small" type="button" disabled={busy} onClick={resetForm}>
                    Cancel
                  </button>
                )}
              </span>
            </form>
          </section>
        </div>
      </div>
    </div>
  );
}
