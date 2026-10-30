import { expect, test } from 'bun:test';
import type { FileEntry, Item, Page, Task } from '../shared/types';
import { items, newId, runs, tasks } from './db';
import { HermesError, hermes } from './hermes';
import { GENERAL_CHANNEL } from './schema';
import { agentState, cancelTask, deliverableAction, deliverableApproval, executeTool, mainSessionId, pageRefreshing, recoverOrphans, settleHermesAsk, startUserTask, stopMain } from './runner';

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
    await until(() => inputs.some((i) => i.includes('rework the deck')));
    expect(inputs.some((i) => i.includes('rework the deck'))).toBe(true);
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
