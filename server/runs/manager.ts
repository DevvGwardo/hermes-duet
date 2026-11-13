import type { AgentState, Attachment, CardData, Item, Page, Routine, Task } from '../../shared/types';
import { approvalPush, turnNote } from '../approval';
import { BRIEF_RETRY, SKIP_MEMORY_DAYS, briefFailure, checkinOutcome, morningOutcome, raisedToday, skippedLately } from '../brief';
import { broadcast } from '../bus';
import { channelLine } from '../channels';
import { localParts } from '../clock';
import { config } from '../config';
import { channels, files, followUps, items, kv, newId, pages, routines, runs, settings, tasks } from '../db';
import { UserError } from '../errors';
import { sleep } from '../exec';
import { HermesError, type RunEvent, hermes } from '../hermes';
import { afterInterruption, briefWait, pageBriefLine, refreshToCancel } from '../pages';
import { briefPrompt, checkinPrompt, pageRefreshInstructions, persona, taskPrompt } from '../prompts';
import { MOVED_ON, RESUME_OPTIONS, RETRY_OPTIONS, TIMED_OUT, failedTurnBody, movedOn, resumeCardBody, retryTitle, runHung } from '../recovery';
import { nextRun, routineInput } from '../routines';
import { GENERAL_CHANNEL } from '../schema';
import { type Steer, undeliveredSteers } from '../steer';
import { withAgentDone } from '../taskstatus';
import { closeSegment, deliverMedia, stripMedia } from '../tools/deliver';
import { userTaskInstructions, userTaskTitle } from '../usertask';
import {
  type ActiveRun,
  FG_AFTER_MS,
  INTERRUPTED,
  type Lane,
  type RunKind,
  type RunSpec,
  TASK_MESSAGE_MAX,
  WATCHDOG_MS,
  addContextNote,
  backgroundActive,
  briefDedupeAllowed,
  broadcastAgent,
  cardUrl,
  channelOfSpec,
  consumeContextNotes,
  dropIdleLane,
  expireBriefRetries,
  expireDeadPrompts,
  failTask,
  firstLine,
  formatContextNotes,
  handOver,
  lane,
  lanes,
  liveChannel,
  mainLane,
  mainSessionId,
  markTaskWaiting,
  newItem,
  pageRefreshing,
  persistQueues,
  pushSafe,
  put,
  putPage,
  putRoutine,
  putTask,
  runMeta,
  runtime,
  saveRunMeta,
  segmentsOf,
  syncRoutineResult,
  systemNote,
} from './state';

// ---------------------------------------------------------------------------
// Queueing, launching & pumping lanes
// ---------------------------------------------------------------------------

export function enqueue(spec: RunSpec) {
  const l = lane(spec.sessionId);
  l.queue.push(spec);
  persistQueues();
  pumpAll();
  broadcastAgent();
}

/** Whether a scheduled brief should stay queued for now; arms one timer to pump again when its wait runs out. */
function briefHeld(): boolean {
  const wait = briefWait(pages.all().some(pageRefreshing), runtime.hermesBackAt, Date.now());
  if (wait && !runtime.briefTimer) {
    runtime.briefTimer = setTimeout(() => {
      runtime.briefTimer = null;
      pumpAll();
    }, wait);
  }
  return wait > 0;
}

export function pumpAll() {
  // While Hermes is unreachable, keep everything queued; the health watch pumps again when it's back.
  if (runtime.hermesStatus === 'down') return;
  // Main lane first so the user's thread never waits behind background work. That order would start a brief queued
  // during an outage before the page refreshes queued ahead of it, so a held brief keeps its place while chat behind
  // it goes first; a finished refresh pumps again through finish().
  let held: boolean | undefined;
  const waits = (s: RunSpec) => s.kind === 'brief' && !!s.scheduled && (held ??= briefHeld());
  const order = [...lanes.values()].sort((a, b) => Number(b.main) - Number(a.main));
  for (const l of order) {
    if (l.active || !l.queue.length) continue;
    const i = l.queue.findIndex((s) => !waits(s));
    if (i < 0) continue;
    const next = l.queue[i];
    if (next.kind === 'task' && backgroundActive() >= config.maxBackground) continue;
    l.queue.splice(i, 1);
    persistQueues();
    launch(l, next);
  }
}

async function launch(l: Lane, spec: RunSpec) {
  const run: ActiveRun = {
    id: '',
    spec,
    startedAt: Date.now(),
    activity: null,
    assistant: null,
    text: '',
    segText: '',
    lastText: '',
    pendingWs: '',
    steps: [],
    lastSeq: 0,
    cards: 0,
    briefs: 0,
    finished: false,
    abort: new AbortController(),
    lastSave: 0,
    metaAt: 0,
    dirtyMeta: false,
    stopUnconfirmed: false,
    stopRequested: false,
    reuse: [],
    fgTaskId: null,
    steers: [],
    leftoverSteer: '',
    lastEventAt: Date.now(),
  };
  l.active = run;
  broadcastAgent();

  // Fire-and-forget launch after claiming l.active; any error must reach finish() so the lane is always released.
  try {
    await launchRun(l, run, spec);
  } catch (e: any) {
    console.error('[runs] launch failed', e?.message ?? e);
    finish(l, run, 'error', undefined, `Couldn't start: ${e?.message ?? e}`);
  }
}

async function launchRun(l: Lane, run: ActiveRun, spec: RunSpec) {
  // Build brief/check-in prompts at launch (not enqueue) so pending cards and page states are current.
  if (spec.kind === 'brief') spec.input = briefInput();
  else if (spec.kind === 'checkin') spec.input = checkinInput(spec.since);

  // Notes are cleared only once Hermes accepts the run, so a failed start doesn't lose them.
  const consumedNotes = l.main && spec.kind === 'chat' ? kv.get<string[]>('context_notes', []) : [];
  const notes = formatContextNotes(consumedNotes);
  const channelId = channelOfSpec(spec);
  // Read fresh at launch so cards decided while queued aren't re-listed; turnNote scopes to the run's session.
  const waiting = turnNote(items.pendingCards(channelId), spec);
  const input = notes + waiting + spec.input;

  if (spec.taskId) {
    const t = tasks.get(spec.taskId);
    if (t && (t.status === 'queued' || t.status === 'waiting')) putTask({ ...t, status: 'running' });
  }

  try {
    if (!hermes.hasKey()) throw new Error('no Hermes API key (set DUET_HERMES_KEY or API_SERVER_KEY in ~/.hermes/.env)');
    const channel = channels.get(channelId) ?? channels.general();
    const otherChannels =
      channel.id === GENERAL_CHANNEL ? channels.all().filter((c) => c.id !== GENERAL_CHANNEL) : [];
    const topicChannels =
      otherChannels.length > 0
        ? `Other topic channels you can route work to with assign_channel: ${otherChannels.map((c) => `#${c.name} (${c.id}${c.topic ? `: ${c.topic}` : ''})`).join('; ')}.`
        : undefined;
    const r = await hermes.startRun({
      input,
      session_id: spec.sessionId,
      instructions: persona(settings.get(), {
        taskId: spec.taskId ?? undefined,
        channel: channelLine(channel, spec.sessionId === mainSessionId()),
        connectors: runtime.connectorLines || undefined,
        topicChannels,
      }),
      idempotencyKey: (spec.idem ??= `duet-${newId()}`),
    });
    run.id = r.run_id;
    if (consumedNotes.length) consumeContextNotes(consumedNotes);
    // Stop was tapped while this POST was in flight. There was no id to cancel then, so honour it now, before the
    // consume loop starts: `stopRun` finishes the lane itself.
    if (run.stopRequested) {
      void stopRun(l, run);
      return;
    }
    if (l.main && spec.kind !== 'checkin') setTimeout(() => trackForeground(l, run), FG_AFTER_MS);
  } catch (e: any) {
    l.active = null;
    const busy = e instanceof HermesError && e.status === 429;
    const unreachable = !(e instanceof HermesError) && !String(e?.message).startsWith('no Hermes API key');
    const restarting = e instanceof HermesError && [502, 503, 504].includes(e.status);
    if (busy || unreachable || restarting) {
      // A stop request means this turn must not run at all: drop it instead of re-queueing it behind the user's back.
      if (run.stopRequested) {
        broadcastAgent();
        dropIdleLane(l);
        return;
      }
      // Transient: keep the work at the front of its lane instead of dropping it.
      l.queue.unshift(spec);
      persistQueues();
      if (busy) setTimeout(pumpAll, 5000);
      else {
        setHermesStatus('down');
        if (!runtime.offlineNoted && !spec.quiet) {
          runtime.offlineNoted = true;
          systemNote("Hermes isn't reachable right now. Your message is queued and goes out as soon as it's back.", spec.taskId, channelId);
        }
      }
      broadcastAgent();
      dropIdleLane(l);
      return;
    }
    const msg = `Couldn't start: ${e?.message ?? e}`;
    const t = spec.taskId ? tasks.get(spec.taskId) : null;
    if (t?.background && t.status !== 'cancelled' && t.status !== 'done') {
      // A background task that never started hands over like any other failure, with "Try again".
      const failed = putTask({ ...t, status: 'failed', result: msg, progress: '' });
      syncRoutineResult(failed);
      announceEnd(failed);
    } else {
      if (!spec.quiet) systemNote(msg, spec.taskId, channelId);
      if (spec.taskId) failTask(spec.taskId, msg);
    }
    broadcastAgent();
    setTimeout(pumpAll, 2000);
    dropIdleLane(l);
    return;
  }

  // Background task tool chatter stays in the Tasks tab, not the thread.
  if (!spec.quiet && spec.kind !== 'task') {
    run.activity = put(
      newItem('activity', {
        run_id: run.id,
        task_id: spec.taskId ?? null,
        channel_id: channelId,
        activity: { run_id: run.id, status: 'running', steps: [] },
      }),
    );
  }
  runs.start(run.id, spec.kind, spec.sessionId, spec.taskId ?? null, runMeta(run));
  consume(l, run);
}

// ---------------------------------------------------------------------------
// Stream consumption, watchdog & event handling
// ---------------------------------------------------------------------------

async function consume(l: Lane, run: ActiveRun) {
  let attempts = 0;
  run.lastEventAt = Date.now();
  // Hermes keeps the stream open with keepalives while a run is wedged, so silence is checked on a timer, not when
  // the stream drops. finish() aborts the stream, which ends the loop.
  const watchdog = setInterval(() => stopIfHung(l, run), WATCHDOG_MS);
  try {
    while (!run.finished) {
      try {
        await hermes.events(
          run.id,
          run.lastSeq,
          (ev) => {
            attempts = 0;
            onEvent(l, run, ev);
          },
          run.abort.signal,
        );
      } catch (e: any) {
        if (run.abort.signal.aborted) break;
        console.warn('[runs] event stream error', run.id, e?.message ?? e);
      }
      if (run.finished) break;
      // The stream closed without a terminal event: ask for the run's status directly.
      try {
        const st = await hermes.getRun(run.id);
        const s = st.status;
        if (typeof st.pending_steer === 'string') run.leftoverSteer = st.pending_steer;
        if (s === 'completed') finish(l, run, 'done', st.output);
        else if (s === 'failed') finish(l, run, 'error', st.output, errorText(st.error) || 'Run failed');
        else if (s === 'cancelled' || s === 'interrupted') finish(l, run, 'stopped', st.output);
        else if (s === 'unknown') {
          // Its owner died with the gateway. Acknowledge it so the session isn't left paused.
          if (st.admission_id) await hermes.resolveUnknown(run.id, st.admission_id, Number(st.execution_generation ?? 0)).catch(() => {});
          finish(l, run, 'error', undefined, INTERRUPTED);
        }
        if (run.finished) break;
      } catch (e: any) {
        if (e instanceof HermesError && e.status === 404) {
          finish(l, run, 'error', undefined, INTERRUPTED);
          break;
        }
      }
      attempts++;
      await sleep(Math.min(15_000, 500 * 2 ** Math.min(attempts, 5)));
    }
  } finally {
    clearInterval(watchdog);
  }
}

/** Stop a run that has sent nothing for the configured limit, unless it's paused on a Hermes prompt for the user. */
function stopIfHung(l: Lane, run: ActiveRun) {
  if (run.finished || !run.id) return;
  const waitingOnUser = items.pendingCards().some((c) => c.card?.hermes?.run_id === run.id);
  // The silence clock starts again once the user answers, even if no settled event arrives.
  if (waitingOnUser) run.lastEventAt = Date.now();
  if (!runHung({ lastEventAt: run.lastEventAt, waitingOnUser }, Date.now(), config.runTimeoutMs)) return;
  console.log(`[runs] ${run.id} sent nothing for ${Math.round((Date.now() - run.lastEventAt) / 60_000)} min; stopping it`);
  void stopHung(l, run);
}

/**
 * Best-effort bounded fetch of `pending_steer` before a forced stop finishes the run, so steers sent right as Stop or
 * timeout hit are recovered and replayed instead of silently dropped.
 */
async function hydratePendingSteer(run: ActiveRun) {
  if (!run.id || run.finished || !run.steers.length || run.leftoverSteer) return;
  try {
    const st = await Promise.race([hermes.getRun(run.id), sleep(1_500).then(() => null)]);
    if (st && typeof st.pending_steer === 'string') run.leftoverSteer = st.pending_steer;
  } catch {}
}

/** End a hung run after confirming stop (within a bound) so retry cards note unconfirmed stops. */
async function stopHung(l: Lane, run: ActiveRun) {
  run.stopRequested = true;
  const how = await requestStop(run.id);
  // Its own terminal event may have arrived while we were asking; that outcome is better than ours.
  if (run.finished) return;
  run.stopUnconfirmed = how === 'unknown';
  await hydratePendingSteer(run);
  finish(l, run, 'error', undefined, TIMED_OUT);
}

/** Unpause a session Hermes froze after losing a run's owner; true if something was resolved. */
async function resolveUnknownFor(sessionId: string): Promise<boolean> {
  for (const row of runs.recentFor(sessionId, 6)) {
    try {
      const st = await hermes.getRun(row.id);
      if (st.status === 'unknown' && st.admission_id) {
        await hermes.resolveUnknown(row.id, st.admission_id, Number(st.execution_generation ?? 0));
        console.log(`[recover] resolved unknown run ${row.id} on ${sessionId}`);
        return true;
      }
    } catch {}
  }
  return false;
}

function errorText(err: any): string {
  if (!err) return '';
  if (typeof err === 'string') return err;
  return err.message ?? err.detail ?? JSON.stringify(err).slice(0, 300);
}

function onEvent(l: Lane, run: ActiveRun, ev: RunEvent) {
  // A reconnect resumes at last_seq, which a replaying server may treat as inclusive, and a frame without `id:`
  // carries no seq at all. Applying the same delta twice would double the text in the bubble.
  if (typeof ev.seq === 'number' && ev.seq <= run.lastSeq) return;
  run.lastEventAt = Date.now();
  // assistant.completed and the terminal run.* event both carry it.
  if (typeof ev.pending_steer === 'string') run.leftoverSteer = ev.pending_steer;
  switch (ev.event) {
    case 'message.delta':
      if (typeof ev.delta === 'string') appendText(run, ev.delta);
      break;
    case 'message.interim':
      if (!ev.already_streamed && typeof ev.text === 'string' && ev.text.trim()) appendText(run, ev.text);
      closeSegment(run);
      break;
    case 'tool.started': {
      closeSegment(run);
      const id = String(ev.tool_call_id ?? newId());
      if (!run.steps.some((s) => s.id === id)) {
        run.steps.push({ id, name: String(ev.tool ?? 'tool'), label: stepLabel(ev), status: 'running', started_at: Date.now() });
      }
      saveActivity(run);
      if (run.spec.taskId) autoProgress(run.spec.taskId, stepLabel(ev) || String(ev.tool ?? ''));
      if (l.main) {
        trackForeground(l, run);
        if (run.fgTaskId) autoProgress(run.fgTaskId, stepLabel(ev) || String(ev.tool ?? ''));
      }
      break;
    }
    case 'tool.completed': {
      const step = run.steps.find((s) => s.id === String(ev.tool_call_id)) ?? [...run.steps].reverse().find((s) => s.name === ev.tool && s.status === 'running');
      if (step) {
        step.status = ev.error ? 'error' : 'done';
        step.ended_at = Date.now();
      }
      saveActivity(run);
      break;
    }
    case 'approval.request':
      hermesPrompt(run, ev, 'approval');
      break;
    case 'clarify.request':
      hermesPrompt(run, ev, 'clarify');
      break;
    case 'approval.settled':
    case 'clarify.settled':
      expireHermesPrompt(String(ev.request_id ?? ev.prompt_id ?? ''));
      break;
    case 'run.completed':
      finish(l, run, 'done', typeof ev.output === 'string' ? ev.output : undefined);
      break;
    case 'run.failed':
      finish(l, run, 'error', undefined, errorText(ev.error) || 'Run failed');
      break;
    case 'run.cancelled':
    case 'run.interrupted':
      finish(l, run, 'stopped');
      break;
  }
  // Advance cursor and flush throttled metadata only after the event handler completes cleanly, so an error during
  // mutation does not skip the failed event across reconnects.
  if (typeof ev.seq === 'number') run.lastSeq = Math.max(run.lastSeq, ev.seq);
  if (!run.finished && (run.dirtyMeta || run.lastEventAt - run.metaAt > 1_000)) {
    run.dirtyMeta = false;
    run.metaAt = run.lastEventAt;
    saveRunMeta(run);
  }
}

function stepLabel(ev: RunEvent): string | undefined {
  const raw = typeof ev.label === 'string' ? ev.label : typeof ev.preview === 'string' ? ev.preview : '';
  const s = raw.replace(/\s+/g, ' ').trim();
  return s ? (s.length > 90 ? `${s.slice(0, 89)}…` : s) : undefined;
}

function autoProgress(taskId: string, label: string) {
  const t = tasks.get(taskId);
  if (!t || t.status !== 'running' || !label) return;
  // Only fill the progress line when the agent isn't maintaining its own.
  if (t.progress && !t.progress.startsWith('· ')) return;
  putTask({ ...t, progress: `· ${label}` });
}

function runTitle(spec: RunSpec): string {
  if (spec.kind === 'brief') return 'Morning brief';
  if (spec.kind === 'decision') {
    const m = spec.input.match(/^\[(approval|answer) [^\]]+\] (APPROVED(?: with edits)?|NOT NOW)?:?\s*(?:To )?"([^"]+)"/);
    return m ? `${m[2]?.startsWith('APPROVED') ? 'Approved' : m[2] === 'NOT NOW' ? 'Declined' : 'Answered'}: ${m[3]}` : 'Following up on your answer';
  }
  return firstLine(spec.input, 80) || 'Working on your message';
}

function trackForeground(l: Lane, run: ActiveRun) {
  if (!l.main || run.finished || run.fgTaskId || run.spec.kind === 'checkin') return;
  if (Date.now() - run.startedAt < FG_AFTER_MS && run.steps.length < 2) return;
  const now = Date.now();
  const current = [...run.steps].reverse().find((s) => s.status === 'running');
  const task: Task = {
    id: newId(),
    title: runTitle(run.spec),
    status: 'running',
    progress: current ? `· ${current.label || current.name}` : '· Thinking',
    steps: [],
    created_at: now,
    updated_at: now,
    background: false,
  };
  run.fgTaskId = task.id;
  putTask(task, null);
  saveRunMeta(run);
}

function saveActivity(run: ActiveRun) {
  if (!run.activity) return;
  run.activity.activity = { ...run.activity.activity!, steps: run.steps };
  put(run.activity);
}

function appendText(run: ActiveRun, delta: string) {
  run.text += delta;
  run.segText += delta;
  // Background task runs keep their text out of the thread: the handover card carries the result.
  if (run.spec.quiet || run.spec.kind === 'task') return;
  if (!run.assistant) {
    // Hold leading whitespace so empty segments never become empty bubbles.
    if (!(run.pendingWs + delta).trim()) {
      run.pendingWs += delta;
      return;
    }
    delta = (run.pendingWs + delta).replace(/^\s+/, '');
    run.pendingWs = '';
    const reuse = run.reuse.shift();
    run.assistant = reuse
      ? { ...reuse, text: '', streaming: true }
      : newItem('assistant', { run_id: run.id, task_id: run.spec.taskId ?? null, channel_id: channelOfSpec(run.spec), text: '', streaming: true });
    put(run.assistant);
    run.dirtyMeta = true;
    saveRunMeta(run);
  }
  run.assistant.text = (run.assistant.text ?? '') + delta;
  broadcast({ type: 'delta', item_id: run.assistant.id, text: delta });
  if (Date.now() - run.lastSave > 1000) {
    run.lastSave = Date.now();
    items.save(run.assistant);
    run.dirtyMeta = true;
    saveRunMeta(run);
  }
}

function finish(l: Lane, run: ActiveRun, status: 'done' | 'error' | 'stopped', output?: string, error?: string) {
  if (run.finished) return;
  run.finished = true;
  run.abort.abort();
  // Releasing the lane is the one thing that must always happen. Everything below writes to SQLite and pushes, any
  // of which can throw; a stuck `l.active` makes pumpAll skip this lane for the rest of the process, so no queued
  // message would ever run again. The watchdog calls finish from a timer, where a throw is uncaught.
  try {
    finishBody(l, run, status, output, error);
  } catch (e: any) {
    console.error('[runs] finish failed', run.id, e?.message ?? e);
    // Never leave the row 'running': restart recovery would reattach a run that is already over. A run that had
    // already ended keeps its real outcome.
    try {
      runs.abandon(run.id, 'finish failed');
    } catch {}
  } finally {
    l.active = null;
    broadcastAgent();
    pumpAll();
    // Without this the map grows by one entry per task session for the life of the process, and pumpAll scans every
    // one of them on each wake.
    dropIdleLane(l);
  }
}

function finishBody(l: Lane, run: ActiveRun, status: 'done' | 'error' | 'stopped', output?: string, error?: string) {
  // Messages that arrived during the final model call come back undelivered; they go next, as one chat turn.
  // Front of the queue: steering only happens while the queue is empty, so everything queued now came after them.
  const late = undeliveredSteers(run.steers, run.leftoverSteer);
  if (late.length) {
    for (const s of late) s.queued = true;
    l.queue.unshift({ kind: 'chat', sessionId: l.sessionId, channelId: channelOfSpec(run.spec), input: late.map((s) => s.raw).join('\n\n') });
    persistQueues();
  }

  if (!run.text.trim() && output && output.trim()) appendText(run, output);
  closeSegment(run);
  // Task text never became a segment, so its MEDIA markers are picked up here instead.
  if (run.spec.kind === 'task') deliverMedia(run, run.text);
  for (const s of run.steps) {
    if (s.status === 'running') {
      s.status = status === 'done' ? 'done' : 'error';
      s.ended_at = Date.now();
    }
  }
  if (run.activity) {
    run.activity.activity = { run_id: run.id, status, steps: run.steps, error };
    put(run.activity);
  }
  runs.end(run.id, status, error);
  // Before anything below counts pending cards: a prompt from this run can't be answered any more.
  expireDeadPrompts();
  if (run.fgTaskId) {
    const t = tasks.get(run.fgTaskId);
    if (t && t.status === 'running') {
      const outcome: Task['status'] = status === 'done' ? 'done' : status === 'stopped' ? 'cancelled' : 'failed';
      const waiting = run.cards > 0 && items.pendingCards().some((c) => c.run_id === run.id);
      putTask(withAgentDone({ ...t, status: outcome, progress: '', result: waiting ? 'Waiting on your answer in Chat.' : status === 'done' ? firstLine(run.lastText || run.text, 300) || 'Done.' : error ?? 'Stopped.' }));
    }
  }

  const spec = run.spec;
  const text = run.text.trim();

  if (status === 'error' && /unknown_execution/.test(error ?? '') && !spec.retried) {
    // Hermes paused this session after a crash. Unpause it and retry this turn once.
    resolveUnknownFor(spec.sessionId).then((ok) => {
      if (ok) l.queue.unshift({ ...spec, retried: true });
      else if (!spec.quiet) systemNote('Hermes has this conversation paused and I could not unpause it. Try again in a minute.', spec.taskId, channelOfSpec(spec));
      persistQueues();
      broadcastAgent();
      pumpAll();
    });
    return;
  }
  const refresh = status === 'error' && error === INTERRUPTED && spec.taskId ? tasks.get(spec.taskId) : null;
  if (refresh?.page_id) {
    // A scheduled page refresh: start it over quietly, or end it like any refresh (pageRefreshEnded, no push).
    // onTaskRunEnd keeps a task that already ended as it was.
    const next = afterInterruption(refresh, !!spec.restarted);
    if (next === 'restart') {
      requeueTask(refresh, INTERRUPTED, true);
      console.log(`[pages] refresh ${refresh.id} interrupted; starting it over`);
    } else {
      onTaskRunEnd(refresh.id, run, 'error', next.fail);
    }
    return;
  }
  if (status === 'error' && error === INTERRUPTED && !spec.quiet && (spec.kind === 'chat' || spec.kind === 'task' || spec.kind === 'decision')) {
    const task = spec.taskId ? tasks.get(spec.taskId) : null;
    if ((spec.kind === 'task' || spec.taskId) && task?.status === 'done') {
      onTaskRunEnd(task.id, run, 'error', error);
      return;
    }
    const what = spec.taskId ? task?.title : runTitle(spec);
    // The "Pick it back up?" card below pushes for this interruption; a second "Task failed" push would be noise.
    if (spec.taskId) failTask(spec.taskId, 'Interrupted: Hermes restarted mid-task.', { push: false });
    const card = put(
      newItem('card', {
        task_id: spec.taskId ?? null,
        channel_id: channelOfSpec(spec),
        card: {
          type: 'choice',
          title: `Pick “${firstLine(what ?? 'that', 70)}” back up?`,
          body: resumeCardBody({ retried: spec.retried, steps: run.steps, taskSteps: task?.steps }),
          options: [...RESUME_OPTIONS],
          status: 'pending',
          resume: true,
          task_id: spec.taskId ?? undefined,
          session_id: spec.sessionId,
          channel_id: channelOfSpec(spec),
        },
      }),
    );
    pushSafe({ title: 'Work was interrupted', body: card.card!.title, card_id: card.id, tag: card.id, url: cardUrl(card.id, card.channel_id), category: 'system', channel_id: card.channel_id });
    return;
  }

  if (spec.kind === 'checkin') {
    const { surfaced, stray } = checkinOutcome(run);
    if (surfaced) addContextNote('A check-in posted a "Heads up" brief to the user (see their thread).');
    if (stray) console.log(`[checkin] not posted (no brief): ${firstLine(stray)}`);
  } else if (spec.kind === 'task' || spec.taskId) {
    onTaskRunEnd(spec.taskId!, run, status, error);
  } else if (spec.kind === 'brief' && status === 'error') {
    const failed = briefFailure({ briefs: run.briefs, error });
    if (failed) {
      expireBriefRetries();
      const card = put(
        newItem('card', {
          card: { type: 'choice', title: failed.title, body: failed.body, options: [...BRIEF_RETRY], status: 'pending', rerun: 'brief', channel_id: GENERAL_CHANNEL },
        }),
      );
      // The user expects a brief at this hour, so its failure reaches them the way the brief would have.
      pushSafe({ title: "Your morning brief didn't finish", body: 'Tap to run it again.', card_id: card.id, tag: 'brief', url: cardUrl(card.id, card.channel_id), category: 'brief', channel_id: card.channel_id }, { ignoreQuiet: true });
    }
  } else if (status === 'error') {
    // A chat or decision turn: a reply that never came reaches the user like one that did, with one tap to retry
    // in the same session (actOnCard's resume path), and quiet hours hold its push like any card's.
    const card = put(
      newItem('card', {
        channel_id: channelOfSpec(spec),
        card: {
          type: 'choice',
          title: `Try “${firstLine(retryTitle(runTitle(spec)), 70)}” again?`,
          body: failedTurnBody({ error, steps: run.steps, limitMin: Math.round(config.runTimeoutMs / 60_000), stopUnconfirmed: run.stopUnconfirmed }),
          options: [...RETRY_OPTIONS],
          status: 'pending',
          resume: true,
          session_id: spec.sessionId,
          channel_id: channelOfSpec(spec),
        },
      }),
    );
    pushSafe({ title: "Couldn't finish", body: card.card!.title, card_id: card.id, tag: card.id, url: cardUrl(card.id, card.channel_id), category: 'system', channel_id: card.channel_id });
  } else if (status === 'done' && l.main) {
    if (spec.kind === 'brief') {
      const { note, stray } = morningOutcome(run);
      if (note) systemNote(note);
      if (stray) console.log(`[brief] no card posted, not pushed: ${firstLine(stray)}`);
    } else if (!run.cards && text) {
      // notify() skips devices that have the app on screen, so this only reaches you when you've walked away.
      pushSafe({ title: 'Hermes Duet', body: firstLine(text), tag: 'reply', category: 'system', channel_id: channelOfSpec(spec) });
    }
  }
}

function onTaskRunEnd(taskId: string, run: ActiveRun, status: 'done' | 'error' | 'stopped', error?: string) {
  const t = tasks.get(taskId);
  if (!t || t.status === 'cancelled') return;
  const waiting = items.pendingCards().some((c) => c.card?.task_id === taskId);
  // A run that dies after the agent already marked the task done still hands its result over.
  if ((status === 'error' || status === 'stopped') && t.status !== 'done') {
    // Keep the agent's own reason if it already marked the task failed before the run died.
    const reason = t.status === 'failed' && t.result ? t.result : firstLine(error ?? 'Stopped before it finished.', 300);
    putTask({ ...t, status: 'failed', result: reason, progress: '' });
  } else if (waiting && t.status !== 'done') {
    putTask({ ...t, status: 'waiting', progress: 'Waiting on you' });
    return;
  } else {
    const result = t.result || firstLine(stripMedia(run.lastText || run.text), 300) || 'Finished.';
    if (t.status === 'running' || t.status === 'queued' || t.status === 'waiting') {
      putTask(withAgentDone({ ...t, status: 'done', result, progress: t.progress?.startsWith('· ') ? '' : t.progress, steps: t.steps.map((s) => ({ ...s, done: true })) }));
    }
  }
  const final = tasks.get(taskId)!;
  announceEnd(final);
  // A routine's task ending is the routine's result. The next run already moved when the task started, so a failure
  // still advances the schedule; this only records how the run went.
  syncRoutineResult(final);
}

/** A task that ended done or failed: its handover card, a note for the main session, and one push. */
function announceEnd(final: Task) {
  const taskId = final.id;
  if (final.status !== 'done' && final.status !== 'failed') return;
  if (final.page_id) return pageRefreshEnded(final);
  const card = handOver(final);
  const delivered = (card.card!.file_ids ?? []).map((id) => files.get(id)?.entry.title).filter(Boolean);
  const filesNote = delivered.length ? ` Files: ${delivered.join('; ')}.` : '';
  if (final.status === 'done') {
    addContextNote(`Background task "${final.title}" (${taskId}) finished: ${final.result ?? ''}${filesNote} The user has its handover card in the thread.`);
    pushSafe({ title: `Done: ${final.title}`, body: firstLine(final.result ?? 'Finished.'), tag: `task-${taskId}`, url: cardUrl(card.id, card.channel_id), category: 'task_done', channel_id: card.channel_id });
  } else {
    addContextNote(`Background task "${final.title}" (${taskId}) failed: ${final.result ?? ''}${filesNote} The user has its card in the thread${card.card!.retry ? ', with a "Try again" button' : ''}.`);
    pushSafe({ title: `Task failed: ${final.title}`, body: firstLine(final.result ?? ''), tag: `task-${taskId}`, url: cardUrl(card.id, card.channel_id), category: 'task_failed', channel_id: card.channel_id });
  }
}

/**
 * A standing page's scheduled refresh ended. It runs before the brief, so it never pushes and a success posts no
 * card: the new version is already in Make. A failure leaves the muted handover card, so "Try again" is one tap.
 */
function pageRefreshEnded(final: Task) {
  const page = pages.get(final.page_id!);
  if (!page) return;
  // Done only counts if this attempt actually delivered a new version (deliverFile moves refreshed_at).
  const fresh = (page.refreshed_at ?? 0) >= (final.retried_at ?? final.created_at);
  const ok = final.status === 'done' && fresh;
  const result = ok ? final.result || 'Refreshed.' : final.status === 'done' ? 'Finished without delivering a new version.' : final.result || 'Stopped before it finished.';
  // `changed` describes the newest version against the one before it, so a failed refresh has nothing to say.
  const changed = ok ? final.changed?.trim() || undefined : undefined;
  putPage({ ...page, task_id: final.id, last_ok: ok, last_result: result, changed });
  if (final.status === 'failed') handOver(final);
  const what = changed ? ` What changed: ${changed}` : '';
  addContextNote(`Standing page "${page.title}" (${page.id}) ${ok ? 'refreshed' : 'did not refresh'} this morning: ${result}${what}`);
}

// ---------------------------------------------------------------------------
// Standing pages & tasks lifecycle
// ---------------------------------------------------------------------------

/** Start a standing page's daily refresh as a background task; it shows in Tasks like any other. */
export function refreshPage(page: Page, date: string) {
  if (pageRefreshing(page)) return;
  const current = files.get(page.file_id);
  const t = startTask(`Refresh: ${page.title}`, pageRefreshInstructions(page, current?.path ?? null), [], page.id);
  // Yesterday's outcome no longer describes today's refresh; pageRefreshEnded fills these in again.
  putPage({ ...page, refreshed_on: date, task_id: t.id, last_ok: undefined, last_result: undefined, changed: undefined });
  console.log(`[pages] refreshing ${page.id} (${page.title}) as task ${t.id}`);
}

/**
 * Stop a standing page: drop its row and cancel a refresh still in flight, so nothing replaces the file afterwards.
 * Files it already delivered stay in Make. `callerTask` is the task asking for the removal, which must not cancel
 * itself mid-tool-call.
 */
export async function removePage(id: string, callerTask?: string | null): Promise<Page> {
  const page = pages.get(id);
  if (!page) throw new Error('page not found');
  pages.remove(page.id);
  broadcast({ type: 'page_removed', id: page.id });
  const cancel = refreshToCancel(page, pageRefreshing(page), callerTask);
  if (cancel) await cancelTask(cancel);
  return page;
}

/** The user stopped a page from Make; the agent hears about it on its next turn so it doesn't offer to rebuild it. */
export async function stopPage(id: string) {
  const page = await removePage(id);
  addContextNote(`The user stopped the standing page "${page.title}" (${page.id}) from the app. It no longer refreshes; its files stay in Make.`);
}

export function startTask(title: string, instructions: string, steps: string[], pageId?: string, channelId?: string, routineId?: string): Task {
  const now = Date.now();
  const task: Task = {
    id: newId(),
    title,
    status: 'queued',
    progress: '',
    steps: steps.filter(Boolean).map((text) => ({ text, done: false })),
    created_at: now,
    updated_at: now,
    background: true,
    instructions,
    page_id: pageId,
    routine_id: routineId,
    ...(channelId && channelId !== GENERAL_CHANNEL && { channel_id: channelId }),
  };
  const sessionId = `duet-task-${task.id}`;
  putTask(task, sessionId);
  enqueue({ kind: 'task', sessionId, taskId: task.id, channelId: channels.forTask(task), input: taskPrompt(task, instructions) });
  return task;
}

/**
 * Queue a task again from its stored instructions in a fresh Hermes session. `retried_at` keeps files from earlier
 * attempts off the new handover card, and a page refresh only counts a version delivered after it.
 * `auto`: Duet restarted it after Hermes restarted mid-run (marked on the spec, so it happens once).
 */
export function requeueTask(t: Task, previous?: string, auto = false): Task {
  const task: Task = {
    ...t,
    status: 'queued',
    progress: '',
    result: undefined,
    follow_ups: undefined,
    changed: undefined,
    handover_id: undefined,
    steps: t.steps.map((s) => ({ ...s, done: false })),
    retried_at: Date.now(),
  };
  const sessionId = `duet-task-${t.id}-${newId()}`;
  putTask(task, sessionId);
  enqueue({
    kind: 'task',
    sessionId,
    taskId: t.id,
    channelId: channels.forTask(task),
    input: taskPrompt(task, t.instructions!, previous, auto),
    ...(auto && { restarted: true }),
  });
  return task;
}

// ---------------------------------------------------------------------------
// Stopping, cancelling & steering
// ---------------------------------------------------------------------------

/** How long Hermes gets to hear about a stop before the lane is settled locally anyway. The gateway is on this host,
 * so its terminal event normally arrives in well under this; the grace exists for the run that never answers. */
const STOP_GRACE_MS = 1_000;
/** The stop POST itself: a gateway that doesn't answer must not hold the user's Stop button hostage. */
const STOP_POST_MS = 5_000;

/**
 * Ask Hermes to stop a run, bounded so a wedged gateway cannot hold anything hostage. `gone` means Hermes has already
 * forgotten it (nothing can still be running); `unknown` means we could not tell, so a caller that offers a retry has
 * to say so.
 */
async function requestStop(id: string): Promise<'stopped' | 'gone' | 'unknown'> {
  const asked = hermes.stop(id).then(
    () => 'stopped' as const,
    (e) => (e instanceof HermesError && e.status === 404 ? ('gone' as const) : ('unknown' as const)),
  );
  return Promise.race([asked, sleep(STOP_POST_MS).then(() => 'unknown' as const)]);
}

/**
 * Stop a run and ensure its lane releases within STOP_GRACE_MS even if the gateway is down or returned 404.
 * A late terminal event is a no-op because `finish` is idempotent.
 */
async function stopRun(l: Lane, run: ActiveRun): Promise<void> {
  if (run.finished) return;
  run.stopRequested = true;
  // Run id not yet assigned; launchRun checks stopRequested right after startRun returns.
  if (!run.id) return;
  // Unreachable, refused or too slow: there is nothing left to wait for.
  if ((await requestStop(run.id)) !== 'stopped') {
    await hydratePendingSteer(run);
    if (!run.finished) finish(l, run, 'stopped');
    return;
  }
  const deadline = Date.now() + STOP_GRACE_MS;
  while (!run.finished && Date.now() < deadline) await sleep(50);
  if (!run.finished) {
    await hydratePendingSteer(run);
    if (!run.finished) finish(l, run, 'stopped');
  }
}

export async function stopMain() {
  const l = mainLane();
  if (l.active) await stopRun(l, l.active);
}

export async function cancelTask(id: string) {
  const t = tasks.get(id);
  if (!t) throw new Error('task not found');
  if (['done', 'failed', 'cancelled'].includes(t.status)) return;
  syncRoutineResult(putTask({ ...t, status: 'cancelled', progress: '' }));
  if (!t.background) {
    // A mirrored main-thread turn: cancelling it means stopping that turn.
    const l = mainLane();
    if (l.active?.fgTaskId === id) await stopRun(l, l.active);
    return;
  }
  const sid = tasks.sessionOf(id);
  const l = sid ? lanes.get(sid) : undefined;
  if (l) {
    l.queue = [];
    persistQueues();
    if (l.active) await stopRun(l, l.active);
  }
  for (const c of items.pendingCards()) {
    if (c.card?.task_id === id) {
      c.card = { ...c.card, status: 'expired', decided_at: Date.now() };
      put(c);
    }
  }
}

function steerRun(run: ActiveRun, sessionId: string, channelId: string, msg: string): Promise<boolean> {
  // Go through turnNote on every steer so pending_steer replay in finish() matches chat's format.
  const steer: Steer = { sent: turnNote(items.pendingCards(channelId), run.spec) + msg, raw: msg };
  run.steers.push(steer);
  // Persist before sending so a restart mid-request does not drop the message.
  saveRunMeta(run);
  return hermes
    .steer(run.id, steer.sent)
    .then((r) => {
      if (!r?.accepted) throw new Error('not accepted');
      return true;
    })
    .catch(() => {
      // Only one path (this fallback or finish() replaying pending_steer) may enqueue the message.
      if (steer.queued || run.finished) return false;
      steer.queued = true;
      saveRunMeta(run);
      enqueue({ kind: 'chat', sessionId, channelId, input: msg });
      return false;
    });
}

/** Steer a running task mid-flight via `hermes.steer`, falling back to a session chat turn on refusal (409 if not live). */
export async function steerTask(taskId: string, text: string): Promise<{ delivered: boolean }> {
  const t = tasks.get(taskId);
  if (!t) throw new UserError('no such task', 404);
  const msg = text.trim();
  if (!msg) throw new UserError('empty message');
  if (msg.length > TASK_MESSAGE_MAX) throw new UserError('message too long');
  if (t.status !== 'running' && t.status !== 'waiting') throw new UserError(`that task is ${t.status}, so there is nothing to steer right now`, 409);
  const sid = tasks.sessionOf(taskId);
  const run = (sid ? lanes.get(sid)?.active : undefined) ?? null;
  if (!run || run.finished || run.stopRequested || !run.id || run.spec.taskId !== taskId) {
    throw new UserError('that task is not running right now', 409);
  }
  const delivered = await steerRun(run, run.spec.sessionId, channelOfSpec(run.spec), msg);
  return { delivered };
}

// ---------------------------------------------------------------------------
// Briefs, check-ins & user turns
// ---------------------------------------------------------------------------

/** The morning brief's prompt, read from the state as it is now. `launch` calls it, not `runBrief`. */
function briefInput(): string {
  const s = settings.get();
  const dayAgo = Date.now() - 86400_000;
  const today = localParts(s.timezone).date;
  return briefPrompt(s, {
    pending: items.pendingCards(),
    tasks: tasks.recent().filter((t) => ['queued', 'running', 'waiting'].includes(t.status) || t.updated_at > dayAgo),
    pages: pages.all().map((p) => pageBriefLine(p, today, pageRefreshing(p))),
    skipped: skippedLately(items.briefsSince(Date.now() - SKIP_MEMORY_DAYS * 86400_000)),
    followUps: followUps.open(),
  });
}

/** A check-in's prompt, read from the state as it is now. `since` was fixed when it was scheduled. */
function checkinInput(since?: string): string {
  const s = settings.get();
  const now = localParts(s.timezone);
  // Local midnight, give or take the current minute's seconds: today's briefs are what the user has already seen.
  const midnight = Date.now() - (now.minutes + 1) * 60_000;
  return checkinPrompt(s, {
    since: since || `this morning's brief (${s.brief_time})`,
    pending: items.pendingCards(),
    tasks: tasks.recent().filter((t) => ['running', 'waiting', 'failed'].includes(t.status)),
    raised: raisedToday(items.briefsSince(midnight)),
    followUps: followUps.open(),
  });
}

export function runBrief(source: 'scheduled' | 'manual') {
  if (source === 'manual' && !briefDedupeAllowed()) return false;
  const m = mainLane();
  const queued = m.queue.find((q) => q.kind === 'brief');
  if (queued && source === 'manual' && queued.scheduled) {
    // "Run it now" means now: a brief waiting on page refreshes stops waiting.
    queued.scheduled = false;
    persistQueues();
    pumpAll();
  }
  if (queued || m.active?.spec.kind === 'brief') return false;
  enqueue({ kind: 'brief', sessionId: m.sessionId, input: '', scheduled: source === 'scheduled' });
  console.log(`[brief] queued (${source})`);
  return true;
}

export function runCheckin() {
  const s = settings.get();
  const sid = `duet-checkin-${localParts(s.timezone).date}`;
  const l = lane(sid);
  if (l.active || l.queue.length) return;
  const since = kv.get<string>('checkin_since_label', '') || undefined;
  kv.set('checkin_since_label', new Date().toLocaleTimeString('en-US', { timeZone: s.timezone, hour: 'numeric', minute: '2-digit' }));
  enqueue({ kind: 'checkin', sessionId: sid, quiet: true, input: '', since });
}

/**
 * `input` is what the agent receives when it differs from what the thread shows (a brief entry's draft chip).
 * `channelId` is the topic channel the message belongs to; absent means the general thread.
 */
export function submitUser(text: string, input?: string, channelId?: string, attachmentList?: Attachment[]): Item {
  const shown = text.trim();
  if (!shown) throw new Error('empty message');
  const t = input?.trim() || shown;
  const channel = liveChannel(channelId);
  const item = put(
    newItem('user', { text: shown, channel_id: channel.id, ...(attachmentList?.length ? { attachments: attachmentList } : {}) }),
  );
  // One lane per channel: the general channel's lane is the main one, so briefs and check-ins stay there.
  const l = lane(channel.session_id);
  for (const c of movedOn(items.pendingCards(channel.id), l.sessionId)) put({ ...c, card: { ...c.card!, status: 'expired', decision: MOVED_ON, decided_at: Date.now() } });
  const active = l.active;
  // Mid-run messages steer the live turn; undelivered ones come back as `pending_steer` and replay in finish().
  if (active && active.id && !active.finished && !active.stopRequested && l.queue.length === 0) {
    void steerRun(active, l.sessionId, channel.id, t);
  } else {
    enqueue({ kind: 'chat', sessionId: l.sessionId, channelId: channel.id, input: t });
  }
  return item;
}

/**
 * "Run in background" from the composer: the message starts its own task instead of going to the main chat, so it
 * runs alongside whatever the chat is doing. The message stays in the thread, tagged with its task; the main session
 * hears about it on its next turn, and the usual handover card lands when the task finishes.
 */
export function startUserTask(text: string, channelId?: string, attachmentList?: Attachment[], attachmentNote?: string): { item: Item; task: Task } {
  const shown = text.trim();
  if (!shown) throw new Error('empty message');
  const channel = liveChannel(channelId);
  const instructions = userTaskInstructions(shown, items.latest(30, channel.id).items, attachmentNote);
  const task = startTask(userTaskTitle(shown), instructions, [], undefined, channel.id);
  const item = put(
    newItem('user', {
      text: shown,
      task_id: task.id,
      channel_id: channel.id,
      ...(attachmentList?.length ? { attachments: attachmentList } : {}),
    }),
  );
  addContextNote(`The user started a background task themselves: "${task.title}" (${task.id}). It runs separately; its result reaches you when it finishes.`);
  return { item, task };
}

/**
 * Something arrived from outside the conversation: a webhook, a file in a watched folder, a meeting about to start.
 * It posts as a muted system line (the user didn't say it) and starts a turn in that channel with the fuller prompt.
 */
export function submitSystem(shown: string, prompt?: string, channelId?: string): Item {
  const channel = liveChannel(channelId);
  const item = put(newItem('system', { text: shown, channel_id: channel.id }));
  enqueue({ kind: 'chat', sessionId: channel.session_id, channelId: channel.id, input: prompt ?? shown });
  return item;
}

// ---------------------------------------------------------------------------
// Routines (user-defined recurring tasks)
// ---------------------------------------------------------------------------

/** save_routine and POST /api/routines share this: validate, create or update, and recompute the next run. */
export function saveRoutine(raw: Record<string, unknown>): Routine {
  const input = routineInput(raw);
  const id = String(raw.routine_id ?? raw.id ?? '').trim();
  const existing = id ? routines.get(id) : null;
  if (id && !existing) throw new UserError(`no routine ${id}`, 404);
  const now = Date.now();
  // An update that does not mention `enabled` keeps the state it had: the edit form changes the schedule, not whether
  // the routine is paused, so saving it must not silently resume one the user paused.
  const enabled = raw.enabled === undefined ? (existing ? existing.enabled : true) : raw.enabled !== false;
  const clearChannel = 'channel_id' in raw && (raw.channel_id === null || (typeof raw.channel_id === 'string' && !raw.channel_id.trim()));
  const routine: Routine = existing
    ? { ...existing, ...input, enabled, updated_at: now }
    : { id: newId(), ...input, enabled, created_at: now, updated_at: now };
  if (clearChannel) delete routine.channel_id;
  if (routine.channel_id) liveChannel(routine.channel_id);
  routine.next_run = nextRun(routine.schedule, now, settings.get().timezone);
  return putRoutine(routine);
}

/**
 * Start a routine's task now. The scheduler advances `next_run` before calling this; this stamps the run on the
 * routine (last_run, last_task_id, "Started") and broadcasts it, so a slow run can't be picked up twice.
 */
export function startRoutine(routine: Routine, opts?: { recomputeNext?: boolean }): Routine {
  const channel = liveChannel(routine.channel_id);
  const task = startTask(routine.title, routine.prompt, [], undefined, channel.id, routine.id);
  const now = Date.now();
  const next_run =
    !opts?.recomputeNext && routine.next_run != null && routine.next_run > now
      ? routine.next_run
      : nextRun(routine.schedule, now, settings.get().timezone);
  return putRoutine({
    ...routine,
    last_run: now,
    last_task_id: task.id,
    last_result: 'Started',
    next_run,
    updated_at: now,
  });
}

/** The Run now button: start a routine immediately, whether or not it is paused. */
export function runRoutineNow(id: string): Routine {
  const routine = routines.get(id);
  if (!routine) throw new UserError('no such routine', 404);
  return startRoutine(routine, { recomputeNext: true });
}

/** Pause or resume. Resuming recomputes the next run from now, so a routine doesn't fire one it missed while paused. */
export function setRoutineEnabled(id: string, enabled: boolean): Routine | null {
  const existing = routines.get(id);
  if (!existing) return null;
  return putRoutine({
    ...existing,
    enabled,
    next_run: nextRun(existing.schedule, Date.now(), settings.get().timezone),
  });
}

// ---------------------------------------------------------------------------
// Hermes-native prompts, health & restart recovery
// ---------------------------------------------------------------------------

function hermesPrompt(run: ActiveRun, ev: RunEvent, kind: 'approval' | 'clarify') {
  const src = ev.approval ?? ev.clarify ?? ev;
  const request_id = String(src.request_id ?? src.prompt_id ?? '');
  const generation = Number(src.execution_generation ?? ev.execution_generation ?? 0);
  if (!request_id) return;
  // Restart recovery replays the event stream; don't post the same prompt twice.
  if (items.latest(300).items.some((i) => i.card?.hermes?.request_id === request_id)) return;
  const card: CardData =
    kind === 'approval'
      ? {
          type: 'approval',
          title: firstLine(String(src.description || 'Run a flagged command'), 90),
          body: src.command ? `Hermes wants to run:\n\n\`\`\`\n${String(src.command).slice(0, 1500)}\n\`\`\`` : undefined,
          action_label: 'Allow once',
          status: 'pending',
          task_id: run.spec.taskId ?? undefined,
          hermes: { kind, run_id: run.id, request_id, generation },
        }
      : {
          type: 'choice',
          title: String(src.question ?? 'Question'),
          options: Array.isArray(src.choices) && src.choices.length ? src.choices.slice(0, 4).map(String) : ['Yes', 'No'],
          status: 'pending',
          task_id: run.spec.taskId ?? undefined,
          hermes: { kind, run_id: run.id, request_id, generation },
        };
  closeSegment(run);
  const channel = channelOfSpec(run.spec);
  const item = put(newItem('card', { card: { ...card, channel_id: channel }, run_id: run.id, task_id: run.spec.taskId ?? null, channel_id: channel }));
  run.cards++;
  run.dirtyMeta = true;
  saveRunMeta(run);
  if (run.spec.taskId) markTaskWaiting(run.spec.taskId);
  pushSafe(
    kind === 'approval'
      ? { ...approvalPush(item), url: cardUrl(item.id, channel), channel_id: channel }
      : { title: 'Quick question', body: card.title, card_id: item.id, approval: false, tag: item.id, url: cardUrl(item.id, channel), category: 'question', channel_id: channel },
    { ignoreQuiet: true },
  );
}

function expireHermesPrompt(requestId: string) {
  if (!requestId) return;
  for (const c of items.pendingCards()) {
    if (c.card?.hermes?.request_id === requestId) {
      c.card = { ...c.card, status: 'expired', decided_at: Date.now() };
      put(c);
    }
  }
}

function setHermesStatus(next: AgentState['hermes']) {
  if (next === runtime.hermesStatus) return;
  if (next === 'ok' && runtime.hermesStatus === 'down') runtime.hermesBackAt = Date.now();
  runtime.hermesStatus = next;
  if (next === 'ok') runtime.offlineNoted = false;
  broadcastAgent();
  if (next === 'ok') pumpAll();
}

export async function checkHermesHealth() {
  setHermesStatus((await hermes.health()) ? 'ok' : 'down');
}

export function startHermesWatch() {
  void checkHermesHealth();
  setInterval(() => void checkHermesHealth(), 20_000);
}

export function recoverOrphans() {
  // Queued-but-unstarted work survives restarts.
  for (const spec of kv.get<RunSpec[]>('queues', [])) lane(spec.sessionId).queue.push(spec);

  for (const row of runs.orphaned()) {
    let meta: any = {};
    try {
      meta = row.meta ? JSON.parse(row.meta) : {};
    } catch {
      // This runs at top level on boot, so one corrupt row must not crash-loop the server: close it and move on.
      runs.abandon(row.id, 'corrupt run record');
      continue;
    }
    const spec: RunSpec = meta.spec ?? { kind: row.kind as RunKind, sessionId: row.session_id, input: '', taskId: row.task_id };
    const l = lane(spec.sessionId);
    if (l.active) {
      runs.end(row.id, 'error', 'superseded');
      continue;
    }
    const activity = meta.activityId ? items.get(meta.activityId) : null;
    const segments = segmentsOf(row.id);
    // Resume from saved cursor if present; otherwise replay from seq 0 reusing existing segments.
    const resumed = typeof meta.lastSeq === 'number' && meta.lastSeq > 0;
    const last = resumed ? segments[segments.length - 1] : undefined;
    const open = last?.streaming ? last : undefined;
    const lastNonEmpty = resumed ? [...segments].reverse().find((s) => !s.streaming && (s.text ?? '').trim()) : undefined;
    const run: ActiveRun = {
      id: row.id,
      spec,
      startedAt: row.started_at,
      activity,
      assistant: open ? { ...open, streaming: true } : null,
      text: resumed ? segments.map((s) => s.text ?? '').join('') : '',
      segText: open?.text ?? '',
      lastText: lastNonEmpty?.text ?? '',
      pendingWs: '',
      // Seed saved steps so finished runs still show progress and replayed tool events dedupe by tool_call_id.
      steps: (activity?.activity?.steps ?? []).map((s) => ({ ...s })),
      lastSeq: resumed ? meta.lastSeq : 0,
      cards: typeof meta.cards === 'number' ? meta.cards : 0,
      briefs: typeof meta.briefs === 'number' ? meta.briefs : 0,
      finished: false,
      abort: new AbortController(),
      lastSave: 0,
      metaAt: 0,
      dirtyMeta: false,
      stopUnconfirmed: false,
      stopRequested: false,
      reuse: resumed ? [] : segments,
      fgTaskId: meta.fgTaskId ?? null,
      steers: Array.isArray(meta.steers) ? meta.steers : [],
      leftoverSteer: '',
      lastEventAt: typeof meta.lastEventAt === 'number' ? meta.lastEventAt : Date.now(),
    };
    l.active = run;
    console.log(`[recover] reattaching run ${row.id} (${spec.kind})`);
    consume(l, run);
  }
  // Every run that can still be live is reattached now; prompts from any other run are dead.
  const expired = expireDeadPrompts();
  if (expired) console.log(`[recover] expired ${expired} Hermes prompt(s) whose run had ended`);
  pumpAll();
}
