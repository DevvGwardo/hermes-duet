import type { AgentState, FileEntry, Item, Page, Routine, Task } from '../../shared/types';
import { PROMPT_ENDED, deadPrompts } from '../approval';
import { broadcast } from '../bus';
import { connectorBrief, listConnectors } from '../connectors';
import { type ChannelRow, channels, files, items, kv, newId, pages, routines, runs, tasks, tx } from '../db';
import { UserError } from '../errors';
import { handoverCard } from '../handover';
import { notify } from '../push';
import { GENERAL_CHANNEL } from '../schema';
import type { Steer } from '../steer';
import { withConfirmed, withReopened } from '../taskstatus';

// ---------------------------------------------------------------------------
// Shared lane & run types and mutable process state
// ---------------------------------------------------------------------------

export type RunKind = 'chat' | 'brief' | 'checkin' | 'decision' | 'task';

export interface RunSpec {
  kind: RunKind;
  sessionId: string;
  /** Which channel the run's items belong to; absent means the general channel (briefs, check-ins, tasks). */
  channelId?: string;
  /** Briefs and check-ins queue with '' and get their prompt in `launch`, from the state at that moment. */
  input: string;
  /** Check-ins: when the previous one ran, for "anything new since …". */
  since?: string;
  /** Briefs: the scheduler queued it (not "Run it now"), so it may wait for page refreshes after an outage. */
  scheduled?: boolean;
  taskId?: string | null;
  /** Buffer output and post nothing unless it has something to say (check-ins). */
  quiet?: boolean;
  /** Already retried once after unpausing a session Hermes froze on restart. */
  retried?: boolean;
  /** A page refresh Duet already started over once after Hermes restarted mid-run. */
  restarted?: boolean;
  /**
   * Idempotency key for `POST /v1/runs`, minted once per spec and kept across retries and restarts. Regenerating it
   * per attempt meant a start that timed out but was actually admitted came back as a second agent run whose id
   * Duet never learned: unstoppable, untracked, but still able to post cards.
   */
  idem?: string;
}

export interface ActiveRun {
  id: string; // Hermes run id ('' until accepted)
  spec: RunSpec;
  startedAt: number;
  activity: Item | null;
  assistant: Item | null; // current text segment
  text: string; // all text across segments
  segText: string; // text of the segment still being streamed
  lastText: string; // the last segment that closed with something in it
  pendingWs: string;
  steps: NonNullable<Item['activity']>['steps'];
  lastSeq: number;
  cards: number; // cards posted by tools during this run
  briefs: number;
  finished: boolean;
  abort: AbortController;
  lastSave: number;
  /** When this run's meta was last written, so a long run doesn't rewrite it on every event. */
  metaAt: number;
  /** True when segment text was flushed before `lastSeq` updated, so `onEvent` syncs run meta right after. */
  dirtyMeta: boolean;
  /** The watchdog's stop was never acknowledged: the run may still be going on the Hermes side, so a retry could double it. */
  stopUnconfirmed: boolean;
  /** Restart recovery: existing segment items to reuse while the event stream replays. */
  reuse: Item[];
  /** Main-thread turns that run long get mirrored into Tasks so the work is visible there. */
  fgTaskId: string | null;
  /** Chat messages steered into this run, matched against `pending_steer` when it ends. */
  steers: Steer[];
  /** `pending_steer` from the terminal event or status: steer text Hermes never delivered, left for us to replay. */
  leftoverSteer: string;
  /** When the run last sent an event (keepalives don't count), for the hung-run watchdog. */
  lastEventAt: number;
  /**
   * Stop tapped before Hermes answered with a `run_id`. There is nothing to cancel yet, so the request is remembered
   * and honoured the moment the id arrives — otherwise the agent keeps working on a turn the user believes is over.
   */
  stopRequested: boolean;
}

export interface Lane {
  sessionId: string;
  main: boolean;
  queue: RunSpec[];
  active: ActiveRun | null;
}

export interface Origin {
  sessionId: string;
  taskId: string | null;
  /** The channel this run's cards and files belong to. */
  channelId: string;
  run?: ActiveRun;
}

export const WATCHDOG_MS = 60_000;
export const INTERRUPTED = 'interrupted: Hermes restarted mid-run';
export const FG_AFTER_MS = 12_000;
/** The same text cap as a chat message, wherever the words arrive from. */
export const TASK_MESSAGE_MAX = 20_000;
/** `task_id` a turn in the main conversation passes when several turns are live and a tool call is refused. */
export const MAIN_ORIGIN = 'main';
/** `task_id` prefix a non-task topic-channel turn passes (`channel:<id>`) to disambiguate itself. */
export const CHANNEL_ORIGIN_PREFIX = 'channel:';

export const lanes = new Map<string, Lane>();

export const runtime = {
  hermesStatus: 'unknown' as AgentState['hermes'],
  // When Hermes last came back from 'down', for the post-outage brief hold.
  hermesBackAt: null as number | null,
  briefTimer: null as ReturnType<typeof setTimeout> | null,
  agentTimer: null as ReturnType<typeof setTimeout> | null,
  /**
   * What the agent is told it can reach natively. Probing connectors runs AppleScript, so this is warmed in the
   * background (startConnectorWatch) and never awaited by a turn: an empty string simply means "not checked yet".
   */
  connectorLines: '',
  lastManualBriefAt: 0,
  offlineNoted: false,
};

export function mainSessionId(): string {
  return channels.general().session_id;
}

/** Return `channelId` if it refers to an existing, unarchived channel; otherwise fall back to #general. */
export function liveChannelId(channelId?: string | null): string {
  const ch = channelId ? channels.get(channelId) : null;
  return ch && ch.archived_at == null ? ch.id : channels.general().id;
}

/**
 * The channel a run's items belong to. A background task's session is not a channel, so its result lands in the
 * channel it was started from; everything else (briefs, check-ins, chat) says which channel it is.
 */
export function channelOfSpec(spec: RunSpec): string {
  return liveChannelId(spec.channelId ?? channels.forTask(spec.taskId ? tasks.get(spec.taskId) : null));
}

/** Resolve a channel that still exists and is not archived. */
export function liveChannel(channelId?: string | null): ChannelRow {
  const ch = channelId ? channels.get(channelId) : channels.general();
  if (!ch || ch.archived_at != null) throw new UserError('no such channel', 404);
  return ch;
}

export function channelForFile(file: FileEntry): string {
  return liveChannelId(file.task_id ? channels.forTask(tasks.get(file.task_id)) : GENERAL_CHANNEL);
}

export function lane(sessionId: string): Lane {
  let l = lanes.get(sessionId);
  if (!l) {
    l = { sessionId, main: sessionId === mainSessionId(), queue: [], active: null };
    lanes.set(sessionId, l);
  }
  return l;
}

export const mainLane = () => lane(mainSessionId());

/** A non-main lane with nothing running and nothing queued holds nothing; `lane()` recreates it on demand. */
export function dropIdleLane(l: Lane) {
  if (!l.main && !l.active && !l.queue.length) lanes.delete(l.sessionId);
}

export const activeRuns = () => [...lanes.values()].map((l) => l.active).filter((r): r is ActiveRun => !!r && !r.finished);
export const backgroundActive = () => [...lanes.values()].filter((l) => !l.main && l.active && l.active.spec.kind === 'task').length;

export function persistQueues() {
  kv.set(
    'queues',
    [...lanes.values()].flatMap((l) => l.queue),
  );
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
    hermes: runtime.hermesStatus,
    background_running: backgroundActive(),
  };
}

export function broadcastAgent() {
  if (runtime.agentTimer) return;
  runtime.agentTimer = setTimeout(() => {
    runtime.agentTimer = null;
    broadcast({ type: 'agent', agent: agentState() });
  }, 50);
}

/**
 * End every live run's event stream on shutdown without finishing it: the rows stay 'running', so the next boot's
 * recoverOrphans reattaches them exactly as a crash would. Called by the process signal handler before the database
 * is closed.
 */
export function abortActiveRuns() {
  for (const l of lanes.values()) {
    try {
      l.active?.abort.abort();
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// Items, tasks, pages, routines & context notes
// ---------------------------------------------------------------------------

export function put(item: Item) {
  item.updated_at = Date.now();
  items.save(item);
  broadcast({ type: 'item', item });
  return item;
}

export function newItem(kind: Item['kind'], fields: Partial<Item>): Item {
  const now = Date.now();
  return { id: newId(), kind, channel_id: GENERAL_CHANNEL, created_at: now, updated_at: now, ...fields };
}

export function systemNote(text: string, taskId?: string | null, channelId: string = GENERAL_CHANNEL) {
  return put(newItem('system', { text, task_id: taskId ?? null, channel_id: channelId }));
}

export function putTask(task: Task, sessionId?: string | null) {
  task.updated_at = Date.now();
  tasks.save(task, sessionId);
  broadcast({ type: 'task', task });
  return task;
}

/** Every page write goes out as an event, so the pinned pages in Make stay current. */
export function putPage(page: Page) {
  pages.save(page);
  broadcast({ type: 'page', page });
  return page;
}

/** Store a routine and tell every open app about it. */
export function putRoutine(routine: Routine): Routine {
  routine.updated_at = Date.now();
  routines.save(routine);
  broadcast({ type: 'routine', routine });
  return routine;
}

/** Remove a routine and tell every open app it is gone. */
export function removeRoutine(id: string): boolean {
  if (!routines.get(id)) return false;
  routines.remove(id);
  broadcast({ type: 'routine_removed', id });
  return true;
}

export function firstLine(text: string, max = 140) {
  const line =
    text
      .replace(/[#*_`>]/g, '')
      .split('\n')
      .map((s) => s.trim())
      .find(Boolean) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function cardUrl(cardId: string, channelId?: string | null): string {
  return channelId ? `/?card=${cardId}&channel=${encodeURIComponent(channelId)}` : `/?card=${cardId}`;
}

export function pushSafe(p: Parameters<typeof notify>[0], opts?: Parameters<typeof notify>[1]) {
  notify(p, opts).catch((e) => console.warn('[push]', e));
}

export function startConnectorWatch() {
  const load = () =>
    listConnectors()
      .then((list) => {
        runtime.connectorLines = connectorBrief(list);
      })
      .catch(() => {});
  load();
  setInterval(load, 10 * 60_000);
}

/** Notes for the main session about things that happened elsewhere (tasks, check-ins). */
export function addContextNote(note: string) {
  const notes = kv.get<string[]>('context_notes', []);
  notes.push(note);
  kv.set('context_notes', notes.slice(-20));
}

export function formatContextNotes(notes: string[]): string {
  if (!notes.length) return '';
  return `(Context since your last turn. Don't repeat these back unless asked:\n${notes.map((n) => `- ${n}`).join('\n')})\n\n`;
}

export function consumeContextNotes(consumed: string[]) {
  const cur = kv.get<string[]>('context_notes', []);
  if (!cur.length) return;
  // Drop only the notes snapshotted before startRun so notes appended concurrently aren't lost.
  let drop = 0;
  for (let len = Math.min(consumed.length, cur.length); len >= 1; len--) {
    const offset = consumed.length - len;
    let match = true;
    for (let i = 0; i < len; i++) {
      if (cur[i] !== consumed[offset + i]) {
        match = false;
        break;
      }
    }
    if (match) {
      drop = len;
      break;
    }
  }
  kv.set('context_notes', cur.slice(drop));
}

/**
 * What a restart needs to pick this run up where it left off: its spec, the messages steered into it that Hermes may
 * still return undelivered, and how far it got. Written throttled from `onEvent` and whenever a steer changes, so a
 * crash or gateway restart replays from the last second rather than from the beginning of the turn.
 */
export function runMeta(run: ActiveRun) {
  return {
    spec: run.spec,
    activityId: run.activity?.id ?? null,
    fgTaskId: run.fgTaskId,
    steers: run.steers,
    lastSeq: run.lastSeq,
    lastEventAt: run.lastEventAt,
    cards: run.cards,
    briefs: run.briefs,
  };
}

export function saveRunMeta(run: ActiveRun) {
  if (!run.id) return;
  runs.meta(run.id, runMeta(run));
}

export function segmentsOf(runId: string): Item[] {
  return items
    .latest(400)
    .items.filter((i) => i.run_id === runId && i.kind === 'assistant')
    .sort((a, b) => a.created_at - b.created_at);
}

/** The page's latest refresh is still queued, running or waiting on the user. */
export function pageRefreshing(p: Page): boolean {
  const t = p.task_id ? tasks.get(p.task_id) : null;
  return !!t && ['queued', 'running', 'waiting'].includes(t.status);
}

export function markTaskWaiting(taskId: string) {
  const t = tasks.get(taskId);
  if (t && t.status !== 'done' && t.status !== 'cancelled' && t.status !== 'failed') putTask({ ...t, status: 'waiting', progress: 'Waiting on you' });
}

/** A brief that did post (or failed again, with a new card) makes an older "Run it now?" card moot. */
export function expireBriefRetries() {
  for (const c of items.pendingCards()) {
    if (c.card?.rerun === 'brief') put({ ...c, card: { ...c.card, status: 'expired', decided_at: Date.now() } });
  }
}

/** Expire Hermes prompts whose run is no longer live; they would otherwise sit in "Needs you" and the brief forever. */
export function expireDeadPrompts(): number {
  const dead = deadPrompts(items.pendingCards(), new Set(activeRuns().map((r) => r.id)));
  for (const c of dead) put({ ...c, card: { ...c.card!, status: 'expired', decision: PROMPT_ENDED, decided_at: Date.now() } });
  return dead.length;
}

/** Mirror a terminal task outcome back onto its originating routine, if any. */
export function syncRoutineResult(final: Task | null | undefined) {
  if (!final?.routine_id) return;
  const r = routines.get(final.routine_id);
  if (!r) return;
  const result = final.status === 'failed' ? final.result || 'Failed.' : final.status === 'done' ? final.result || 'Finished.' : final.result || 'Stopped.';
  putRoutine({ ...r, last_result: result });
}

/** Post the task's handover card, or refresh it in place if this task already handed over once. */
export function handOver(t: Task): Item {
  const existing = t.handover_id ? items.get(t.handover_id) : null;
  const channel = channels.forTask(t);
  const card = handoverCard(t, files.all(), existing?.card);
  if (existing) return put({ ...existing, card: { ...card, channel_id: channel }, channel_id: channel });
  // One unit: a crash between the card and the task's pointer to it leaves a card the task can never update.
  return tx(() => {
    const item = put(newItem('card', { card: { ...card, channel_id: channel }, task_id: t.id, channel_id: channel }));
    putTask({ ...t, handover_id: item.id });
    return item;
  });
}

/** `push: false` when the caller pushes its own card for the same event, so the user gets one notification. */
export function failTask(taskId: string, reason: string, { push = true } = {}) {
  const t = tasks.get(taskId);
  if (!t || t.status === 'cancelled' || t.status === 'done') return;
  const failed = putTask({ ...t, status: 'failed', result: reason, progress: '' });
  syncRoutineResult(failed);
  addContextNote(`Background task "${t.title}" (${taskId}) failed: ${reason}`);
  if (push) pushSafe({ title: `Task failed: ${t.title}`, body: firstLine(reason), tag: `task-${taskId}`, category: 'task_failed', channel_id: channels.forTask(t) });
}

/**
 * The user's own completion: the real one, never set by the agent. Refreshes the handover card in place so the
 * thread shows the confirmed state without a second card.
 */
export function confirmTask(id: string): Task {
  const t = tasks.get(id);
  if (!t) throw new UserError('no such task', 404);
  if (!t.confirmed_at) {
    putTask(withConfirmed(t));
    const h = t.handover_id ? items.get(t.handover_id) : null;
    if (h?.card && !h.card.confirmed_at) put({ ...h, card: { ...h.card, confirmed_at: tasks.get(id)?.confirmed_at ?? Date.now() } });
  }
  return tasks.get(id)!;
}

/** Undo the user's completion; the agent's `agent_done_at` stays as history. */
export function reopenTask(id: string): Task {
  const t = tasks.get(id);
  if (!t) throw new UserError('no such task', 404);
  if (t.confirmed_at !== undefined) {
    putTask(withReopened(t));
    const h = t.handover_id ? items.get(t.handover_id) : null;
    if (h?.card?.confirmed_at !== undefined) {
      const { confirmed_at: _drop, ...card } = h.card;
      put({ ...h, card });
    }
  }
  return tasks.get(id)!;
}

/** Reassign a background task (and all its cards/thread items) to a live topic channel. */
export function moveTaskChannel(taskId: string, channelId: string): Task {
  const ch = liveChannel(channelId);
  const t = tasks.get(taskId);
  if (!t) throw new UserError('no such task', 404);
  const updated = t.channel_id === ch.id ? t : putTask({ ...t, channel_id: ch.id });
  for (const item of items.byTask(t.id)) {
    const nextCard = item.card ? { ...item.card, channel_id: ch.id } : undefined;
    if (item.channel_id !== ch.id || (nextCard && item.card?.channel_id !== ch.id)) {
      put({ ...item, channel_id: ch.id, ...(nextCard ? { card: nextCard } : {}) });
    }
  }
  return updated;
}

/**
 * Narrow double-work guard for the manual brief: two taps or a double network
 * retry within 10s collapse to one `runBrief` call. `runBrief` itself already
 * dedupes a queued/active brief; this only covers the instant between two
 * HTTP POSTs landing before either has queued anything.
 */
export const BRIEF_MIN_GAP_MS = 10_000;
export function briefDedupeAllowed(now = Date.now()): boolean {
  if (now - runtime.lastManualBriefAt < BRIEF_MIN_GAP_MS) return false;
  runtime.lastManualBriefAt = now;
  return true;
}

/** Test seam: reset the dedupe window without restarting the process. */
export function __resetBriefDedupe() {
  runtime.lastManualBriefAt = 0;
}
