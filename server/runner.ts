import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import type { AgentState, CardData, FileEntry, Item, Page, Task, TaskStep, ToolStep } from '../shared/types';
import { DRAFT_MAX, approvalDecision, approvalPush } from './approval';
import { briefCard, briefTitle, checkinOutcome, morningOutcome, useDraft } from './brief';
import { broadcast } from './bus';
import { localParts } from './clock';
import { config } from './config';
import { files, items, kv, newId, pages, runs, settings, tasks } from './db';
import { followUps, handoverCard } from './handover';
import { HermesError, hermes, type RunEvent } from './hermes';
import { MAX_PAGES, pageBriefLine, pageInput, refreshTime, refreshToCancel } from './pages';
import { briefPrompt, checkinPrompt, decisionPrompt, pageRefreshInstructions, persona, taskPrompt } from './prompts';
import { notify } from './push';
import { resumeCardBody } from './recovery';

// ---------------------------------------------------------------------------
// Lanes: one per agent session. The main lane is the user's thread; each
// background task and the daily check-in get their own session and lane.
// A lane runs one Hermes run at a time; extra work queues behind it.
// ---------------------------------------------------------------------------

type RunKind = 'chat' | 'brief' | 'checkin' | 'decision' | 'task';

interface RunSpec {
  kind: RunKind;
  sessionId: string;
  input: string;
  taskId?: string | null;
  /** Buffer output and post nothing unless it has something to say (check-ins). */
  quiet?: boolean;
  /** Already retried once after unpausing a session Hermes froze on restart. */
  retried?: boolean;
}

interface ActiveRun {
  id: string; // Hermes run id ('' until accepted)
  spec: RunSpec;
  startedAt: number;
  activity: Item | null;
  assistant: Item | null; // current text segment
  text: string; // all text across segments
  pendingWs: string;
  steps: ToolStep[];
  lastSeq: number;
  cards: number; // cards posted by tools during this run
  briefs: number;
  finished: boolean;
  abort: AbortController;
  lastSave: number;
  /** Restart recovery: existing segment items to reuse while the event stream replays. */
  reuse: Item[];
  /** Main-thread turns that run long get mirrored into Tasks so the work is visible there. */
  fgTaskId: string | null;
}

interface Lane {
  sessionId: string;
  main: boolean;
  queue: RunSpec[];
  active: ActiveRun | null;
}

const lanes = new Map<string, Lane>();
let hermesStatus: AgentState['hermes'] = 'unknown';

export function mainSessionId(): string {
  let id = kv.get<string>('main_session', '');
  if (!id) {
    id = `duet-main-${newId()}`;
    kv.set('main_session', id);
  }
  return id;
}

function lane(sessionId: string): Lane {
  let l = lanes.get(sessionId);
  if (!l) {
    l = { sessionId, main: sessionId === mainSessionId(), queue: [], active: null };
    lanes.set(sessionId, l);
  }
  return l;
}

const mainLane = () => lane(mainSessionId());
const activeRuns = () => [...lanes.values()].map((l) => l.active).filter((r): r is ActiveRun => !!r && !r.finished);
const backgroundActive = () => [...lanes.values()].filter((l) => !l.main && l.active && l.active.spec.kind === 'task').length;

function persistQueues() {
  kv.set(
    'queues',
    [...lanes.values()].flatMap((l) => l.queue),
  );
}

function enqueue(spec: RunSpec) {
  const l = lane(spec.sessionId);
  l.queue.push(spec);
  persistQueues();
  pumpAll();
  broadcastAgent();
}

function pumpAll() {
  // While Hermes is unreachable, keep everything queued; the health watch pumps again when it's back.
  if (hermesStatus === 'down') return;
  // Main lane first so the user's thread never waits behind background work.
  const order = [...lanes.values()].sort((a, b) => Number(b.main) - Number(a.main));
  for (const l of order) {
    if (l.active || !l.queue.length) continue;
    const next = l.queue[0];
    if (next.kind === 'task' && backgroundActive() >= config.maxBackground) continue;
    l.queue.shift();
    persistQueues();
    launch(l, next);
  }
}

// ---------------------------------------------------------------------------
// Agent state broadcast
// ---------------------------------------------------------------------------

export function agentState(): AgentState {
  const m = mainLane();
  return {
    busy: !!m.active,
    current_run: m.active ? { id: m.active.id, kind: m.active.spec.kind, started_at: m.active.startedAt } : null,
    queued: m.queue.filter((q) => q.kind === 'chat').length,
    hermes: hermesStatus,
    background_running: backgroundActive(),
  };
}

let agentTimer: ReturnType<typeof setTimeout> | null = null;
function broadcastAgent() {
  if (agentTimer) return;
  agentTimer = setTimeout(() => {
    agentTimer = null;
    broadcast({ type: 'agent', agent: agentState() });
  }, 50);
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

function put(item: Item) {
  item.updated_at = Date.now();
  items.save(item);
  broadcast({ type: 'item', item });
  return item;
}

function newItem(kind: Item['kind'], fields: Partial<Item>): Item {
  const now = Date.now();
  return { id: newId(), kind, created_at: now, updated_at: now, ...fields };
}

function systemNote(text: string, taskId?: string | null) {
  return put(newItem('system', { text, task_id: taskId ?? null }));
}

function putTask(task: Task, sessionId?: string | null) {
  task.updated_at = Date.now();
  tasks.save(task, sessionId);
  broadcast({ type: 'task', task });
  return task;
}

/** Every page write goes out as an event, so the pinned pages in Make stay current. */
function putPage(page: Page) {
  pages.save(page);
  broadcast({ type: 'page', page });
  return page;
}

function firstLine(text: string, max = 140) {
  const line =
    text
      .replace(/[#*_`>]/g, '')
      .split('\n')
      .map((s) => s.trim())
      .find(Boolean) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function pushSafe(p: Parameters<typeof notify>[0], opts?: Parameters<typeof notify>[1]) {
  notify(p, opts).catch((e) => console.warn('[push]', e));
}

// Notes for the main session about things that happened elsewhere (tasks, check-ins).
function addContextNote(note: string) {
  const notes = kv.get<string[]>('context_notes', []);
  notes.push(note);
  kv.set('context_notes', notes.slice(-20));
}
function peekContextNotes(): string {
  const notes = kv.get<string[]>('context_notes', []);
  if (!notes.length) return '';
  return `(Context since your last turn. Don't repeat these back unless asked:\n${notes.map((n) => `- ${n}`).join('\n')})\n\n`;
}

// ---------------------------------------------------------------------------
// Running a turn
// ---------------------------------------------------------------------------

async function launch(l: Lane, spec: RunSpec) {
  const run: ActiveRun = {
    id: '',
    spec,
    startedAt: Date.now(),
    activity: null,
    assistant: null,
    text: '',
    pendingWs: '',
    steps: [],
    lastSeq: 0,
    cards: 0,
    briefs: 0,
    finished: false,
    abort: new AbortController(),
    lastSave: 0,
    reuse: [],
    fgTaskId: null,
  };
  l.active = run;
  broadcastAgent();

  // Notes are cleared only once Hermes accepts the run, so a failed start doesn't lose them.
  const notes = l.main && spec.kind === 'chat' ? peekContextNotes() : '';
  const input = notes + spec.input;

  if (spec.taskId) {
    const t = tasks.get(spec.taskId);
    if (t && (t.status === 'queued' || t.status === 'waiting')) putTask({ ...t, status: 'running' });
  }

  try {
    if (!hermes.hasKey()) throw new Error('no Hermes API key (set DUET_HERMES_KEY or API_SERVER_KEY in ~/.hermes/.env)');
    const r = await hermes.startRun({
      input,
      session_id: spec.sessionId,
      instructions: persona(settings.get(), { taskId: spec.taskId ?? undefined }),
      idempotencyKey: `duet-${newId()}`,
    });
    run.id = r.run_id;
    if (notes) kv.set('context_notes', []);
    if (l.main && spec.kind !== 'checkin') setTimeout(() => trackForeground(l, run), FG_AFTER_MS);
  } catch (e: any) {
    l.active = null;
    const busy = e instanceof HermesError && e.status === 429;
    const unreachable = !(e instanceof HermesError) && !String(e?.message).startsWith('no Hermes API key');
    const restarting = e instanceof HermesError && [502, 503, 504].includes(e.status);
    if (busy || unreachable || restarting) {
      // Transient: keep the work at the front of its lane instead of dropping it.
      l.queue.unshift(spec);
      persistQueues();
      if (busy) setTimeout(pumpAll, 5000);
      else {
        setHermesStatus('down');
        if (!offlineNoted && !spec.quiet) {
          offlineNoted = true;
          systemNote("Hermes isn't reachable right now. Your message is queued and goes out as soon as it's back.", spec.taskId);
        }
      }
      broadcastAgent();
      return;
    }
    const msg = `Couldn't start: ${e?.message ?? e}`;
    const t = spec.taskId ? tasks.get(spec.taskId) : null;
    if (t?.background && t.status !== 'cancelled' && t.status !== 'done') {
      // A background task that never started hands over like any other failure, with "Try again".
      announceEnd(putTask({ ...t, status: 'failed', result: msg, progress: '' }));
    } else {
      if (!spec.quiet) systemNote(msg, spec.taskId);
      if (spec.taskId) failTask(spec.taskId, msg);
    }
    broadcastAgent();
    setTimeout(pumpAll, 2000);
    return;
  }

  // Background task tool chatter stays in the Tasks tab, not the thread.
  if (!spec.quiet && spec.kind !== 'task') {
    run.activity = put(newItem('activity', { run_id: run.id, task_id: spec.taskId ?? null, activity: { run_id: run.id, status: 'running', steps: [] } }));
  }
  runs.start(run.id, spec.kind, spec.sessionId, spec.taskId ?? null, { spec, activityId: run.activity?.id ?? null });
  consume(l, run);
}

async function consume(l: Lane, run: ActiveRun) {
  let attempts = 0;
  const deadline = run.startedAt + config.runTimeoutMs;
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
    }
    if (run.finished) break;
    // The stream closed without a terminal event: ask for the run's status directly.
    try {
      const st = await hermes.getRun(run.id);
      const s = st.status;
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
    if (Date.now() > deadline) {
      hermes.stop(run.id).catch(() => {});
      finish(l, run, 'error', undefined, 'Timed out');
      break;
    }
    attempts++;
    await Bun.sleep(Math.min(15_000, 500 * 2 ** Math.min(attempts, 5)));
  }
}

const INTERRUPTED = 'interrupted: Hermes restarted mid-run';

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
  if (typeof ev.seq === 'number') run.lastSeq = Math.max(run.lastSeq, ev.seq);
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

const FG_AFTER_MS = 12_000;

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
  runs.meta(run.id, { spec: run.spec, activityId: run.activity?.id ?? null, fgTaskId: task.id });
}

function saveActivity(run: ActiveRun) {
  if (!run.activity) return;
  run.activity.activity = { ...run.activity.activity!, steps: run.steps };
  put(run.activity);
}

function appendText(run: ActiveRun, delta: string) {
  run.text += delta;
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
      : newItem('assistant', { run_id: run.id, task_id: run.spec.taskId ?? null, text: '', streaming: true });
    put(run.assistant);
  }
  run.assistant.text = (run.assistant.text ?? '') + delta;
  broadcast({ type: 'delta', item_id: run.assistant.id, text: delta });
  if (Date.now() - run.lastSave > 1000) {
    run.lastSave = Date.now();
    items.save(run.assistant);
  }
}

const MEDIA_RE = /MEDIA:\s*(\/[^\s`'")\]>]+)/g;
const stripMedia = (text: string) => text.replace(MEDIA_RE, '').replace(/\n{3,}/g, '\n\n').trim();

function closeSegment(run: ActiveRun) {
  run.pendingWs = '';
  const a = run.assistant;
  if (!a) return;
  run.assistant = null;
  const text = a.text ?? '';
  a.text = stripMedia(text);
  a.streaming = false;
  put(a);
  deliverMedia(run, text);
}

/** Hermes marks files it produced with `MEDIA:/abs/path`; hand each one over like deliver_file. */
function deliverMedia(run: ActiveRun, text: string) {
  for (const [, p] of text.matchAll(MEDIA_RE)) {
    try {
      deliverFile({ path: p, title: basename(p) }, { sessionId: run.spec.sessionId, taskId: run.spec.taskId ?? null });
    } catch (e: any) {
      console.warn('[media]', p, e?.message);
    }
  }
}

function finish(l: Lane, run: ActiveRun, status: 'done' | 'error' | 'stopped', output?: string, error?: string) {
  if (run.finished) return;
  run.finished = true;
  run.abort.abort();

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
  if (run.fgTaskId) {
    const t = tasks.get(run.fgTaskId);
    if (t && t.status === 'running') {
      const outcome: Task['status'] = status === 'done' ? 'done' : status === 'stopped' ? 'cancelled' : 'failed';
      const waiting = run.cards > 0 && items.pendingCards().some((c) => c.run_id === run.id);
      putTask({ ...t, status: outcome, progress: '', result: waiting ? 'Waiting on your answer in Chat.' : status === 'done' ? firstLine(run.text, 300) || 'Done.' : error ?? 'Stopped.' });
    }
  }

  const spec = run.spec;
  const text = run.text.trim();

  if (status === 'error' && /unknown_execution/.test(error ?? '') && !spec.retried) {
    // Hermes paused this session after a crash. Unpause it and retry this turn once.
    l.active = null;
    resolveUnknownFor(spec.sessionId).then((ok) => {
      if (ok) l.queue.unshift({ ...spec, retried: true });
      else if (!spec.quiet) systemNote('Hermes has this conversation paused and I could not unpause it. Try again in a minute.', spec.taskId);
      persistQueues();
      broadcastAgent();
      pumpAll();
    });
    return;
  }
  if (status === 'error' && error === INTERRUPTED && !spec.quiet && (spec.kind === 'chat' || spec.kind === 'task' || spec.kind === 'decision')) {
    const task = spec.taskId ? tasks.get(spec.taskId) : null;
    const what = spec.taskId ? task?.title : runTitle(spec);
    if (spec.taskId) failTask(spec.taskId, 'Interrupted: Hermes restarted mid-task.');
    const card = put(
      newItem('card', {
        task_id: spec.taskId ?? null,
        card: {
          type: 'choice',
          title: `Pick “${firstLine(what ?? 'that', 70)}” back up?`,
          body: resumeCardBody({ retried: spec.retried, steps: run.steps, taskSteps: task?.steps }),
          options: ['Pick it up', 'Leave it'],
          status: 'pending',
          resume: true,
          task_id: spec.taskId ?? undefined,
          session_id: spec.sessionId,
        },
      }),
    );
    pushSafe({ title: 'Work was interrupted', body: card.card!.title, card_id: card.id, tag: card.id, url: `/?card=${card.id}` });
    l.active = null;
    broadcastAgent();
    pumpAll();
    return;
  }

  if (spec.kind === 'checkin') {
    const { surfaced, stray } = checkinOutcome(run);
    if (surfaced) addContextNote('A check-in posted a "Heads up" brief to the user (see their thread).');
    if (stray) console.log(`[checkin] not posted (no brief): ${firstLine(stray)}`);
  } else if (spec.kind === 'task' || spec.taskId) {
    onTaskRunEnd(spec.taskId!, run, status, error);
  } else if (status === 'error') {
    systemNote(`Something went wrong${error ? `: ${error.replace(/[.\s]+$/, '')}` : ''}. Try again, or ask me differently.`);
  } else if (status === 'done' && l.main) {
    if (spec.kind === 'brief') {
      const { note, stray } = morningOutcome(run);
      if (note) systemNote(note);
      if (stray) console.log(`[brief] no card posted, not pushed: ${firstLine(stray)}`);
    } else if (!run.cards && text) {
      // notify() skips devices that have the app on screen, so this only reaches you when you've walked away.
      pushSafe({ title: 'Hermes Duet', body: firstLine(text), tag: 'reply' });
    }
  }

  l.active = null;
  broadcastAgent();
  pumpAll();
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
  } else if (waiting) {
    putTask({ ...t, status: 'waiting', progress: 'Waiting on you' });
    return;
  } else {
    const result = t.result || firstLine(stripMedia(run.text), 300) || 'Finished.';
    if (t.status === 'running' || t.status === 'queued' || t.status === 'waiting') {
      putTask({ ...t, status: 'done', result, progress: t.progress?.startsWith('· ') ? '' : t.progress, steps: t.steps.map((s) => ({ ...s, done: true })) });
    }
  }
  announceEnd(tasks.get(taskId)!);
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
    pushSafe({ title: `Done: ${final.title}`, body: firstLine(final.result ?? 'Finished.'), tag: `task-${taskId}`, url: `/?card=${card.id}` });
  } else {
    addContextNote(`Background task "${final.title}" (${taskId}) failed: ${final.result ?? ''}${filesNote} The user has its card in the thread${card.card!.retry ? ', with a "Try again" button' : ''}.`);
    pushSafe({ title: `Task failed: ${final.title}`, body: firstLine(final.result ?? ''), tag: `task-${taskId}`, url: `/?card=${card.id}` });
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

/** The page's latest refresh is still queued, running or waiting on the user. */
export function pageRefreshing(p: Page): boolean {
  const t = p.task_id ? tasks.get(p.task_id) : null;
  return !!t && ['queued', 'running', 'waiting'].includes(t.status);
}

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

/** save_page: create, update or remove a standing page. */
async function savePage(args: Record<string, unknown>, callerTask?: string | null): Promise<string> {
  const pageId = str(args.page_id, 64).trim();
  const existing = pageId ? pages.get(pageId) : null;
  if (pageId && !existing) throw new Error(`no page ${pageId}`);
  if (args.remove === true) {
    if (!existing) throw new Error('remove needs page_id');
    await removePage(existing.id, callerTask);
    return `Page ${existing.id} ("${existing.title}") removed. It no longer refreshes; its files stay in the Make tab.`;
  }
  const input = pageInput(args, existing);
  if (!files.get(input.file_id)) throw new Error(`no file ${input.file_id}; pass the id deliver_file returned`);
  const s = settings.get();
  const at = refreshTime(s.brief_time);
  if (existing) {
    putPage({ ...existing, ...input });
    return `Page ${existing.id} ("${input.title}") updated. It still refreshes every day at ${at}.`;
  }
  if (pages.all().length >= MAX_PAGES) throw new Error(`there are already ${MAX_PAGES} standing pages; update or remove one first`);
  const now = Date.now();
  // The first version was just built, so today counts as refreshed.
  const page = putPage({ id: newId(), ...input, refreshed_on: localParts(s.timezone).date, refreshed_at: now, created_at: now, updated_at: now });
  return `Saved standing page ${page.id} ("${page.title}"). It refreshes every day at ${at}, 30 minutes before the morning brief, as a background task that delivers the new version in its place. Use page_id="${page.id}" to change it later, or with remove: true to stop it.`;
}

/** Post the task's handover card, or refresh it in place if this task already handed over once. */
function handOver(t: Task): Item {
  const card = handoverCard(t, files.all());
  const existing = t.handover_id ? items.get(t.handover_id) : null;
  if (existing) return put({ ...existing, card });
  const item = put(newItem('card', { card, task_id: t.id }));
  putTask({ ...t, handover_id: item.id });
  return item;
}

function failTask(taskId: string, reason: string) {
  const t = tasks.get(taskId);
  if (!t || t.status === 'cancelled' || t.status === 'done') return;
  putTask({ ...t, status: 'failed', result: reason, progress: '' });
  addContextNote(`Background task "${t.title}" (${taskId}) failed: ${reason}`);
  pushSafe({ title: `Task failed: ${t.title}`, body: firstLine(reason), tag: `task-${taskId}` });
}

// ---------------------------------------------------------------------------
// Hermes-native approval / clarify prompts (only when approvals are enabled)
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
  const item = put(newItem('card', { card, run_id: run.id, task_id: run.spec.taskId ?? null }));
  run.cards++;
  if (run.spec.taskId) markTaskWaiting(run.spec.taskId);
  pushSafe(
    kind === 'approval'
      ? approvalPush(item)
      : { title: 'Quick question', body: card.title, card_id: item.id, approval: false, tag: item.id, url: `/?card=${item.id}` },
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

function markTaskWaiting(taskId: string) {
  const t = tasks.get(taskId);
  if (t && t.status !== 'done' && t.status !== 'cancelled' && t.status !== 'failed') putTask({ ...t, status: 'waiting', progress: 'Waiting on you' });
}

// ---------------------------------------------------------------------------
// Public actions (HTTP API)
// ---------------------------------------------------------------------------

/** `input` is what the agent receives when it differs from what the thread shows (a brief entry's draft chip). */
export function submitUser(text: string, input?: string): Item {
  const shown = text.trim();
  if (!shown) throw new Error('empty message');
  const t = input?.trim() || shown;
  const item = put(newItem('user', { text: shown }));
  const m = mainLane();
  const active = m.active;
  // Mid-run messages steer the live turn (Hermes re-queues the steer as the next turn if it lands too late).
  if (active && active.id && !active.finished && m.queue.length === 0) {
    hermes
      .steer(active.id, t)
      .then((r) => {
        if (!r?.accepted) throw new Error('not accepted');
      })
      .catch(() => enqueue({ kind: 'chat', sessionId: m.sessionId, input: t }));
  } else {
    enqueue({ kind: 'chat', sessionId: m.sessionId, input: t });
  }
  return item;
}

export function actOnCard(id: string, action: string, value?: string): Item {
  const item = items.get(id);
  if (!item || item.kind !== 'card' || !item.card) throw new Error('card not found');
  const c = item.card;
  if (c.type === 'handover' && action === 'retry') return retryTask(item);
  if (c.type === 'brief' && action === 'use_draft') {
    const d = useDraft(c, item.id, value);
    const updated = put({ ...item, card: { ...c, entries: d.entries } });
    submitUser(d.shown, d.prompt);
    return updated;
  }
  if (c.status !== 'pending') throw new Error(`already ${c.status}`);
  let approved: boolean | undefined;
  let answer: string | undefined;
  let edits: { draft: string; edited: true } | undefined;
  if (c.type === 'approval') {
    const d = approvalDecision(c, action, value);
    approved = d.approved;
    if (d.draft) edits = { draft: d.draft, edited: true };
  } else if (c.type === 'choice') {
    const opts = c.options?.length ? c.options : ['Yes', 'No'];
    if (action !== 'choose' || !value || !opts.includes(value)) throw new Error('invalid choice');
    answer = value;
  } else {
    throw new Error('this card takes no action');
  }

  item.card = {
    ...c,
    ...edits,
    status: c.type === 'approval' ? (approved ? 'approved' : 'declined') : 'answered',
    decision: answer ?? (approved ? 'approve' : 'decline'),
    decided_at: Date.now(),
  };
  put(item);

  if (c.hermes) {
    const h = c.hermes;
    const p =
      h.kind === 'approval'
        ? hermes.approve(h.run_id, h.request_id, h.generation, approved ? 'once' : 'deny')
        : hermes.clarify(h.run_id, h.request_id, h.generation, answer!);
    p.catch((e) => systemNote(`That request had already expired (${e?.message ?? e}).`, c.task_id));
    if (c.task_id) {
      const t = tasks.get(c.task_id);
      if (t && t.status === 'waiting') putTask({ ...t, status: 'running', progress: '' });
    }
  } else if (c.resume && answer !== 'Pick it up') {
    // Leaving interrupted work alone needs no agent turn.
    if (c.task_id) {
      const t = tasks.get(c.task_id);
      if (t && t.status !== 'done') putTask({ ...t, status: 'cancelled', progress: '' });
    }
  } else {
    const sessionId = c.session_id ?? (c.task_id ? tasks.sessionOf(c.task_id) : null) ?? mainSessionId();
    if (c.task_id) {
      const t = tasks.get(c.task_id);
      if (t && (t.status === 'waiting' || (c.resume && t.status === 'failed'))) putTask({ ...t, status: 'queued', progress: '' });
    }
    enqueue({ kind: c.task_id ? 'task' : 'decision', sessionId, taskId: c.task_id ?? null, input: decisionPrompt(item, { approved, answer }) });
  }
  return item;
}

/**
 * "Try again" on a failed handover card: the same task restarts from its stored instructions in a fresh Hermes
 * session (the old one ended in the failure), and finishing posts a new handover card at the bottom of the thread.
 */
function retryTask(item: Item): Item {
  const c = item.card!;
  const t = c.task_id ? tasks.get(c.task_id) : null;
  if (!c.failed || !t) throw new Error('this card takes no action');
  if (c.decision) throw new Error('already tried again');
  if (t.status !== 'failed' || !t.instructions) throw new Error('this task cannot be restarted');
  const previous = t.result;
  const now = Date.now();
  const task: Task = {
    ...t,
    status: 'queued',
    progress: '',
    result: undefined,
    follow_ups: undefined,
    changed: undefined,
    handover_id: undefined,
    steps: t.steps.map((s) => ({ ...s, done: false })),
    retried_at: now,
  };
  const sessionId = `duet-task-${t.id}-${newId()}`;
  putTask(task, sessionId);
  enqueue({ kind: 'task', sessionId, taskId: t.id, input: taskPrompt(task, t.instructions, previous) });
  return put({ ...item, card: { ...c, decision: 'Tried again', decided_at: now } });
}

export async function stopMain() {
  const a = mainLane().active;
  if (a?.id) await hermes.stop(a.id).catch(() => {});
}

export async function cancelTask(id: string) {
  const t = tasks.get(id);
  if (!t) throw new Error('task not found');
  if (['done', 'failed', 'cancelled'].includes(t.status)) return;
  putTask({ ...t, status: 'cancelled', progress: '' });
  if (!t.background) {
    // A mirrored main-thread turn: cancelling it means stopping that turn.
    const a = mainLane().active;
    if (a?.fgTaskId === id && a.id) await hermes.stop(a.id).catch(() => {});
    return;
  }
  const sid = tasks.sessionOf(id);
  const l = sid ? lanes.get(sid) : undefined;
  if (l) {
    l.queue = [];
    persistQueues();
    if (l.active?.id) await hermes.stop(l.active.id).catch(() => {});
  }
  for (const c of items.pendingCards()) {
    if (c.card?.task_id === id) {
      c.card = { ...c.card, status: 'expired', decided_at: Date.now() };
      put(c);
    }
  }
}

export function runBrief(source: 'scheduled' | 'manual') {
  const m = mainLane();
  if (m.queue.some((q) => q.kind === 'brief') || m.active?.spec.kind === 'brief') return;
  const s = settings.get();
  const dayAgo = Date.now() - 86400_000;
  const today = localParts(s.timezone).date;
  enqueue({
    kind: 'brief',
    sessionId: m.sessionId,
    input: briefPrompt(s, {
      pending: items.pendingCards(),
      tasks: tasks.recent().filter((t) => ['queued', 'running', 'waiting'].includes(t.status) || t.updated_at > dayAgo),
      pages: pages.all().map((p) => pageBriefLine(p, today, pageRefreshing(p))),
    }),
  });
  console.log(`[brief] queued (${source})`);
}

export function runCheckin() {
  const s = settings.get();
  const today = localParts(s.timezone).date;
  const sid = `duet-checkin-${today}`;
  const l = lane(sid);
  if (l.active || l.queue.length) return;
  const since = kv.get<string>('checkin_since_label', '') || `this morning's brief (${s.brief_time})`;
  kv.set('checkin_since_label', new Date().toLocaleTimeString('en-US', { timeZone: s.timezone, hour: 'numeric', minute: '2-digit' }));
  enqueue({
    kind: 'checkin',
    sessionId: sid,
    quiet: true,
    input: checkinPrompt(s, { since, pending: items.pendingCards(), tasks: tasks.recent().filter((t) => ['running', 'waiting', 'failed'].includes(t.status)) }),
  });
}

// ---------------------------------------------------------------------------
// Tools (called by the MCP shim through the internal API)
// ---------------------------------------------------------------------------

interface Origin {
  sessionId: string;
  taskId: string | null;
  run?: ActiveRun;
}

/** Work out which session a tool call came from: explicit task_id, else the run that just started that tool. */
async function originOf(tool: string, taskId: unknown): Promise<Origin> {
  if (typeof taskId === 'string' && taskId) {
    const sid = tasks.sessionOf(taskId);
    if (sid) return { sessionId: sid, taskId, run: lanes.get(sid)?.active ?? undefined };
  }
  for (let i = 0; i < 8; i++) {
    const hits = activeRuns().filter((r) => r.steps.some((s) => s.status === 'running' && s.name.endsWith(tool)));
    if (hits.length === 1) return { sessionId: hits[0].spec.sessionId, taskId: hits[0].spec.taskId ?? null, run: hits[0] };
    if (hits.length > 1) break;
    await Bun.sleep(100);
  }
  const act = activeRuns();
  if (act.length === 1) return { sessionId: act[0].spec.sessionId, taskId: act[0].spec.taskId ?? null, run: act[0] };
  const m = mainLane();
  return { sessionId: m.sessionId, taskId: null, run: m.active ?? undefined };
}

const str = (v: unknown, max = 4000) => (typeof v === 'string' ? v.slice(0, max) : v === undefined || v === null ? '' : String(v).slice(0, max));
const req = (v: unknown, name: string, max?: number) => {
  const s = str(v, max).trim();
  if (!s) throw new Error(`missing ${name}`);
  return s;
};

function postCard(card: CardData, o: Origin): Item {
  if (o.run) {
    closeSegment(o.run);
    o.run.cards++;
  }
  return put(newItem('card', { card: { ...card, task_id: o.taskId ?? undefined, session_id: o.sessionId }, run_id: o.run?.id ?? null, task_id: o.taskId }));
}

export async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  kv.set('last_tool_call_at', Date.now());
  const o = await originOf(name, args.task_id);
  switch (name) {
    case 'request_approval': {
      const item = postCard(
        {
          type: 'approval',
          title: req(args.title, 'title', 140),
          body: str(args.summary, 8000),
          draft: str(args.draft, DRAFT_MAX).trim() || undefined,
          action_label: str(args.action_label, 30) || undefined,
          status: 'pending',
        },
        o,
      );
      if (o.taskId) markTaskWaiting(o.taskId);
      pushSafe(approvalPush(item), { ignoreQuiet: true });
      return `Approval card ${item.id} is on the user's phone. They have NOT approved yet. Do not take the action now. Tell them in one short line what you're waiting on, then end your turn. You'll get "[approval ${item.id}] APPROVED" or "NOT NOW" as a new message.`;
    }
    case 'ask': {
      const options = Array.isArray(args.options) ? args.options.map((x) => str(x, 60).trim()).filter(Boolean).slice(0, 4) : [];
      if (options.length < 2) throw new Error('ask needs 2-4 options');
      const item = postCard({ type: 'choice', title: req(args.question, 'question', 200), body: str(args.context, 4000) || undefined, options, status: 'pending' }, o);
      if (o.taskId) markTaskWaiting(o.taskId);
      pushSafe({ title: 'Quick question', body: item.card!.title, card_id: item.id, tag: item.id, url: `/?card=${item.id}` });
      return `Question card ${item.id} posted. End your turn now; the answer arrives as "[answer ${item.id}] …".`;
    }
    case 'post_brief': {
      const morning = o.run?.spec.kind === 'brief';
      const { entries, watching, demoted } = briefCard(args, { morning });
      const s = settings.get();
      const item = postCard(
        {
          type: 'brief',
          title: briefTitle(req(args.title, 'title', 140), entries.length),
          body: str(args.summary, 2000) || undefined,
          entries,
          watching: watching.length ? watching : undefined,
          status: 'info',
          updated_label: `Updated ${new Date().toLocaleTimeString('en-US', { timeZone: s.timezone, hour: 'numeric', minute: '2-digit' })}`,
        },
        o,
      );
      if (o.run) o.run.briefs++;
      // A quiet morning (Watching only) is posted but not pushed: nothing needs the user, so nothing interrupts them.
      if (!entries.length) return `Brief card ${item.id} posted with nothing to decide. It was not pushed.`;
      pushSafe(
        {
          title: item.card!.title,
          // Decisions only: Watching never notifies.
          body: [...entries.slice(0, 3).map((e) => `• ${e.title}`), ...(entries.length > 3 ? [`+${entries.length - 3} more`] : [])].join('\n'),
          tag: morning ? 'brief' : 'checkin',
          url: `/?card=${item.id}`,
        },
        { ignoreQuiet: morning },
      );
      return demoted.length
        ? `Brief card ${item.id} posted with the top ${entries.length} decisions. Moved to Watching (drafts dropped): ${demoted.join('; ')}.`
        : `Brief card ${item.id} posted.`;
    }
    case 'post_card': {
      const type = str(args.type) as CardData['type'];
      if (!['checklist', 'metrics', 'note'].includes(type)) throw new Error('type must be checklist, metrics or note');
      const patch: Partial<CardData> = { type, title: req(args.title, 'title', 140) };
      if (args.body !== undefined) patch.body = str(args.body, 8000);
      if (Array.isArray(args.checklist)) patch.checklist = args.checklist.slice(0, 200).map((c: any) => ({ text: str(c?.text, 300), done: !!c?.done }));
      if (Array.isArray(args.metrics))
        patch.metrics = args.metrics.slice(0, 24).map((m: any) => ({
          label: str(m?.label, 60),
          value: str(m?.value, 40),
          delta: str(m?.delta, 30) || undefined,
          tone: ['good', 'bad', 'neutral'].includes(m?.tone) ? m.tone : undefined,
        }));
      const existing = typeof args.card_id === 'string' ? items.get(args.card_id) : null;
      if (existing?.kind === 'card' && existing.card && ['checklist', 'metrics', 'note'].includes(existing.card.type)) {
        existing.card = { ...existing.card, ...patch, updated_label: undefined };
        put(existing);
        return `Updated card ${existing.id}.`;
      }
      const item = postCard({ ...(patch as CardData), status: 'info' }, o);
      return `Card ${item.id} posted. Pass card_id="${item.id}" to update it in place.`;
    }
    case 'deliver_file': {
      const entry = deliverFile({ path: req(args.path, 'path', 2000), title: req(args.title, 'title', 140), summary: str(args.summary, 1000) }, o);
      const page = pageOf(o.taskId);
      if (page) {
        return page.file_id === entry.id
          ? `Delivered "${entry.title}" (file ${entry.id}). It is now the current version of the page "${page.title}".`
          : `Delivered "${entry.title}" (file ${entry.id}), but it is not the same kind of file as the page "${page.title}", so the page still shows its previous version.`;
      }
      return backgroundTask(o.taskId)
        ? `Delivered "${entry.title}" (file ${entry.id}). It is in the Make tab now and goes on this task's handover card when you finish.`
        : `Delivered "${entry.title}" (file ${entry.id}). The user sees it in the thread and the Make tab.`;
    }
    case 'start_task': {
      const t = startTask(req(args.title, 'title', 120), req(args.instructions, 'instructions', 20_000), Array.isArray(args.steps) ? args.steps.map((s) => str(s, 200)) : []);
      return `Started background task ${t.id} ("${t.title}"). It's in the user's Tasks tab. Tell them in one line, then end your turn. When it finishes, the user gets a handover card in the thread, and a note with its result reaches you with their next message.`;
    }
    case 'save_page':
      return savePage(args, o.taskId);
    case 'update_task': {
      const id = req(args.task_id, 'task_id', 64);
      const t = tasks.get(id);
      if (!t) throw new Error(`no task ${id}`);
      if (t.status === 'cancelled') return 'This task was cancelled by the user. Stop working on it and end your turn.';
      const next: Task = { ...t };
      if (args.progress !== undefined) next.progress = str(args.progress, 300);
      if (Array.isArray(args.steps)) next.steps = args.steps.slice(0, 60).map((s: any): TaskStep => ({ text: str(s?.text ?? s, 200), done: !!s?.done }));
      if (args.result !== undefined) next.result = str(args.result, 2000);
      if (args.changed !== undefined) next.changed = str(args.changed, 300);
      if (args.follow_ups !== undefined) next.follow_ups = followUps(args.follow_ups);
      if (typeof args.status === 'string' && ['running', 'waiting', 'done', 'failed'].includes(args.status)) next.status = args.status as Task['status'];
      putTask(next);
      return `Task ${id} updated.`;
    }
    case 'notify': {
      const sent = await notify({ title: req(args.title, 'title', 80), body: str(args.body, 300), tag: 'agent' });
      return sent ? 'Notification sent.' : 'No notification sent (quiet hours, or no device has notifications on). The item is in the thread.';
    }
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

// Paths the agent may never hand to the phone, even by accident.
const DENY = /(^|\/)(\.ssh|\.gnupg|\.aws|\.config\/gcloud|Keychains)(\/|$)|(^|\/)\.env(\.|$)|auth\.json$|credentials|\.pem$|\.p12$|\.key$|id_(rsa|ed25519|ecdsa)|internal\.token$|duet\.db/i;
const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
};

function deliverFile(a: { path: string; title: string; summary?: string }, o: Origin): FileEntry {
  if (!isAbsolute(a.path)) throw new Error('path must be absolute');
  const src = resolve(a.path);
  if (DENY.test(src)) throw new Error('that path looks like secrets; refusing to deliver it');
  const st = statSync(src);
  if (!st.isFile()) throw new Error('not a file');
  if (st.size > 50 * 1024 * 1024) throw new Error('file is over 50 MB');
  const id = newId();
  const name = basename(src);
  const dir = join(config.dataDir, 'files', id);
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, name);
  copyFileSync(src, dest);
  const entry: FileEntry = {
    id,
    title: a.title,
    name,
    mime: MIME[extname(name).toLowerCase()] ?? 'application/octet-stream',
    size: st.size,
    task_id: o.taskId,
    created_at: Date.now(),
  };
  files.add(entry, dest);
  broadcast({ type: 'file', file: entry });
  // A page refresh's file replaces the page's current version, but only if it's the same kind of file, so a
  // stray screenshot or CSV from the same run can't take the dashboard's place.
  const page = pageOf(o.taskId);
  const current = page ? files.get(page.file_id) : null;
  if (page && (!current || current.entry.mime === entry.mime)) putPage({ ...page, file_id: id, refreshed_at: entry.created_at });
  // A background task's files arrive together on its handover card instead of one card each mid-run.
  if (!backgroundTask(o.taskId)) postCard({ type: 'file', title: a.title, body: a.summary || undefined, file_id: id, status: 'info' }, o);
  return entry;
}

const backgroundTask = (taskId: string | null) => !!taskId && !!tasks.get(taskId)?.background;
const pageOf = (taskId: string | null) => {
  const pageId = taskId ? tasks.get(taskId)?.page_id : undefined;
  return pageId ? pages.get(pageId) : null;
};

function startTask(title: string, instructions: string, steps: string[], pageId?: string): Task {
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
  };
  const sessionId = `duet-task-${task.id}`;
  putTask(task, sessionId);
  enqueue({ kind: 'task', sessionId, taskId: task.id, input: taskPrompt(task, instructions) });
  return task;
}

// ---------------------------------------------------------------------------
// Startup: Hermes health, restart recovery
// ---------------------------------------------------------------------------

let offlineNoted = false;

function setHermesStatus(next: AgentState['hermes']) {
  if (next === hermesStatus) return;
  hermesStatus = next;
  if (next === 'ok') offlineNoted = false;
  broadcastAgent();
  if (next === 'ok') pumpAll();
}

export function startHermesWatch() {
  const check = async () => setHermesStatus((await hermes.health()) ? 'ok' : 'down');
  check();
  setInterval(check, 20_000);
}

export function recoverOrphans() {
  // Queued-but-unstarted work survives restarts.
  for (const spec of kv.get<RunSpec[]>('queues', [])) lane(spec.sessionId).queue.push(spec);

  for (const row of runs.orphaned()) {
    const meta = row.meta ? JSON.parse(row.meta) : {};
    const spec: RunSpec = meta.spec ?? { kind: row.kind as RunKind, sessionId: row.session_id, input: '', taskId: row.task_id };
    const l = lane(spec.sessionId);
    if (l.active) {
      runs.end(row.id, 'error', 'superseded');
      continue;
    }
    const activity = meta.activityId ? items.get(meta.activityId) : null;
    const run: ActiveRun = {
      id: row.id,
      spec,
      startedAt: row.started_at,
      activity,
      assistant: null,
      text: '',
      pendingWs: '',
      // Seeded from the saved activity so a run Hermes no longer knows still shows (and reports) its steps;
      // a replay that does arrive matches them by tool_call_id instead of adding duplicates.
      steps: (activity?.activity?.steps ?? []).map((s) => ({ ...s })),
      lastSeq: 0,
      cards: 0,
      briefs: 0,
      finished: false,
      abort: new AbortController(),
      lastSave: 0,
      // Replay from the start, reusing this run's existing text segments in order.
      reuse: segmentsOf(row.id),
      fgTaskId: meta.fgTaskId ?? null,
    };
    l.active = run;
    console.log(`[recover] reattaching run ${row.id} (${spec.kind})`);
    consume(l, run);
  }
  pumpAll();
}

function segmentsOf(runId: string): Item[] {
  return items
    .latest(400)
    .items.filter((i) => i.run_id === runId && i.kind === 'assistant')
    .sort((a, b) => a.created_at - b.created_at);
}

