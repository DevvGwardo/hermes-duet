import { describe, expect, test } from 'bun:test';
import type { Routine, RoutineSchedule } from '../shared/types';
import { createPairCode, deviceCookie, redeemPairCode } from './auth';
import { routines, tasks, newId } from './db';
import { hermes } from './hermes';
import { handleApp } from './index';
import { advanceRoutine, dueRoutines, nextRun, normalizeWeekdays, routineInput, scheduleLabel, zonedWallToUtc } from './routines';
import { executeTool, runRoutineNow, startRoutine } from './runner';
import { runDueRoutines } from './scheduler';
import { TOOLS } from './tools';

// Never let a test routine reach a real Hermes gateway.
hermes.hasKey = () => false;

const NY = 'America/New_York';
const at = (date: string, minutes: number) => zonedWallToUtc(NY, date, minutes);

function routine(over: Partial<Routine> = {}): Routine {
  const now = Date.now();
  return {
    id: newId(),
    title: 'Weekly inbox summary',
    prompt: 'Summarize the last week of messages.',
    schedule: { kind: 'weekly', time: '09:00', weekdays: [1] },
    enabled: true,
    created_at: now,
    updated_at: now,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('routine validation', () => {
  test('a routine needs a title and instructions', () => {
    expect(() => routineInput({})).toThrow('a routine needs a title');
    expect(() => routineInput({ title: 'x' })).toThrow('a routine needs instructions');
    expect(() => routineInput({ title: 'x', prompt: '  ' })).toThrow('a routine needs instructions');
  });

  test('title and prompt are bounded', () => {
    expect(() => routineInput({ title: 't'.repeat(121), prompt: 'p' })).toThrow('at most 120');
    expect(() => routineInput({ title: 't', prompt: 'p'.repeat(6001) })).toThrow('at most 6000');
    expect(routineInput({ title: 't', prompt: 'p', schedule: { kind: 'daily', time: '09:00' } }).title).toBe('t');
  });

  test('times must be 24-hour HH:MM', () => {
    for (const time of ['9:00', '09:60', '24:00', 'abc', '']) {
      expect(() => routineInput({ title: 't', prompt: 'p', schedule: { kind: 'daily', time } })).toThrow('HH:MM');
    }
    expect(routineInput({ title: 't', prompt: 'p', schedule: { kind: 'daily', time: '09:00' } }).schedule).toEqual({ kind: 'daily', time: '09:00' });
  });

  test('weekly routines need at least one weekday, normalized to 0-6', () => {
    expect(() => routineInput({ title: 't', prompt: 'p', schedule: { kind: 'weekly', time: '09:00', weekdays: [] } })).toThrow('at least one weekday');
    expect(() => routineInput({ title: 't', prompt: 'p', schedule: { kind: 'weekly', time: '09:00', weekdays: [8] } })).toThrow('0-6');
    expect(routineInput({ title: 't', prompt: 'p', schedule: { kind: 'weekly', time: '09:00', weekdays: [7, 1, 1] } }).schedule).toEqual({
      kind: 'weekly',
      time: '09:00',
      weekdays: [0, 1],
    });
  });

  test('intervals are whole minutes between 15 and 10080', () => {
    for (const every_minutes of [14, 10081, 1.5, NaN]) {
      expect(() => routineInput({ title: 't', prompt: 'p', schedule: { kind: 'interval', every_minutes } })).toThrow('every_minutes');
    }
    expect(routineInput({ title: 't', prompt: 'p', schedule: { kind: 'interval', every_minutes: 15 } }).schedule).toEqual({ kind: 'interval', every_minutes: 15 });
    expect(routineInput({ title: 't', prompt: 'p', schedule: { kind: 'interval', every_minutes: 10080 } }).schedule).toEqual({ kind: 'interval', every_minutes: 10080 });
  });

  test('an unknown schedule kind is refused', () => {
    expect(() => routineInput({ title: 't', prompt: 'p', schedule: { kind: 'hourly' } })).toThrow('daily, weekly or interval');
  });

  test('enabled defaults to true and can be turned off', () => {
    expect(routineInput({ title: 't', prompt: 'p', schedule: { kind: 'daily', time: '09:00' } }).enabled).toBe(true);
    expect(routineInput({ title: 't', prompt: 'p', schedule: { kind: 'daily', time: '09:00' }, enabled: false }).enabled).toBe(false);
  });
});

test('weekday normalization accepts both 0-6 and 1-7 and dedupes', () => {
  expect(normalizeWeekdays([1, 2, 3])).toEqual([1, 2, 3]);
  expect(normalizeWeekdays([7])).toEqual([0]);
  expect(normalizeWeekdays([0, 7])).toEqual([0]);
  expect(normalizeWeekdays([3, 1, 2])).toEqual([1, 2, 3]);
  expect(() => normalizeWeekdays('mon')).toThrow('weekdays list');
  expect(() => normalizeWeekdays([1.5])).toThrow('whole numbers');
});

// ---------------------------------------------------------------------------
// Next run
// ---------------------------------------------------------------------------

describe('nextRun', () => {
  test('daily: later today when the time has not passed, tomorrow when it has', () => {
    expect(nextRun({ kind: 'daily', time: '09:00' }, at('2026-01-15', 8 * 60), NY)).toBe(at('2026-01-15', 9 * 60));
    expect(nextRun({ kind: 'daily', time: '09:00' }, at('2026-01-15', 10 * 60), NY)).toBe(at('2026-01-16', 9 * 60));
    // Exactly on the hour is not "after" the reference, so it moves to the next day.
    expect(nextRun({ kind: 'daily', time: '09:00' }, at('2026-01-15', 9 * 60), NY)).toBe(at('2026-01-16', 9 * 60));
  });

  test('weekly: the same day is still ahead, and a past slot moves to next week', () => {
    const weekly: RoutineSchedule = { kind: 'weekly', time: '09:00', weekdays: [1] }; // Mondays
    expect(nextRun(weekly, at('2026-01-12', 8 * 60), NY)).toBe(at('2026-01-12', 9 * 60)); // Monday 8am
    expect(nextRun(weekly, at('2026-01-12', 10 * 60), NY)).toBe(at('2026-01-19', 9 * 60)); // Monday 10am
    expect(nextRun(weekly, at('2026-01-13', 10 * 60), NY)).toBe(at('2026-01-19', 9 * 60)); // Tuesday
  });

  test('weekly picks the next matching weekday, not just the same day', () => {
    const weekly: RoutineSchedule = { kind: 'weekly', time: '11:00', weekdays: [1, 3] }; // Mon + Wed
    expect(nextRun(weekly, at('2026-01-14', 10 * 60), NY)).toBe(at('2026-01-14', 11 * 60)); // Wednesday 10am
    expect(nextRun(weekly, at('2026-01-14', 12 * 60), NY)).toBe(at('2026-01-19', 11 * 60)); // -> Monday
  });

  test('interval is a plain duration from the reference', () => {
    const from = at('2026-01-15', 10 * 60);
    expect(nextRun({ kind: 'interval', every_minutes: 360 }, from, NY)).toBe(from + 360 * 60_000);
    expect(nextRun({ kind: 'interval', every_minutes: 15 }, from, NY)).toBe(from + 15 * 60_000);
  });

  test('DST keeps the wall clock: 9am stays 9am across the spring forward', () => {
    // 2026-03-08: clocks jump at 2am. 9am is EDT (UTC-4) on both sides of the change.
    expect(nextRun({ kind: 'daily', time: '09:00' }, at('2026-03-08', 8 * 60), NY)).toBe(Date.UTC(2026, 2, 8, 13));
    expect(nextRun({ kind: 'daily', time: '09:00' }, at('2026-03-08', 10 * 60), NY)).toBe(Date.UTC(2026, 2, 9, 13));
  });
});

describe('scheduleLabel', () => {
  test('daily and weekly read like the sentence the user wrote', () => {
    expect(scheduleLabel({ kind: 'daily', time: '09:00' })).toBe('Every day at 09:00');
    expect(scheduleLabel({ kind: 'weekly', time: '09:00', weekdays: [1] })).toBe('Every Monday at 09:00');
    expect(scheduleLabel({ kind: 'weekly', time: '09:00', weekdays: [1, 2, 3, 4, 5] })).toBe('Every weekday at 09:00');
    expect(scheduleLabel({ kind: 'weekly', time: '09:00', weekdays: [0, 6] })).toBe('Every Saturday, Sunday at 09:00');
  });

  test('intervals collapse to days or hours when they divide evenly', () => {
    expect(scheduleLabel({ kind: 'interval', every_minutes: 360 })).toBe('Every 6 hours');
    expect(scheduleLabel({ kind: 'interval', every_minutes: 60 })).toBe('Every 1 hour');
    expect(scheduleLabel({ kind: 'interval', every_minutes: 1440 })).toBe('Every 1 day');
    expect(scheduleLabel({ kind: 'interval', every_minutes: 10080 })).toBe('Every 7 days');
    expect(scheduleLabel({ kind: 'interval', every_minutes: 15 })).toBe('Every 15 minutes');
  });
});

test('dueRoutines returns only enabled routines whose next run has passed', () => {
  const now = Date.now();
  const due = routine({ next_run: now - 1000 });
  const later = routine({ next_run: now + 60_000 });
  const paused = routine({ next_run: now - 1000, enabled: false });
  const noNext = routine({ next_run: undefined });
  expect(dueRoutines([due, later, paused, noNext], now).map((r) => r.id)).toEqual([due.id]);
});

test('advanceRoutine moves the next run past now, which is what keeps a slow run from double-firing', () => {
  const now = Date.now();
  const r = routine({ next_run: now - 1000, schedule: { kind: 'daily', time: '09:00' } });
  const advanced = advanceRoutine(r, now, NY);
  expect(advanced.next_run!).toBeGreaterThan(now);
  expect(dueRoutines([advanced], now)).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

describe('routines db', () => {
  test('save, read, list in next-run order, and remove', () => {
    const first = routines.save(routine({ next_run: Date.now() + 5000 }));
    const second = routines.save(routine({ next_run: Date.now() + 1000 }));
    expect(routines.get(first.id)?.title).toBe(first.title);
    const ids = routines.all().map((r) => r.id);
    expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id));
    expect(routines.remove(first.id)).toBe(true);
    expect(routines.get(first.id)).toBeNull();
    expect(routines.remove(first.id)).toBe(false);
    routines.remove(second.id);
  });
});

// ---------------------------------------------------------------------------
// Runner + scheduler
// ---------------------------------------------------------------------------

test('startRoutine stamps the run on the routine and starts a task that carries the routine id', () => {
  const r = routines.save(routine());
  const started = startRoutine(r);
  expect(started.last_run!).toBeGreaterThan(0);
  expect(started.last_task_id).toBeTruthy();
  expect(started.last_result).toBe('Started');
  expect(started.next_run!).toBeGreaterThan(Date.now());
  const task = tasks.get(started.last_task_id!);
  expect(task?.routine_id).toBe(r.id);
  expect(task?.instructions).toBe(r.prompt);
  routines.remove(r.id);
});

test('runRoutineNow starts a saved routine immediately', () => {
  const r = routines.save(routine());
  const started = runRoutineNow(r.id);
  expect(started.last_task_id).toBeTruthy();
  routines.remove(r.id);
});

test('a routine that fails to start still advances its next run and records the failure', () => {
  // A channel that does not exist makes startRoutine throw after the scheduler has advanced the schedule.
  const now = Date.now();
  const r = routines.save(routine({ next_run: now - 1000, channel_id: 'chan-no-such' }));
  const advanced = routines.save(advanceRoutine(r, now, NY));
  try {
    startRoutine(advanced);
  } catch (e: any) {
    const cur = routines.get(r.id);
    if (cur) routines.save({ ...cur, last_result: `Couldn't start: ${e?.message ?? e}` });
  }
  const after = routines.get(r.id)!;
  expect(after.next_run!).toBeGreaterThan(now);
  expect(after.last_result).toContain("Couldn't start");
  routines.remove(r.id);
});

test('the scheduler runs a due routine once and advances it before launching', () => {
  const now = Date.now();
  const r = routines.save(routine({ next_run: now - 1000 }));
  const before = tasks.recent().length;
  runDueRoutines(now);
  const afterFirst = tasks.recent().length;
  expect(afterFirst).toBe(before + 1);
  const stored = routines.get(r.id)!;
  expect(stored.next_run!).toBeGreaterThan(now);
  expect(stored.last_task_id).toBeTruthy();
  // A second tick at the same instant finds nothing: the advance is persisted before the task launches.
  runDueRoutines(now);
  expect(tasks.recent().length).toBe(afterFirst);
  routines.remove(r.id);
});

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

test('the save_routine tool tells the agent each run is a self-contained background task', () => {
  const tool = TOOLS.find((t) => t.name === 'save_routine')!;
  expect(tool.description).toContain('background task');
  expect(tool.description).toMatch(/self-contained/);
  expect(TOOLS.find((t) => t.name === 'remove_routine')).toBeTruthy();
});

test('save_routine and remove_routine round-trip through the tool surface', async () => {
  const msg = await executeTool('save_routine', { title: 'Tool routine', prompt: 'Do the thing.', schedule: { kind: 'interval', every_minutes: 360 } });
  expect(msg).toContain('Every 6 hours');
  const saved = routines.all().find((r) => r.title === 'Tool routine');
  expect(saved).toBeTruthy();
  expect(saved!.next_run).toBeGreaterThan(Date.now());
  const removed = await executeTool('remove_routine', { routine_id: saved!.id });
  expect(removed).toContain('removed');
  expect(routines.get(saved!.id)).toBeNull();
});

// ---------------------------------------------------------------------------
// HTTP routes
// ---------------------------------------------------------------------------

const BASE = 'http://127.0.0.1:7456';
let cookie: string | undefined;
async function paired(): Promise<string> {
  if (cookie) return cookie;
  const { code } = createPairCode();
  const token = await redeemPairCode(code, 'test phone');
  if (!token) throw new Error('could not pair the test device');
  cookie = deviceCookie(token, false).split(';')[0]!;
  return cookie;
}
const app = (path: string, init: RequestInit = {}) => handleApp(new Request(`${BASE}${path}`, init));
const authed = async (path: string, init: RequestInit = {}) => app(path, { ...init, headers: { cookie: await paired(), ...(init.headers as Record<string, string>) } });
const jsonPost = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const daily = { kind: 'daily', time: '09:00' } as const;

describe('routines routes', () => {
  test('an unpaired request is refused', async () => {
    expect((await app('/api/routines')).status).toBe(401);
  });

  test('the list starts as an array', async () => {
    const res = await authed('/api/routines');
    expect(res.status).toBe(200);
    expect(Array.isArray(((await res.json()) as any).routines)).toBe(true);
  });

  test('create validates, then the routine is listed with its next run', async () => {
    const bad = await authed('/api/routines', jsonPost({ title: 'x', prompt: 'p', schedule: { kind: 'daily', time: '9am' } }));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error).toContain('HH:MM');

    const res = await authed('/api/routines', jsonPost({ title: 'Weekly summary', prompt: 'Summarize.', schedule: { kind: 'weekly', time: '09:00', weekdays: [1] } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.routine.title).toBe('Weekly summary');
    expect(body.routine.schedule.weekdays).toEqual([1]);
    expect(body.routine.next_run).toBeGreaterThan(Date.now());
    const listed = ((await (await authed('/api/routines')).json()) as any).routines as any[];
    expect(listed.some((r) => r.id === body.routine.id)).toBe(true);
  });

  test('posting an id updates in place, and an unknown id is a 404', async () => {
    const created = ((await (await authed('/api/routines', jsonPost({ title: 'Before', prompt: 'p', schedule: daily }))).json()) as any).routine;
    const res = await authed('/api/routines', jsonPost({ id: created.id, title: 'After', prompt: 'p2', schedule: daily }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.routine.id).toBe(created.id);
    expect(body.routine.title).toBe('After');
    expect(body.routine.prompt).toBe('p2');

    const missing = await authed('/api/routines', jsonPost({ id: 'routine-no-such', title: 'x', prompt: 'p', schedule: daily }));
    expect(missing.status).toBe(404);
  });

  test('an update that does not mention enabled keeps the paused state', async () => {
    const created = ((await (await authed('/api/routines', jsonPost({ title: 'Paused', prompt: 'p', schedule: daily, enabled: false }))).json()) as any).routine;
    expect(created.enabled).toBe(false);
    const updated = ((await (await authed('/api/routines', jsonPost({ id: created.id, title: 'Still paused', prompt: 'p', schedule: daily }))).json()) as any).routine;
    expect(updated.enabled).toBe(false);
  });

  test('pause and resume flip enabled and move the next run', async () => {
    const created = ((await (await authed('/api/routines', jsonPost({ title: 'Pause me', prompt: 'p', schedule: daily }))).json()) as any).routine;
    const paused = await authed(`/api/routines/${created.id}/pause`, { method: 'POST' });
    expect(paused.status).toBe(200);
    expect(((await paused.json()) as any).routine.enabled).toBe(false);
    const resumed = await authed(`/api/routines/${created.id}/resume`, { method: 'POST' });
    expect(resumed.status).toBe(200);
    const body = (await resumed.json()) as any;
    expect(body.routine.enabled).toBe(true);
    expect(body.routine.next_run).toBeGreaterThan(Date.now());
  });

  test('run starts the routine now, and a missing routine is a 404', async () => {
    const created = ((await (await authed('/api/routines', jsonPost({ title: 'Run me', prompt: 'p', schedule: daily }))).json()) as any).routine;
    const res = await authed(`/api/routines/${created.id}/run`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.routine.last_task_id).toBeTruthy();
    expect(body.routine.last_result).toBe('Started');
    expect((await authed('/api/routines/routine-no-such/run', { method: 'POST' })).status).toBe(404);
  });

  test('delete removes it, and a second delete is a 404', async () => {
    const created = ((await (await authed('/api/routines', jsonPost({ title: 'Delete me', prompt: 'p', schedule: daily }))).json()) as any).routine;
    const res = await authed(`/api/routines/${created.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect((await authed(`/api/routines/${created.id}`, { method: 'DELETE' })).status).toBe(404);
    expect(routines.get(created.id)).toBeNull();
  });

  test('a wrong method answers 405 with Allow', async () => {
    const res = await authed('/api/routines', { method: 'PUT' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toContain('GET');
  });
});
