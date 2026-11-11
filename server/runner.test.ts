import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, spyOn, test } from 'bun:test';
import webpush from 'web-push';
import type { Attachment, FileEntry, Item, Page, Routine, Task } from '../shared/types';
import * as browser from './browser';
import { config } from './config';
import { channels, db, files, items, kv, newId, routines, runs, settings, tasks } from './db';
import { HermesError, hermes } from './hermes';
import { saveSubscription } from './push';
import { GENERAL_CHANNEL } from './schema';
import { actOnCard, agentState, briefDedupeAllowed, cancelTask, confirmTask, deliverableAction, deliverableApproval, executeTool, mainSessionId, mediaPaths, pageRefreshing, recoverOrphans, removeRoutine, reopenTask, runBrief, runRoutineNow, saveRoutine, settleHermesAsk, startRoutine, startUserTask, steerTask, stopMain, submitSystem, submitUser, __resetBriefDedupe } from './runner';

// Tests must never trigger real Hermes gateway turns unless explicitly stubbed
hermes.hasKey = () => false;

const task = (status: Task['status']): Task => ({
  id: newId(),
  title: `hc refresh ${status}`,
  status,
  steps: [],
  created_at: Date.now(),
  updated_at: Date.now(),
  background: true,
});
const page = (task_id?: string): Page =>
  ({ id: newId(), title: 'hc page', instructions: 'x', file_id: 'f', task_id } as Page);

test('a page that never refreshed is not refreshing', () => {
  expect(pageRefreshing(page())).toBe(false);
});

test('queued and running refreshes count as refreshing', () => {
  for (const status of ['queued', 'running', 'waiting'] as const) {
    const t = task(status);
    tasks.save(t);
    expect(pageRefreshing(page(t.id))).toBe(true);
  }
});

test('finished refreshes no longer count', () => {
  for (const status of ['done', 'failed'] as const) {
    const t = task(status);
    tasks.save(t);
    expect(pageRefreshing(page(t.id))).toBe(false);
  }
});

test('a dangling task id is not refreshing', () => {
  expect(pageRefreshing(page('no-such-task'))).toBe(false);
});

test('a new refresh supersedes the finished one', () => {
  const old = task('done');
  tasks.save(old);
  expect(pageRefreshing(page(old.id))).toBe(false);
  const next = task('queued');
  tasks.save(next);
  expect(pageRefreshing(page(next.id))).toBe(true);
});

const dash = (extra: Partial<FileEntry> = {}): FileEntry => ({
  id: `f-${newId()}`,
  title: 'Spend dash',
  name: 'spend.html',
  mime: 'text/html',
  size: 10,
  created_at: Date.now(),
  ...extra,
});

test('a user-started task keeps its attachment on the item and in the prompt', () => {
  const attachment: Attachment = { id: newId(), name: 'receipt.pdf', mime: 'application/pdf', size: 1024, kind: 'file', created_at: Date.now() };
  const { item, task } = startUserTask(
    'look at this',
    undefined,
    [attachment],
    '\n\nThe user attached 1 file with this message:\n- /tmp/receipt.pdf (application/pdf, 1 KB)',
  );
  expect(item.attachments).toEqual([attachment]);
  expect(task.instructions).toContain('/tmp/receipt.pdf');
});

test('a dashboard approval is only ever a proposal: pending card, nothing acted on', () => {
  const item = deliverableApproval(dash(), { title: 'Pay the bill', summary: 'Bill is $5.', action_label: 'Pay' });
  expect(item.card!.type).toBe('approval');
  expect(item.card!.status).toBe('pending');
  expect(item.card!.title).toBe('Pay the bill');
  expect(item.card!.body).toContain('Bill is $5.');
});

test('dashboard approval falls back when the dashboard sends nothing usable', () => {
  const item = deliverableApproval(dash({ title: 'Q3 board' }), {});
  expect(item.card!.title).toContain('Q3 board');
  expect(item.card!.body).toContain('Q3 board');
});

test('dashboard approval text is bounded', () => {
  const item = deliverableApproval(dash(), { title: 't'.repeat(200), summary: 's'.repeat(5000), action_label: 'a'.repeat(40) });
  expect(item.card!.title).toHaveLength(140);
  expect(item.card!.body!.length).toBeLessThan(4100);
  expect(item.card!.action_label).toHaveLength(30);
});

test('dashboard buttons sanitize the action and arrive as a system line', () => {
  expect(() => deliverableAction(dash(), {})).toThrow('missing action');
  const item = deliverableAction(dash({ title: 'Board' }), { action: 'export-csv!', payload: { row: 3 } });
  expect(item.kind).toBe('system');
  expect(item.text).toContain('export-csv');
  expect(item.text).not.toContain('!');
});

// The card records the tap, then the decision goes to Hermes. It may only read as decided once Hermes has it: a
// green "Approved" on an action the agent never received is the app lying about the most sensitive thing it does.
const hermesAsk = (decision: string = 'approve'): Item => {
  const now = Date.now();
  const item: Item = {
    id: newId(),
    kind: 'card',
    created_at: now,
    updated_at: now,
    channel_id: GENERAL_CHANNEL,
    card: {
      type: 'approval',
      title: 'Send the invoice',
      status: 'pending',
      decision,
      decided_at: now,
      hermes: { kind: 'approval', run_id: 'r1', request_id: 'q1', generation: 1 },
    },
  };
  return items.save(item);
};

test('an approval Hermes never received goes back to pending, not green', async () => {
  const item = hermesAsk();
  const err = await settleHermesAsk(item, 'approved', async () => {
    throw new Error('gateway timeout');
  }).catch((e) => e);
  expect(err).toBeInstanceOf(Error);
  expect(err.message).toContain('Tap again');
  const saved = items.get(item.id)!;
  expect(saved.card!.status).toBe('pending');
  expect(saved.card!.decision).toBeUndefined();
  expect(saved.card!.decided_at).toBeUndefined();
  expect(saved.card!.error).toContain('gateway timeout');
});

test('an approval Hermes acknowledged is recorded as approved', async () => {
  const item = hermesAsk();
  const saved = await settleHermesAsk(item, 'approved', async () => ({}));
  expect(saved.card!.status).toBe('approved');
  expect(saved.card!.decision).toBe('approve');
  expect(saved.card!.error).toBeUndefined();
});

test('a declined ask that never reached Hermes is not left declined', async () => {
  const item = hermesAsk('decline');
  await settleHermesAsk(item, 'declined', async () => {
    throw new Error('run gone');
  }).catch(() => {});
  expect(items.get(item.id)!.card!.status).toBe('pending');
});

test('the card can be tapped again after a failed send', async () => {
  const item = hermesAsk();
  await settleHermesAsk(item, 'approved', async () => {
    throw new Error('down');
  }).catch(() => {});
  const retried = await settleHermesAsk(items.get(item.id)!, 'approved', async () => ({}));
  expect(retried.card!.status).toBe('approved');
  expect(retried.card!.error).toBeUndefined();
});

test('a double tap sends the decision once, not twice', async () => {
  const item = hermesAsk();
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  let sends = 0;
  const first = settleHermesAsk(item, 'approved', async () => {
    sends++;
    await gate;
  });
  const second = settleHermesAsk(item, 'approved', async () => {
    sends++;
  }).catch((e) => e);
  expect((await second).message).toContain('already on its way');
  release();
  expect((await first).card!.status).toBe('approved');
  expect(sends).toBe(1);
});

// Stopping must free the lane on our own clock: a gateway that is down (or answers 404 because it already forgot the
// run) never sends the terminal event, and everything queued behind that run would otherwise wait out the watchdog.
function stubHermes(over: Record<string, unknown>): () => void {
  const saved: Record<string, unknown> = {};
  for (const k of Object.keys(over)) saved[k] = (hermes as any)[k];
  Object.assign(hermes, over);
  return () => Object.assign(hermes, saved);
}

/** A run that starts, then streams nothing until it is aborted. */
const silentRun = (runId: string) => ({
  hasKey: () => true,
  startRun: async () => ({ run_id: runId, status: 'running' }),
  events: (_id: string, _seq: number, _on: unknown, signal: AbortSignal) =>
    new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve())),
});

async function until(cond: () => boolean, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await Bun.sleep(10);
}

test('a chat turn in a topic channel carries that channel\'s waiting-cards note', async () => {
  // The note tells the agent which of its cards are still tappable, so a reply that settles one in words also takes
  // it down. `waitingNote` already scopes to the run's own session; gating it on the main lane dropped it for every
  // channel, leaving approvals from #taxes tappable days later.
  const ch = channels.create({ name: 'taxes' });
  items.save({
    id: newId(),
    kind: 'card',
    channel_id: ch.id,
    created_at: Date.now(),
    updated_at: Date.now(),
    card: { type: 'approval', title: 'Send the invoice', session_id: ch.session_id, status: 'pending' } as any,
  });
  const inputs: string[] = [];
  const restore = stubHermes({
    hasKey: () => true,
    startRun: async (a: any) => {
      inputs.push(a.input);
      return { run_id: `r-ch-${inputs.length}`, status: 'running' };
    },
    // Finish the turn straight away so the lane frees and the test does not leave a run behind.
    events: async (_id: string, _seq: number, on: any) => {
      on({ event: 'run.completed', seq: 1 });
    },
    stop: async () => ({}),
  });
  try {
    submitUser('hold off on that, I will call them', undefined, ch.id);
    await until(() => inputs.length > 0);
    expect(inputs[0]).toContain('Cards of yours still waiting');
    expect(inputs[0]).toContain('Send the invoice');
  } finally {
    restore();
    await stopMain();
  }
});

test('a stop Hermes refuses (404) still frees the lane right away', async () => {
  const restore = stubHermes({
    ...silentRun('r-stop-404'),
    stop: async () => {
      throw new HermesError(404, 'no such run');
    },
  });
  try {
    const { task } = startUserTask('build the deck');
    await until(() => agentState().background_running === 1);
    await cancelTask(task.id);
    expect(agentState().background_running).toBe(0);
    expect(tasks.get(task.id)!.status).toBe('cancelled');
  } finally {
    restore();
  }
});

test('a stop Hermes accepts but never confirms still frees the lane within the grace', async () => {
  const restore = stubHermes({ ...silentRun('r-stop-silent'), stop: async () => ({}) });
  try {
    const { task } = startUserTask('build the other deck');
    await until(() => agentState().background_running === 1);
    const startedAt = Date.now();
    await cancelTask(task.id);
    expect(agentState().background_running).toBe(0);
    // Bounded by the grace, not by the 45-minute watchdog.
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  } finally {
    restore();
  }
});

// Two turns running at once must never have their cards or files resolved by guesswork: a deck that lands in the wrong
// chat is not something the user can undo. The call is refused, says nothing was posted, and says how to place it.
let multiSeq = 0;
const manyRuns = () => ({
  ...silentRun('unused'),
  startRun: async () => ({ run_id: `r-multi-${++multiSeq}`, status: 'running' }),
});

test('a tool call two live turns could own is refused, not guessed at', async () => {
  const restore = stubHermes({
    ...manyRuns(),
    stop: async () => {
      throw new HermesError(404, 'no such run');
    },
  });
  const a = startUserTask('task one').task;
  const b = startUserTask('task two').task;
  try {
    await until(() => agentState().background_running === 2);
    const err = await executeTool('request_approval', { title: 'Send the deck', summary: 'The deck is ready.' }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('Nothing was posted');
    expect(err.message).toContain(a.id);
    expect(err.message).toContain(b.id);
    expect(items.pendingCards().some((i) => i.card?.title === 'Send the deck')).toBe(false);
  } finally {
    await cancelTask(a.id).catch(() => {});
    await cancelTask(b.id).catch(() => {});
    restore();
  }
});

test('an explicit task_id still files the card on that task while another turn runs', async () => {
  const restore = stubHermes({
    ...manyRuns(),
    stop: async () => {
      throw new HermesError(404, 'no such run');
    },
  });
  const a = startUserTask('deck task').task;
  const b = startUserTask('other task').task;
  try {
    await until(() => agentState().background_running === 2);
    await executeTool('request_approval', { title: 'Send the deck', summary: 'x', task_id: a.id });
    const card = items.pendingCards().find((i) => i.card?.title === 'Send the deck');
    expect(card?.card!.task_id).toBe(a.id);
    expect(card?.task_id).toBe(a.id);
  } finally {
    await cancelTask(a.id).catch(() => {});
    await cancelTask(b.id).catch(() => {});
    restore();
  }
});

test('"main" answers an ambiguous call from the main conversation', async () => {
  const restore = stubHermes({
    ...manyRuns(),
    stop: async () => {
      throw new HermesError(404, 'no such run');
    },
  });
  const a = startUserTask('one task').task;
  const b = startUserTask('another task').task;
  try {
    await until(() => agentState().background_running === 2);
    await executeTool('request_approval', { title: 'Chat card', summary: 'x', task_id: 'main' });
    const card = items.pendingCards().find((i) => i.card?.title === 'Chat card');
    expect(card?.task_id).toBeNull();
    expect(card?.card!.session_id).toBe(mainSessionId());
  } finally {
    await cancelTask(a.id).catch(() => {});
    await cancelTask(b.id).catch(() => {});
    restore();
  }
});

test('a task id that does not exist is refused instead of falling back to the main lane', async () => {
  const err = await executeTool('request_approval', { title: 'Nowhere', summary: 'x', task_id: 'no-such-task' }).catch((e) => e);
  expect(err).toBeInstanceOf(Error);
  expect(err.message).toContain('No Hermes Duet task no-such-task');
  expect(items.pendingCards().some((i) => i.card?.title === 'Nowhere')).toBe(false);
});

// A gateway restart mid-turn used to lose a message the user had just steered in: Hermes returns it as
// `pending_steer`, but the in-memory list of steers was empty after the restart, so nothing matched and nothing was
// replayed. The list, the replay cursor and the silence clock are now stored with the run.
test('a steer a restart interrupted is replayed into a new turn, not lost', async () => {
  const inputs: string[] = [];
  let runsSoFar = 0;
  let first = true;
  const restore = stubHermes({
    hasKey: () => true,
    startRun: async (a: any) => {
      inputs.push(String(a.input));
      return { run_id: `r-rec-${++runsSoFar}`, status: 'running' };
    },
    events: async (_id: string, _seq: number, on: (ev: any) => void, signal: AbortSignal) => {
      if (first) {
        first = false;
        on({ event: 'run.completed', pending_steer: 'rework the deck', seq: 7 });
        return;
      }
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
    },
    stop: async () => {
      throw new HermesError(404, 'no such run');
    },
  });
  try {
    const sessionId = mainSessionId();
    runs.start('r-orphan-steer', 'chat', sessionId, null, {
      spec: { kind: 'chat', sessionId, input: 'original turn' },
      activityId: null,
      steers: [{ sent: 'rework the deck', raw: 'rework the deck' }],
      lastSeq: 3,
      lastEventAt: Date.now(),
    });
    // An earlier test can leave a real main-lane run behind; reattaching is skipped while a lane is busy.
    await stopMain().catch(() => {});
    recoverOrphans();
    // The replayed message is either launched straight away or waiting in the lane's queue (pumpAll skips a lane whose
    // Hermes was seen going down); both mean it survived the restart.
    const replayed = () =>
      inputs.some((i) => i.includes('rework the deck')) ||
      kv.get<{ input?: string }[]>('queues', []).some((s) => String(s.input ?? '').includes('rework the deck'));
    await until(replayed);
    expect(replayed()).toBe(true);
  } finally {
    await stopMain().catch(() => {});
    restore();
  }
});

test('a resumed run continues the message it was writing instead of duplicating it', async () => {
  let first = true;
  const restore = stubHermes({
    hasKey: () => true,
    startRun: async () => ({ run_id: 'r-rec-seg', status: 'running' }),
    events: async (_id: string, _seq: number, on: (ev: any) => void, signal: AbortSignal) => {
      if (first) {
        first = false;
        on({ event: 'message.delta', delta: ' again', seq: 6 });
        on({ event: 'run.completed', seq: 7 });
        return;
      }
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
    },
    stop: async () => {
      throw new HermesError(404, 'no such run');
    },
  });
  try {
    await stopMain().catch(() => {});
    const sessionId = mainSessionId();
    const seg = items.save({
      id: newId(),
      kind: 'assistant',
      run_id: 'r-orphan-seg',
      channel_id: GENERAL_CHANNEL,
      created_at: Date.now(),
      updated_at: Date.now(),
      text: 'Hello world',
      streaming: true,
    });
    runs.start('r-orphan-seg', 'chat', sessionId, null, {
      spec: { kind: 'chat', sessionId, input: 'say hello' },
      activityId: null,
      steers: [],
      lastSeq: 5,
      lastEventAt: Date.now(),
    });
    recoverOrphans();
    await until(() => items.get(seg.id)?.streaming === false);
    expect(items.get(seg.id)!.text).toBe('Hello world again');
  } finally {
    await stopMain().catch(() => {});
    restore();
  }
});

// A Stop tapped before Hermes answers with a run_id had nothing to cancel yet, and was dropped silently: the agent
// kept working on a turn the user had already stopped, and the lane stayed busy until the run finished on its own.
test('a stop tapped before the run id arrives is honoured once it does', async () => {
  let release: (v: { run_id: string; status: string }) => void = () => {};
  const started = new Promise<{ run_id: string; status: string }>((r) => (release = r));
  const stopped: string[] = [];
  const restore = stubHermes({
    ...silentRun('r-stop-early'),
    startRun: () => started,
    stop: async (id: string) => {
      stopped.push(id);
      return {};
    },
  });
  try {
    submitUser('stop me before it starts');
    // The lane is claimed and parked on the start POST: active, but with no run id to cancel yet.
    expect(agentState().busy).toBe(true);
    await stopMain();
    expect(stopped).toEqual([]);

    release({ run_id: 'r-stop-early', status: 'running' });
    await until(() => stopped.length === 1);
    expect(stopped).toEqual(['r-stop-early']);
    // Hermes sends no terminal event for a run it was told to stop, so the lane is released on our own clock.
    await until(() => agentState().busy === false, 4000);
    expect(agentState().busy).toBe(false);
  } finally {
    restore();
    await stopMain().catch(() => {});
  }
});

test("manual brief dedupe collapses double taps within the window", () => {
  __resetBriefDedupe();
  const now = 1_000_000;
  expect(briefDedupeAllowed(now)).toBe(true);
  expect(briefDedupeAllowed(now + 1)).toBe(false);
  expect(briefDedupeAllowed(now + 9_999)).toBe(false);
  expect(briefDedupeAllowed(now + 10_000)).toBe(true);
  expect(briefDedupeAllowed(now + 10_001)).toBe(false);
});

test("scheduled briefs are never deduped by the manual window", () => {
  __resetBriefDedupe();
  const now = 2_000_000;
  expect(briefDedupeAllowed(now)).toBe(true);
  // runBrief with scheduled source must not consult the manual dedupe clock.
  __resetBriefDedupe();
});

// The agent's done only ever "looks done": update_task stamps the first finish and keeps it, without changing status.
test('update_task done stamps agent_done_at once and keeps status done', async () => {
  const t: Task = { id: newId(), title: 'hc stamp', status: 'running', steps: [], created_at: Date.now(), updated_at: Date.now(), background: true };
  tasks.save(t, 'duet-task-hc-stamp');
  await executeTool('update_task', { task_id: t.id, status: 'done' });
  const first = tasks.get(t.id)!;
  expect(first.status).toBe('done');
  expect(first.agent_done_at).toBeTruthy();
  await executeTool('update_task', { task_id: t.id, status: 'done', progress: 'polishing' });
  const second = tasks.get(t.id)!;
  expect(second.status).toBe('done');
  expect(second.agent_done_at).toBe(first.agent_done_at);
  expect(second.confirmed_at).toBeUndefined();
});

test('update_task for other statuses leaves agent_done_at alone', async () => {
  const t: Task = { id: newId(), title: 'hc no stamp', status: 'running', steps: [], created_at: Date.now(), updated_at: Date.now(), background: true };
  tasks.save(t, 'duet-task-hc-nostamp');
  await executeTool('update_task', { task_id: t.id, status: 'waiting', progress: 'thinking' });
  expect(tasks.get(t.id)!.agent_done_at).toBeUndefined();
});

// Steering goes to the task's live run through hermes.steer, with task attribution on the text.
test('steerTask delivers to the live run', async () => {
  const steered: { id: string; text: string }[] = [];
  const restore = stubHermes({
    ...silentRun('r-steer-live'),
    steer: async (id: string, text: string) => {
      steered.push({ id, text });
      return { accepted: true };
    },
    stop: async () => {
      throw new HermesError(404, 'no such run');
    },
  });
  const { task } = startUserTask('steerable work');
  try {
    await until(() => agentState().background_running === 1);
    const r = await steerTask(task.id, 'use blue for the headings');
    expect(r.delivered).toBe(true);
    expect(steered).toHaveLength(1);
    expect(steered[0]!.id).toBe('r-steer-live');
    expect(steered[0]!.text).toContain('use blue for the headings');
  } finally {
    await cancelTask(task.id).catch(() => {});
    restore();
  }
});

// A steer Hermes refuses is queued as its own turn in the task's session — same conversation, never sent twice.
test('a refused steer is queued, not lost', async () => {
  const restore = stubHermes({
    ...silentRun('r-steer-queued'),
    steer: async () => {
      throw new HermesError(502, 'gateway hiccup');
    },
    stop: async () => {
      throw new HermesError(404, 'no such run');
    },
  });
  const { task } = startUserTask('flaky steer work');
  try {
    await until(() => agentState().background_running === 1);
    const r = await steerTask(task.id, 'hold that thought');
    expect(r.delivered).toBe(false);
  } finally {
    await cancelTask(task.id).catch(() => {});
    restore();
  }
});

test('steerTask refuses a task with no live run instead of queueing silently', async () => {
  const done: Task = { id: newId(), title: 'hc over', status: 'done', steps: [], created_at: Date.now(), updated_at: Date.now(), background: true };
  tasks.save(done, 'duet-task-hc-over');
  const errDone = await steerTask(done.id, 'one more thing').catch((e) => e);
  expect(errDone.message).toContain('nothing to steer');
  expect(errDone.status).toBe(409);

  // Running on paper but with no run attached is still not live.
  const ghost: Task = { id: newId(), title: 'hc ghost', status: 'running', steps: [], created_at: Date.now(), updated_at: Date.now(), background: true };
  tasks.save(ghost, 'duet-task-hc-ghost');
  const errGhost = await steerTask(ghost.id, 'hello?').catch((e) => e);
  expect(errGhost.message).toContain('not running right now');
  expect(errGhost.status).toBe(409);

  const errMissing = await steerTask('no-such-task', 'hello?').catch((e) => e);
  expect(errMissing.status).toBe(404);
});

// Only the user completes a task: confirm stamps it (and the handover card), reopen clears it but keeps history.
test('confirm and reopen bracket the user completion', () => {
  const t: Task = { id: newId(), title: 'hc user done', status: 'done', steps: [], created_at: Date.now(), updated_at: Date.now(), background: true };
  tasks.save(t, 'duet-task-hc-userdone');
  const confirmed = confirmTask(t.id);
  expect(confirmed.confirmed_at).toBeTruthy();
  expect(confirmed.status).toBe('done');
  const reopened = reopenTask(t.id);
  expect(reopened.confirmed_at).toBeUndefined();
  expect(reopened.agent_done_at).toBe(tasks.get(t.id)!.agent_done_at);
});

test('confirm refreshes the handover card in place', () => {
  const t: Task = { id: newId(), title: 'hc card done', status: 'done', steps: [], created_at: Date.now(), updated_at: Date.now(), background: true };
  const cardId = newId();
  const now = Date.now();
  tasks.save({ ...t, handover_id: cardId }, 'duet-task-hc-carddone');
  items.save({
    id: cardId,
    kind: 'card',
    created_at: now,
    updated_at: now,
    channel_id: GENERAL_CHANNEL,
    task_id: t.id,
    card: { type: 'handover', title: t.title, status: 'info', task_id: t.id },
  });
  confirmTask(t.id);
  expect(items.get(cardId)!.card!.confirmed_at).toBe(tasks.get(t.id)!.confirmed_at);
  reopenTask(t.id);
  expect(items.get(cardId)!.card!.confirmed_at).toBeUndefined();
});

// Structured citations: valid sources ride on the entry or the task, and an
// unknown local id fails the tool call instead of posting a chip that opens nothing.
test('brief entries keep their sources through posting', async () => {
  const src = items.save({
    id: newId(),
    kind: 'user',
    text: 'Dana wrote about the lease',
    channel_id: GENERAL_CHANNEL,
    created_at: Date.now(),
    updated_at: Date.now(),
  });
  await executeTool('post_brief', {
    title: 'Heads up: 1 thing',
    entries: [{ title: 'Cite the lease reply', sources: [{ kind: 'item', id: src.id, label: "Dana's email" }] }],
  });
  const card = items.latest(50).items.find((i) => i.card?.type === 'brief' && i.card.entries?.some((e) => e.title === 'Cite the lease reply'));
  expect(card?.card?.entries?.[0]?.sources).toEqual([{ kind: 'item', id: src.id, label: "Dana's email" }]);
});

test('a brief entry naming an unknown id fails the tool call and posts nothing', async () => {
  const err = await executeTool('post_brief', {
    title: 'Heads up: 1 thing',
    entries: [{ title: 'Cite nothing at all', sources: [{ kind: 'file', id: 'no-such-file', label: 'Deck' }] }],
  }).catch((e) => e);
  expect(err).toBeInstanceOf(Error);
  expect(err.message).toContain('no file with id');
  expect(items.latest(50).items.some((i) => i.card?.entries?.some((e) => e.title === 'Cite nothing at all'))).toBe(false);
});

test('a task result keeps its sources, and an unknown id fails the call', async () => {
  const t: Task = {
    id: newId(),
    title: 'Cite work',
    status: 'running',
    steps: [],
    created_at: Date.now(),
    updated_at: Date.now(),
    background: true,
  };
  tasks.save(t, 'sess-cite-test');
  await executeTool('update_task', {
    task_id: t.id,
    result: 'Rent moved to Friday',
    sources: [{ kind: 'url', url: 'https://example.com/rent', label: 'Ledger' }],
  });
  expect(tasks.get(t.id)!.sources).toEqual([{ kind: 'url', url: 'https://example.com/rent', label: 'Ledger' }]);
  const err = await executeTool('update_task', {
    task_id: t.id,
    sources: [{ kind: 'page', id: 'no-such-page', label: 'Dashboard' }],
  }).catch((e) => e);
  expect(err).toBeInstanceOf(Error);
  expect(err.message).toContain('no page with id');
  // The failed call leaves the earlier citations alone.
  expect(tasks.get(t.id)!.sources).toEqual([{ kind: 'url', url: 'https://example.com/rent', label: 'Ledger' }]);
});

test('start_task propagates the calling topic channel to the spawned background task', async () => {
  const ch = channels.create({ name: `proj-${newId().slice(-4)}` });
  const msg = await executeTool('start_task', {
    title: 'Channel scoped build',
    instructions: 'Build report',
    task_id: `channel:${ch.id}`,
  });
  expect(msg).toContain('Started background task');
  const created = tasks.recent().find((t) => t.title === 'Channel scoped build');
  expect(created?.channel_id).toBe(ch.id);
  await until(() => tasks.get(created!.id)?.status !== 'queued');
  await cancelTask(created!.id).catch(() => {});
});

test('launchRun preserves context_notes appended concurrently while startRun awaits', async () => {
  kv.set('context_notes', ['prior-note-1', 'prior-note-2']);
  const startedInputs: string[] = [];
  let injected = false;
  const restore = stubHermes({
    hasKey: () => true,
    startRun: async (a: any) => {
      startedInputs.push(String(a.input));
      if (!injected) {
        injected = true;
        const notes = kv.get<string[]>('context_notes', []);
        notes.push('concurrent-note-during-start');
        kv.set('context_notes', notes);
      }
      return { run_id: `r-notes-${startedInputs.length}`, status: 'running' };
    },
    events: async (_id: string, _seq: number, on: any) => {
      on({ event: 'run.completed', seq: 1 });
    },
    stop: async () => ({}),
  });
  try {
    await stopMain().catch(() => {});
    submitUser('hello concurrent notes');
    await until(() => startedInputs.length >= 1);
    await until(() => !agentState().busy);
    expect(startedInputs[0]).toContain('prior-note-1');
    expect(startedInputs[0]).toContain('prior-note-2');
    expect(startedInputs[0]).not.toContain('concurrent-note-during-start');
    expect(kv.get<string[]>('context_notes', [])).toContain('concurrent-note-during-start');
  } finally {
    kv.set('context_notes', []);
    await stopMain().catch(() => {});
    restore();
  }
});

test('startUserTask scopes recent chat context to the requested channel', async () => {
  const ch = channels.create({ name: `scoped-${newId().slice(-4)}` });
  const genToken = `GENERAL-SECRET-${newId()}`;
  const chToken = `TOPIC-CONTEXT-${newId()}`;
  const now = Date.now();
  items.save({ id: newId(), kind: 'user', text: genToken, channel_id: GENERAL_CHANNEL, created_at: now - 10, updated_at: now - 10 });
  items.save({ id: newId(), kind: 'user', text: chToken, channel_id: ch.id, created_at: now, updated_at: now });
  const { task } = startUserTask('summarize topic', ch.id);
  expect(task.instructions).toContain(chToken);
  expect(task.instructions).not.toContain(genToken);
  expect(task.channel_id).toBe(ch.id);
  await until(() => tasks.get(task.id)?.status !== 'queued');
});

test('recoverOrphans restores cards/briefs counts, joins multi-segment text, and persists lastSeq when segment flushes', async () => {
  const pushSpy = spyOn(webpush, 'sendNotification').mockResolvedValue({} as any);
  saveSubscription({ endpoint: 'https://push.example/orphan-sub', keys: { p256dh: 'k', auth: 'a' } }, 'dev-orphan');
  const prevSettings = settings.get();
  settings.update({ quiet_start: '00:00', quiet_end: '00:00' });

  const restore = stubHermes({
    hasKey: () => true,
    startRun: async () => ({ run_id: 'r-unused', status: 'running' }),
    events: async (_id: string, seq: number, on: any) => {
      if (seq === 5) {
        on({ event: 'message.delta', delta: ' delta-6', seq: 6 });
        on({ event: 'run.completed', seq: 7 });
      }
    },
    stop: async () => {
      throw new HermesError(404, 'no such run');
    },
  });
  try {
    await stopMain().catch(() => {});
    const runId = `r-orphan-multi-${newId()}`;
    const sessionId = mainSessionId();
    const fgTask: Task = {
      id: newId(),
      title: 'Recovered fg task',
      status: 'running',
      steps: [],
      created_at: Date.now(),
      updated_at: Date.now(),
      background: false,
    };
    tasks.save(fgTask, null);
    const now = Date.now();
    items.save({
      id: newId(),
      kind: 'assistant',
      run_id: runId,
      channel_id: GENERAL_CHANNEL,
      created_at: now - 20,
      updated_at: now - 20,
      text: 'Part one.',
      streaming: false,
    });
    const seg2 = items.save({
      id: newId(),
      kind: 'assistant',
      run_id: runId,
      channel_id: GENERAL_CHANNEL,
      created_at: now - 10,
      updated_at: now - 10,
      text: 'Part two.',
      streaming: true,
    });
    runs.start(runId, 'chat', sessionId, null, {
      spec: { kind: 'chat', sessionId, input: 'multi seg' },
      activityId: null,
      fgTaskId: fgTask.id,
      steers: [],
      lastSeq: 5,
      cards: 1,
      briefs: 1,
      lastEventAt: now,
    });

    recoverOrphans();
    await until(() => !agentState().busy);

    expect(items.get(seg2.id)!.text).toBe('Part two. delta-6');
    expect(items.get(seg2.id)!.streaming).toBe(false);
    // cards=1 was restored, so completing the turn must NOT send an unprompted Hermes Duet reply push.
    expect(pushSpy).toHaveBeenCalledTimes(0);
    // Meta persisted updated lastSeq=6 and preserved cards/briefs when seg2 flushed on closeSegment.
    const metaRow = db.query<{ meta: string }, [string]>('SELECT meta FROM runs WHERE id = ?').get(runId)!;
    const savedMeta = JSON.parse(metaRow.meta);
    expect(savedMeta.cards).toBe(1);
    expect(savedMeta.briefs).toBe(1);
    expect(savedMeta.lastSeq).toBeGreaterThanOrEqual(6);
  } finally {
    db.query('DELETE FROM push_subs WHERE endpoint = ?').run('https://push.example/orphan-sub');
    settings.update(prevSettings);
    pushSpy.mockRestore();
    await stopMain().catch(() => {});
    restore();
  }
});

test('stopRun sets stopRequested immediately, refuses steers while stopping, and replays pending_steer', async () => {
  const inputs: string[] = [];
  const steersSent: string[] = [];
  let releaseStop: () => void = () => {};
  const stopGate = new Promise<void>((r) => (releaseStop = r));
  let runSeq = 0;

  const restore = stubHermes({
    hasKey: () => true,
    startRun: async (a: any) => {
      inputs.push(String(a.input));
      return { run_id: `r-stop-race-${++runSeq}`, status: 'running' };
    },
    events: async (id: string, _seq: number, on: any, signal: AbortSignal) => {
      if (id !== 'r-stop-race-1') {
        on({ event: 'run.completed', seq: 1 });
        return;
      }
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
    },
    steer: async (_id: string, text: string) => {
      steersSent.push(text);
      return { accepted: true };
    },
    stop: async () => {
      await stopGate;
      throw new HermesError(404, 'no such run');
    },
    getRun: async () => ({ status: 'cancelled', pending_steer: steersSent[0] }),
  });

  try {
    await stopMain().catch(() => {});
    submitUser('initial run');
    await until(() => inputs.length === 1);
    submitUser('first steer');
    await until(() => steersSent.length === 1);

    const stopping = stopMain();
    // stopRequested is already true while stopRun awaits Hermes: a concurrent message must queue, never steer.
    submitUser('second queued message');
    expect(steersSent).toHaveLength(1);

    releaseStop();
    await stopping;
    await until(() => inputs.length >= 3 && !agentState().busy, 4000);
    // Undelivered 'first steer' came before 'second queued message'.
    const iFirst = inputs.findIndex((x) => x.includes('first steer'));
    const iSecond = inputs.findIndex((x) => x.includes('second queued message'));
    expect(iFirst).toBeGreaterThan(0);
    expect(iSecond).toBeGreaterThan(iFirst);
  } finally {
    releaseStop();
    await stopMain().catch(() => {});
    restore();
  }
});

test('steerTask rejects with 409 while task stop is already in flight', async () => {
  let releaseStop: () => void = () => {};
  const stopGate = new Promise<void>((r) => (releaseStop = r));
  const restore = stubHermes({
    ...silentRun('r-steer-stopping'),
    stop: async () => {
      await stopGate;
      throw new HermesError(404, 'no such run');
    },
  });
  const { task } = startUserTask('stop-guard task');
  try {
    await until(() => agentState().background_running === 1);
    const lActive = cancelTask(task.id);
    // Task already marked cancelled -> steerTask refuses 409 immediately.
    const err = await steerTask(task.id, 'too late').catch((e) => e);
    expect(err.status).toBe(409);
    releaseStop();
    await lActive;
  } finally {
    releaseStop();
    restore();
  }
});

test('ambiguousOrigin names topic channels cleanly and explicit channel:<id> disambiguates tools', async () => {
  const ch = channels.create({ name: `legal-${newId().slice(-4)}` });
  let count = 0;
  const resolvers = new Map<string, () => void>();
  const restore = stubHermes({
    hasKey: () => true,
    startRun: async () => ({ run_id: `r-ambig-${++count}`, status: 'running' }),
    events: async (id: string, _seq: number, on: any, signal: AbortSignal) => {
      await new Promise<void>((resolve) => {
        let settled = false;
        const done = (complete: boolean) => {
          if (settled) return;
          settled = true;
          if (complete) on({ event: 'run.completed', seq: 1 });
          resolve();
        };
        resolvers.set(id, () => done(true));
        signal.addEventListener('abort', () => done(false));
      });
    },
    stop: async () => {
      throw new HermesError(404, 'no such run');
    },
  });
  submitUser('channel message', undefined, ch.id);
  const { task } = startUserTask('parallel background task');
  try {
    await until(() => agentState().background_running === 1 && count === 2);
    const err = await executeTool('request_approval', { title: 'Send contract', summary: 'x' }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain(`channel #${ch.name} (${ch.id})`);
    expect(err.message).toContain(`"channel:${ch.id}"`);

    const msg = await executeTool('post_brief', {
      title: 'Channel brief',
      entries: [{ title: 'Review clause' }],
      task_id: `channel:${ch.id}`,
    });
    expect(msg).toContain('Brief card');
    const card = items.latest(20, ch.id).items.find((i) => i.card?.type === 'brief' && i.card.title.includes('Channel brief'));
    expect(card?.channel_id).toBe(ch.id);

    // Archived channel:<id> must be refused cleanly.
    const arch = channels.create({ name: `dead-${newId().slice(-4)}` });
    channels.archive(arch.id);
    await expect(executeTool('notify', { title: 'Ping', body: 'x', task_id: `channel:${arch.id}` })).rejects.toThrow(/No Hermes Duet channel/);
  } finally {
    await cancelTask(task.id).catch(() => {});
    for (const completeRun of resolvers.values()) completeRun();
    await until(() => agentState().background_running === 0 && !runs.orphaned().some((r) => r.session_id === ch.session_id));
    restore();
  }
});

test('interrupted done task delegates to onTaskRunEnd and syncs routine.last_result on failure and Leave it', async () => {
  // Part A: Task marked done before gateway returned 404/interrupted must hand over & update routine.last_result (no resume prompt).
  const routine1 = saveRoutine({
    title: 'Done then interrupted routine',
    prompt: 'Compute totals',
    schedule: { kind: 'interval', every_minutes: 60 },
  });
  // Start a silent run for routine1, mark task done, then fail run cleanly via 404 -> INTERRUPTED.
  let triggerDrop: (() => void) | null = null;
  let seq = 0;
  const restore = stubHermes({
    hasKey: () => true,
    startRun: async () => ({ run_id: `r-intr-${++seq}`, status: 'running' }),
    events: async (_id: string, _seq: number, _on: any, signal: AbortSignal) => {
      await new Promise<void>((resolve) => {
        triggerDrop = resolve;
        signal.addEventListener('abort', () => resolve());
      });
    },
    getRun: async () => {
      throw new HermesError(404, 'no such run');
    },
    stop: async () => {
      throw new HermesError(404, 'no such run');
    },
  });

  let r1Started: Routine | null = null;
  let r2Started: Routine | null = null;
  try {
    r1Started = startRoutine(routine1);
    const t1Id = r1Started.last_task_id!;
    await until(() => tasks.get(t1Id)?.status === 'running' && triggerDrop !== null);
    await executeTool('update_task', { task_id: t1Id, status: 'done', result: 'Totals ready: $1,234' });
    const drop = triggerDrop!;
    triggerDrop = null;
    drop();
    await until(() => Boolean(tasks.get(t1Id)?.handover_id));
    expect(tasks.get(t1Id)!.status).toBe('done');
    expect(routines.get(routine1.id)!.last_result).toBe('Totals ready: $1,234');
    // Must NOT post "Pick ... back up?" resume card for an already-done task.
    expect(items.pendingCards().some((c) => c.card?.resume && c.card.task_id === t1Id)).toBe(false);

    // Part B: Interrupted non-done task syncs routine.last_result on failTask AND when user taps "Leave it".
    const routine2 = saveRoutine({
      title: 'Interrupted task routine',
      prompt: 'Fetch report',
      schedule: { kind: 'interval', every_minutes: 60 },
    });
    r2Started = startRoutine(routine2);
    const t2Id = r2Started.last_task_id!;
    await until(() => tasks.get(t2Id)?.status === 'running' && triggerDrop !== null);
    const drop2 = triggerDrop!;
    triggerDrop = null;
    drop2();
    const resumeCard = await (async () => {
      let found: Item | undefined;
      await until(() => {
        found = items.pendingCards().find((c) => c.card?.resume && c.card.task_id === t2Id);
        return Boolean(found);
      });
      return found;
    })();
    expect(resumeCard).toBeTruthy();
    expect(tasks.get(t2Id)!.status).toBe('failed');
    expect(routines.get(routine2.id)!.last_result).toContain('Interrupted');

    // Simulate user tapping "Leave it" even when task result was blank beforehand -> routine.last_result becomes 'Stopped.'.
    const t2Cleared = tasks.get(t2Id)!;
    tasks.save({ ...t2Cleared, result: undefined });
    await actOnCard(resumeCard!.id, 'choose', resumeCard!.card!.options![1]!);
    expect(tasks.get(t2Id)!.status).toBe('cancelled');
    expect(routines.get(routine2.id)!.last_result).toBe('Stopped.');
    removeRoutine(routine2.id);
  } finally {
    removeRoutine(routine1.id);
    restore();
  }
});

test('settlePayment passes merchant_url to browser.fillCard and handles issued-but-unfilled cards clearly', async () => {
  const prevEnv = {
    DUET_CARD_KEY: process.env.DUET_CARD_KEY,
    DUET_CARD_URL: process.env.DUET_CARD_URL,
    DUET_CARD_PROVIDER: process.env.DUET_CARD_PROVIDER,
  };
  const prevFetch = globalThis.fetch;
  const fillCalls: { card: { number: string; cvv: string }; expectedHost: string }[] = [];
  const startedInputs: string[] = [];

  process.env.DUET_CARD_KEY = 'secret-test-key';
  process.env.DUET_CARD_URL = 'https://cards.test';
  process.env.DUET_CARD_PROVIDER = 'generic';

  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ number: '4111111111114242', cvv: '999', exp_month: 12, exp_year: 2030 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;

  let fillMode: 'empty' | 'throw' = 'empty';
  const fillSpy = spyOn(browser, 'fillCard').mockImplementation(async (card, expectedHost) => {
    fillCalls.push({ card, expectedHost });
    if (fillMode === 'throw') throw new Error('tab navigated to another origin');
    return { number: false, expiry: false, cvv: false };
  });

  const restoreHermes = stubHermes({
    hasKey: () => true,
    startRun: async (a: any) => {
      startedInputs.push(String(a.input));
      return { run_id: `r-pay-${startedInputs.length}`, status: 'running' };
    },
    events: async (_id: string, _seq: number, on: any) => {
      on({ event: 'run.completed', seq: 1 });
    },
    stop: async () => ({}),
  });

  try {
    await stopMain().catch(() => {});
    // Case 1: fillCard returns all false (no checkout fields found).
    await executeTool('request_payment', {
      merchant: 'Acme Store',
      merchant_url: 'https://checkout.acme.test/pay',
      items: [{ title: 'Widget', price_cents: 1500 }],
      task_id: 'main',
    });
    const card1 = items.pendingCards().find((c) => c.card?.type === 'payment' && c.card.merchant === 'Acme Store')!;
    const after1 = await actOnCard(card1.id, 'approve');
    expect(fillCalls[0]!.expectedHost).toBe('https://checkout.acme.test/pay');
    expect(after1.card!.card_filled).toBe(false);
    expect(after1.card!.card_summary).toContain('4242');
    expect(after1.card!.card_summary).toContain('not filled');
    await until(() => startedInputs.length >= 1);
    expect(startedInputs[0]).toContain('4242');
    expect(startedInputs[0]).toContain('could not be typed into the browser automatically');
    expect(startedInputs[0]).not.toContain('authorized spending up to');

    // Case 2: fillCard throws (e.g. tab navigated away) -> still records card_summary & card_filled=false!
    fillMode = 'throw';
    await executeTool('request_payment', {
      merchant: 'Acme Store 2',
      merchant_url: 'https://checkout.acme.test/step2',
      items: [{ title: 'Gadget', price_cents: 2500 }],
      task_id: 'main',
    });
    const card2 = items.pendingCards().find((c) => c.card?.type === 'payment' && c.card.merchant === 'Acme Store 2')!;
    const after2 = await actOnCard(card2.id, 'approve');
    expect(after2.card!.card_filled).toBe(false);
    expect(after2.card!.card_summary).toContain('4242');
    expect(after2.card!.card_summary).toContain('not filled');
    await until(() => startedInputs.length >= 2 && !agentState().busy);
    expect(startedInputs[1]).toContain('4242');
    expect(startedInputs[1]).toContain('tab navigated to another origin');
    expect(fillCalls.every((c) => c.card.number === '' && c.card.cvv === '')).toBe(true);
  } finally {
    fillSpy.mockRestore();
    globalThis.fetch = prevFetch;
    if (prevEnv.DUET_CARD_KEY === undefined) delete process.env.DUET_CARD_KEY;
    else process.env.DUET_CARD_KEY = prevEnv.DUET_CARD_KEY;
    if (prevEnv.DUET_CARD_URL === undefined) delete process.env.DUET_CARD_URL;
    else process.env.DUET_CARD_URL = prevEnv.DUET_CARD_URL;
    if (prevEnv.DUET_CARD_PROVIDER === undefined) delete process.env.DUET_CARD_PROVIDER;
    else process.env.DUET_CARD_PROVIDER = prevEnv.DUET_CARD_PROVIDER;
    await stopMain().catch(() => {});
    restoreHermes();
  }
});

test('settleHermesAsk refuses to clobber an expired card in both catch and success paths', async () => {
  const c1 = hermesAsk('approve');
  const err = await settleHermesAsk(c1, 'approved', async () => {
    items.save({ ...c1, card: { ...c1.card!, status: 'expired', decided_at: Date.now() } });
    throw new Error('run ended');
  }).catch((e) => e);
  expect(err).toBeInstanceOf(Error);
  expect(err.message).toContain('ended with its run');
  expect(items.get(c1.id)!.card!.status).toBe('expired');

  const c2 = hermesAsk('approve');
  const res = await settleHermesAsk(c2, 'approved', async () => {
    items.save({ ...c2, card: { ...c2.card!, status: 'expired', decided_at: Date.now() } });
    return {};
  });
  expect(res.card!.status).toBe('expired');
  expect(items.get(c2.id)!.card!.status).toBe('expired');
});

test('mediaPaths extracts Windows drive paths and POSIX paths cleanly, and consume warns on non-abort stream errors', async () => {
  expect(mediaPaths('See MEDIA:C:\\Users\\alice\\out.png and MEDIA:D:/reports/q1.pdf and MEDIA:/tmp/chart.svg done')).toEqual([
    'C:\\Users\\alice\\out.png',
    'D:/reports/q1.pdf',
    '/tmp/chart.svg',
  ]);

  const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
  let attempts = 0;
  const restore = stubHermes({
    hasKey: () => true,
    startRun: async () => ({ run_id: 'r-stream-err', status: 'running' }),
    events: async (_id: string, _seq: number, on: any) => {
      attempts++;
      if (attempts === 1) throw new Error('socket hangup');
      on({ event: 'run.completed', seq: 1 });
    },
    getRun: async () => ({ status: 'running' }),
    stop: async () => ({}),
  });
  try {
    await stopMain().catch(() => {});
    submitUser('stream error test');
    await until(() => attempts >= 2 && !agentState().busy, 4000);
    expect(warnSpy.mock.calls.some((args) => String(args[0]).includes('[runs] event stream error') && String(args[2]).includes('socket hangup'))).toBe(true);
  } finally {
    warnSpy.mockRestore();
    await stopMain().catch(() => {});
    restore();
  }
});

test('post_card enforces session_id and card type on updates and strips blank checklist/metric entries', async () => {
  const ch = channels.create({ name: `cards-${newId().slice(-4)}` });
  const msg = await executeTool('post_card', {
    type: 'checklist',
    title: 'Packing list',
    checklist: [
      { text: 'Passport', done: false },
      { text: '   ', done: true },
      { done: false },
    ],
    task_id: 'main',
  });
  const cardId = msg.match(/card_id="([^"]+)"/)![1]!;
  const created = items.get(cardId)!;
  expect(created.card!.checklist).toEqual([{ text: 'Passport', done: false }]);

  // Same session, mismatched type -> rejected.
  await expect(executeTool('post_card', { card_id: cardId, type: 'note', title: 'Mutate type', task_id: 'main' })).rejects.toThrow(/cannot be updated as note/);
  // Different session -> rejected.
  await expect(executeTool('post_card', { card_id: cardId, type: 'checklist', title: 'Hijack', task_id: `channel:${ch.id}` })).rejects.toThrow(
    /belongs to another conversation/,
  );

  // Metrics strip blank entries and update works within owning session.
  const mMsg = await executeTool('post_card', {
    type: 'metrics',
    title: 'KPIs',
    metrics: [
      { label: 'MRR', value: '$10k', delta: '+5%', tone: 'good' },
      { label: '  ', value: '$0' },
      { label: 'EmptyVal', value: ' ' },
    ],
    task_id: 'main',
  });
  const mId = mMsg.match(/card_id="([^"]+)"/)![1]!;
  expect(items.get(mId)!.card!.metrics).toEqual([{ label: 'MRR', value: '$10k', delta: '+5%', tone: 'good' }]);
  const upd = await executeTool('post_card', { card_id: mId, type: 'metrics', title: 'KPIs v2', metrics: [{ label: 'ARR', value: '$120k' }], task_id: 'main' });
  expect(upd).toBe(`Updated card ${mId}.`);
  expect(items.get(mId)!.card!.title).toBe('KPIs v2');
});

test('archived channels are refused everywhere, deliverable actions follow file.task_id, saveRoutine clears channel_id, and startRoutine preserves pre-advanced next_run', () => {
  const liveCh = channels.create({ name: `live-${newId().slice(-4)}` });
  const deadCh = channels.create({ name: `archived-${newId().slice(-4)}` });
  channels.archive(deadCh.id);

  expect(() => submitUser('hello', undefined, deadCh.id)).toThrow('no such channel');
  expect(() => startUserTask('work', deadCh.id)).toThrow('no such channel');
  expect(() => submitSystem('hook', 'prompt', deadCh.id)).toThrow('no such channel');
  expect(() => saveRoutine({ title: 'R', prompt: 'p', schedule: { kind: 'daily', time: '09:00' }, channel_id: deadCh.id })).toThrow('no such channel');

  const rWithChannel = saveRoutine({ title: 'Routine Ch', prompt: 'run check', schedule: { kind: 'interval', every_minutes: 30 }, channel_id: liveCh.id });
  expect(rWithChannel.channel_id).toBe(liveCh.id);

  // Explicitly passing '' or null clears channel_id back to general.
  const clearedEmpty = saveRoutine({ routine_id: rWithChannel.id, title: 'Routine Ch', prompt: 'run check', schedule: { kind: 'interval', every_minutes: 30 }, channel_id: '' });
  expect(clearedEmpty.channel_id).toBeUndefined();
  const reAdded = saveRoutine({ routine_id: rWithChannel.id, title: 'Routine Ch', prompt: 'run check', schedule: { kind: 'interval', every_minutes: 30 }, channel_id: liveCh.id });
  expect(reAdded.channel_id).toBe(liveCh.id);
  const clearedNull = saveRoutine({ routine_id: rWithChannel.id, title: 'Routine Ch', prompt: 'run check', schedule: { kind: 'interval', every_minutes: 30 }, channel_id: null });
  expect(clearedNull.channel_id).toBeUndefined();

  // startRoutine preserves scheduler's pre-advanced next_run, while runRoutineNow recomputes it.
  const preAdvanced = { ...reAdded, next_run: Date.now() + 9_876_000 };
  const schedStarted = startRoutine(preAdvanced);
  expect(schedStarted.next_run).toBe(preAdvanced.next_run);
  const manualStarted = runRoutineNow(rWithChannel.id);
  expect(manualStarted.next_run).not.toBe(preAdvanced.next_run);
  expect(manualStarted.next_run!).toBeGreaterThan(Date.now());

  // Archived channel fails startRoutine.
  expect(() => startRoutine({ ...rWithChannel, channel_id: deadCh.id })).toThrow('no such channel');
  removeRoutine(rWithChannel.id);

  // Deliverable action & approval resolve channel from file.task_id, falling back to general if task's channel was archived.
  const tLive: Task = { id: newId(), title: 'Dash task', status: 'done', steps: [], created_at: Date.now(), updated_at: Date.now(), background: true, channel_id: liveCh.id };
  tasks.save(tLive, `duet-task-${tLive.id}`);
  const fLive = dash({ task_id: tLive.id });
  const sysLive = deliverableAction(fLive, { action: 'refresh' });
  expect(sysLive.channel_id).toBe(liveCh.id);
  const appLive = deliverableApproval(fLive, { title: 'Send dash report', summary: 'x' });
  expect(appLive.channel_id).toBe(liveCh.id);

  const tDead: Task = { id: newId(), title: 'Dead dash task', status: 'done', steps: [], created_at: Date.now(), updated_at: Date.now(), background: true, channel_id: deadCh.id };
  tasks.save(tDead, `duet-task-${tDead.id}`);
  const fDead = dash({ task_id: tDead.id });
  expect(deliverableAction(fDead, { action: 'refresh' }).channel_id).toBe(GENERAL_CHANNEL);
  expect(deliverableApproval(fDead, { title: 'Send dead dash', summary: 'x' }).channel_id).toBe(GENERAL_CHANNEL);
});

test('request_approval checks draft against hard policy even when content is set, and scans fields individually beyond 20k', async () => {
  await expect(
    executeTool('request_approval', {
      action: 'send_email',
      title: 'Send note',
      destination: 'bank@example.com',
      recipients: ['bank@example.com'],
      content: 'Benign content string',
      draft: 'Please initiate a wire transfer of $5,000 today.',
      summary: 'Follow up',
      task_id: 'main',
    }),
  ).rejects.toThrow(/Bank and wire transfers/);

  // 19k in draft + 19k in content pushes summary past 20k combined, so only per-string scanning catches the AWS key in summary.
  await expect(
    executeTool('request_approval', {
      action: 'post',
      title: 'Post status update',
      destination: 'team-blog',
      content: 'a'.repeat(7900),
      draft: 'b'.repeat(7900),
      summary: `${'c'.repeat(6000)} token=AKIAIOSFODNN7EXAMPLE`,
      task_id: 'main',
    }),
  ).rejects.toThrow(/AWS access key/);
});

test('push notifications include &channel=... in url and channel_id in payload across tools', async () => {
  const payloads: any[] = [];
  const pushSpy = spyOn(webpush, 'sendNotification').mockImplementation(async (_sub: any, body: any) => {
    payloads.push(JSON.parse(String(body)));
    return {} as any;
  });
  saveSubscription({ endpoint: 'https://push.example/url-sub', keys: { p256dh: 'k', auth: 'a' } }, 'dev-url');
  const prevSettings = settings.get();
  settings.update({ quiet_start: '00:00', quiet_end: '00:00', checkins: 'hourly', notify_agent: true, notify_tasks: 'all', max_pushes_per_day: 0 });
  const ch = channels.create({ name: `alerts-${newId().slice(-4)}` });

  try {
    await executeTool('request_approval', { action: 'post', title: 'Approve ch post', destination: '#alerts', summary: 'post it', task_id: `channel:${ch.id}` });
    await executeTool('request_payment', { merchant: 'Coffee Co', merchant_url: 'https://coffee.test/pay', items: [{ title: 'Latte', price_cents: 500 }], task_id: `channel:${ch.id}` });
    await executeTool('ask', { question: 'Which day?', options: ['Mon', 'Tue'], task_id: `channel:${ch.id}` });
    await executeTool('post_brief', { title: 'Alerts brief', entries: [{ title: 'Check invoice' }], task_id: `channel:${ch.id}` });
    await executeTool('notify', { title: 'Heads up alert', body: 'Check #alerts', task_id: `channel:${ch.id}` });

    await until(() => payloads.length >= 5);
    expect(payloads.length).toBeGreaterThanOrEqual(5);
    const channelParam = `&channel=${encodeURIComponent(ch.id)}`;
    for (const p of payloads) {
      expect(p.channel_id).toBe(ch.id);
      expect(p.url).toMatch(new RegExp(`^/\\?card=[^&]+${channelParam.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
      if (p.card_id) expect(p.url).toBe(`/?card=${p.card_id}${channelParam}`);
    }
  } finally {
    db.query('DELETE FROM push_subs WHERE endpoint = ?').run('https://push.example/url-sub');
    settings.update(prevSettings);
    pushSpy.mockRestore();
  }
});

test('deliverFile removes created data/files/<id> directory if tx() throws', async () => {
  const srcDir = mkdtempSync(join(tmpdir(), 'duet-deliver-fail-'));
  const srcFile = join(srcDir, 'report.txt');
  writeFileSync(srcFile, 'secretless test report');
  const filesRoot = join(config.dataDir, 'files');
  const before = existsSync(filesRoot) ? new Set(readdirSync(filesRoot)) : new Set<string>();
  const addSpy = spyOn(files, 'add').mockImplementation(() => {
    throw new Error('simulated sqlite disk full');
  });
  try {
    await expect(executeTool('deliver_file', { path: srcFile, title: 'Broken delivery', task_id: 'main' })).rejects.toThrow('simulated sqlite disk full');
    const after = existsSync(filesRoot) ? readdirSync(filesRoot) : [];
    const leaked = after.filter((name) => !before.has(name));
    expect(leaked).toEqual([]);
  } finally {
    addSpy.mockRestore();
    rmSync(srcDir, { recursive: true, force: true });
  }
});

test('actOnCard preserves follow-up chip on rejected archived channel and falls back to #general on card/payment settlement', async () => {
  const prevEnv = {
    DUET_CARD_KEY: process.env.DUET_CARD_KEY,
    DUET_CARD_URL: process.env.DUET_CARD_URL,
    DUET_CARD_PROVIDER: process.env.DUET_CARD_PROVIDER,
  };
  process.env.DUET_CARD_KEY = 'secret-test-key';
  process.env.DUET_CARD_URL = 'https://cards.test';
  process.env.DUET_CARD_PROVIDER = 'generic';

  const startedRuns: { id: string; input: string }[] = [];
  let seq = 0;
  const restore = stubHermes({
    hasKey: () => true,
    startRun: async (a: any) => {
      const id = `r-arch-card-${++seq}`;
      startedRuns.push({ id, input: String(a.input) });
      return { run_id: id, status: 'running' };
    },
    events: async (_id: string, _seq: number, on: any) => {
      on({ event: 'run.completed', seq: 1 });
    },
    stop: async () => ({}),
  });

  const liveCh = channels.create({ name: `live-fu-${newId().slice(-4)}` });
  const deadCh = channels.create({ name: `dead-fu-${newId().slice(-4)}` });

  try {
    const now = Date.now();
    const deadTask: Task = {
      id: newId(),
      title: 'Archived channel task',
      status: 'done',
      steps: [],
      created_at: now,
      updated_at: now,
      background: true,
      channel_id: deadCh.id,
    };
    tasks.save(deadTask, `duet-task-${deadTask.id}`);

    const deadHandover = items.save({
      id: newId(),
      kind: 'card',
      created_at: now,
      updated_at: now,
      channel_id: deadCh.id,
      task_id: deadTask.id,
      card: {
        type: 'handover',
        title: deadTask.title,
        status: 'info',
        task_id: deadTask.id,
        channel_id: deadCh.id,
        follow_ups: [{ label: 'Dig deeper', message: 'Check Q4 numbers' }],
      },
    });
    const liveHandover = items.save({
      id: newId(),
      kind: 'card',
      created_at: now,
      updated_at: now,
      channel_id: liveCh.id,
      card: {
        type: 'handover',
        title: 'Live handover',
        status: 'info',
        channel_id: liveCh.id,
        follow_ups: [{ label: 'Follow up', message: 'Send live summary' }],
      },
    });

    const appCard = items.save({
      id: newId(),
      kind: 'card',
      created_at: now,
      updated_at: now,
      channel_id: deadCh.id,
      card: {
        type: 'approval',
        title: 'Pending approval in dead channel',
        status: 'pending',
        channel_id: deadCh.id,
        session_id: deadCh.session_id,
      },
    });
    const taskChoiceCard = items.save({
      id: newId(),
      kind: 'card',
      created_at: now,
      updated_at: now,
      channel_id: deadCh.id,
      task_id: deadTask.id,
      card: {
        type: 'choice',
        title: 'Pending task choice without card.channel_id',
        options: ['Yes', 'No'],
        status: 'pending',
        task_id: deadTask.id,
      },
    });
    const payCard = items.save({
      id: newId(),
      kind: 'card',
      created_at: now,
      updated_at: now,
      channel_id: deadCh.id,
      card: {
        type: 'payment',
        title: 'Pay $20.00 to Acme',
        merchant: 'Acme',
        amount_cents: 2000,
        currency: 'USD',
        status: 'pending',
        channel_id: deadCh.id,
        session_id: deadCh.session_id,
      },
    });

    channels.archive(deadCh.id);

    // 1) Archived handover follow-up must fail WITHOUT burning the chip.
    await expect(actOnCard(deadHandover.id, 'follow_up', '0')).rejects.toThrow('no such channel');
    expect(items.get(deadHandover.id)!.card!.follow_ups![0]!.used).toBeUndefined();

    // Live handover follow-up succeeds and marks chip used.
    const usedLive = await actOnCard(liveHandover.id, 'follow_up', '0');
    expect(usedLive.card!.follow_ups![0]!.used).toBe(true);

    // 2) Pending approval, choice (via task_id), and payment cards in an archived channel fall back to #general.
    await actOnCard(appCard.id, 'approve');
    await actOnCard(taskChoiceCard.id, 'choose', 'Yes');
    await actOnCard(payCard.id, 'approve');

    await until(() => startedRuns.length >= 4 && !agentState().busy && agentState().background_running === 0);

    // Archived channel must receive no system notes or new activity runs.
    const deadItems = items.latest(50, deadCh.id).items;
    expect(deadItems.some((i) => i.kind === 'activity' || i.kind === 'system' || i.kind === 'assistant')).toBe(false);

    // #general receives the payment failure system note and all archived-channel fallback runs route to #general.
    const generalItems = items.latest(50, GENERAL_CHANNEL).items;
    expect(generalItems.some((i) => i.kind === 'system' && (i.text ?? '').includes('without a bound merchant site'))).toBe(true);
    const generalRunIds = new Set(generalItems.filter((i) => i.kind === 'activity').map((i) => i.run_id));
    const fallbackRuns = startedRuns.filter(
      (r) => r.input.includes('Pending approval in dead channel') || r.input.includes('Pending task choice without card.channel_id') || r.input.includes('[payment '),
    );
    expect(fallbackRuns).toHaveLength(3);
    for (const r of fallbackRuns) {
      const row = db.query<{ meta: string }, [string]>('SELECT meta FROM runs WHERE id = ?').get(r.id)!;
      expect(JSON.parse(row.meta).spec.channelId).toBe(GENERAL_CHANNEL);
    }
    expect(fallbackRuns.filter((r) => generalRunIds.has(r.id)).length).toBe(2);
    expect(startedRuns.some((r) => r.input.includes('Send live summary'))).toBe(true);
  } finally {
    if (prevEnv.DUET_CARD_KEY === undefined) delete process.env.DUET_CARD_KEY;
    else process.env.DUET_CARD_KEY = prevEnv.DUET_CARD_KEY;
    if (prevEnv.DUET_CARD_URL === undefined) delete process.env.DUET_CARD_URL;
    else process.env.DUET_CARD_URL = prevEnv.DUET_CARD_URL;
    if (prevEnv.DUET_CARD_PROVIDER === undefined) delete process.env.DUET_CARD_PROVIDER;
    else process.env.DUET_CARD_PROVIDER = prevEnv.DUET_CARD_PROVIDER;
    await until(() => !agentState().busy && agentState().background_running === 0 && !runs.orphaned().some((r) => r.session_id === liveCh.session_id || r.session_id === deadCh.session_id));
    await stopMain().catch(() => {});
    restore();
  }
});
