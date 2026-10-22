#!/usr/bin/env bun
// Throwaway demo instance with made-up content: try the UI (or regenerate README screenshots)
// without touching your real thread. Data lives in a temp dir; the scheduler is off.
//   bun scripts/demo.ts            → http://127.0.0.1:7466  (pair with: bun scripts/demo.ts pair)
//   bun scripts/demo.ts --reset    → wipe and reseed first

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const DEMO_DIR = join(tmpdir(), 'hermes-duet-demo');
export const DEMO_PORT = 7466;
export const DEMO_INTERNAL_PORT = 7467;

process.env.DUET_DATA_DIR = DEMO_DIR;
process.env.DUET_PORT = String(DEMO_PORT);
process.env.DUET_INTERNAL_PORT = String(DEMO_INTERNAL_PORT);
process.env.DUET_DISABLE_SCHEDULER = '1';
process.env.DUET_CONTEXT_FILE = join(DEMO_DIR, 'none.md');

async function seed() {
  const { files, items, kv, tasks } = await import('../server/db.ts');
  type Item = import('../shared/types.ts').Item;

  const base = new Date();
  base.setHours(7, 30, 0, 0);
  let n = 0;
  const id = () => `demo${String(n++).padStart(4, '0')}`;
  const at = (mins: number) => base.getTime() + mins * 60_000;
  const save = (i: Partial<Item> & { kind: Item['kind'] }, mins: number) =>
    items.save({ id: id(), created_at: at(mins), updated_at: at(mins), run_id: null, task_id: null, ...i } as Item);

  save(
    {
      kind: 'card',
      card: {
        type: 'brief',
        status: 'info',
        title: 'Good morning. 4 things need you today.',
        updated_label: 'Updated 7:30 AM',
        entries: [
          { title: 'Dana’s contract redline is due at noon', detail: 'Two changes: payment terms (net 45 → net 30) and the termination notice (60 → 30 days).', priority: 'high', action_label: 'Summarize the changes', action_message: 'Summarize Dana’s redline' },
          { title: 'Card on file expires Friday', detail: 'Two hosting accounts bill it. Update it before the 1st to avoid a failed charge.', priority: 'high' },
          { title: '3 unread from the design partner', detail: 'Mostly scheduling; one asks for the Q4 roadmap.', priority: 'medium', action_label: 'Draft replies', action_message: 'Draft replies to the design partner' },
          { title: 'Overnight: competitor pricing scan finished', detail: '12 competitors compared. The sheet is in Make.', priority: 'low' },
        ],
      },
    },
    0,
  );
  save({ kind: 'user', text: 'Draft a reply to Dana: accept net 30 but keep the 60-day notice.' }, 9);
  save(
    {
      kind: 'activity',
      run_id: 'r1',
      activity: {
        run_id: 'r1',
        status: 'done',
        steps: [
          { id: 's1', name: 'mail_search', label: 'Searched mail for "Dana redline"', status: 'done', started_at: at(9), ended_at: at(9) + 2000 },
          { id: 's2', name: 'read_file', label: 'Read MSA_v3_redline.docx', status: 'done', started_at: at(9), ended_at: at(9) + 3000 },
          { id: 's3', name: 'mcp__duet__request_approval', label: 'Asked you before sending', status: 'done', started_at: at(10), ended_at: at(10) + 500 },
        ],
      },
    },
    9,
  );
  save({ kind: 'assistant', run_id: 'r1', text: 'Drafted. I accepted **net 30**, held the **60-day notice**, and proposed signing on Oct 28. It’s ready to send when you are.' }, 10);
  save(
    {
      kind: 'card',
      card: {
        type: 'approval',
        status: 'pending',
        title: 'Send the reply to Dana',
        action_label: 'Send',
        body: '**To:** Dana Whitfield · **Re:** MSA redline\n\n> Hi Dana, thanks for the quick turn. Net 30 works for us. We’d like to keep the 60-day termination notice as written. If that works, can we target signing on Oct 28?',
      },
    },
    10,
  );
  save({ kind: 'user', text: 'Also build me a weekly metrics dashboard I can check on Mondays.' }, 14);
  save({ kind: 'assistant', run_id: 'r2', text: 'On it. It’s running in the background, and I’ll ping you when it’s ready.' }, 14);
  save(
    {
      kind: 'card',
      card: {
        type: 'checklist',
        status: 'info',
        title: 'Q4 launch checklist',
        checklist: [
          ...['Domain + SSL', 'Pricing page copy', 'Stripe live keys', 'Status page', 'Docs search', 'Onboarding emails', 'Analytics events', 'Support inbox', 'Changelog post', 'Status alerts', 'Legal pages', 'Press kit'].map((text) => ({ text, done: true })),
          ...['Launch thread', 'Investor update', 'Customer webinar', 'Referral program', 'Pricing A/B test', 'Post-launch retro'].map((text) => ({ text, done: false })),
        ],
      },
    },
    22,
  );
  save(
    {
      kind: 'card',
      card: {
        type: 'metrics',
        status: 'info',
        title: 'Weekly pulse',
        updated_label: 'Mon 5:30 AM',
        metrics: [
          { label: 'Revenue', value: '$18.4k', delta: '+6% wk', tone: 'good' },
          { label: 'Active users', value: '2,310', delta: '+3% wk', tone: 'good' },
          { label: 'Churn', value: '2.1%', delta: '−0.4 pt', tone: 'good' },
          { label: 'Open tickets', value: '14', delta: '+5', tone: 'bad' },
        ],
      },
    },
    41,
  );

  const dir = join(DEMO_DIR, 'files', 'f1');
  mkdirSync(dir, { recursive: true });
  const dash = join(dir, 'weekly-dashboard.html');
  writeFileSync(dash, DASHBOARD_HTML);
  files.add({ id: 'f1', title: 'Weekly metrics dashboard', name: 'weekly-dashboard.html', mime: 'text/html', size: DASHBOARD_HTML.length, task_id: 'task1', created_at: at(43) }, dash);
  save({ kind: 'assistant', task_id: 'task1', run_id: 'r3', text: 'Your weekly dashboard is ready: revenue, actives, churn and support load, refreshed every Monday at 5:30 AM.' }, 43);
  save({ kind: 'card', task_id: 'task1', card: { type: 'file', status: 'info', title: 'Weekly metrics dashboard', body: 'One page and phone friendly. Tap a tile for the trend.', file_id: 'f1' } }, 43);
  save(
    {
      kind: 'card',
      card: { type: 'choice', status: 'pending', title: 'Move the investor call to Thursday 2 PM?', body: 'Wednesday now conflicts with the dentist. Thursday 2–3 PM is open for both of you.', options: ['Yes, move it', 'Keep Wednesday'] },
    },
    47,
  );

  const now = Date.now();
  tasks.save(
    {
      id: 'task2',
      title: 'Investor update deck',
      status: 'running',
      progress: 'Pulling October numbers from the metrics sheet',
      background: true,
      created_at: now - 600_000,
      updated_at: now - 60_000,
      steps: [
        { text: 'Outline from last quarter’s deck', done: true },
        { text: 'Pull October metrics', done: false },
        { text: 'Draft 8 slides', done: false },
        { text: 'Deliver for review', done: false },
      ],
    },
    'duet-task-task2',
  );
  tasks.save(
    { id: 'task1', title: 'Weekly metrics dashboard', status: 'done', result: 'Built and delivered the dashboard (4 tiles, Monday refresh).', background: true, created_at: at(14), updated_at: at(43), steps: [{ text: 'Find data sources', done: true }, { text: 'Build page', done: true }, { text: 'Deliver', done: true }] },
    'duet-task-task1',
  );
  kv.set('settings', { brief_enabled: true, brief_time: '07:30', checkins: 'off', quiet_start: '21:30', quiet_end: '07:00', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
}

const DASHBOARD_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Weekly pulse</title>
<style>body{margin:0;font:15px/1.5 system-ui,sans-serif;color:#f3eee3;background:#0e0e0e;min-height:100vh;padding:28px}
h1{font-weight:800;margin:0 0 4px}p{color:#b3ac9d;margin:0 0 22px;font:12px ui-monospace,monospace;letter-spacing:.14em;text-transform:uppercase}
.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:16px}.t{background:#161616;border:1.5px solid #f3eee3;border-radius:8px;padding:16px;box-shadow:5px 5px 0 #000}
.l{font:12px ui-monospace,monospace;color:#7a746a;letter-spacing:.12em;text-transform:uppercase}.v{font:700 30px ui-monospace,monospace;text-shadow:2px 2px 0 rgba(205,133,63,.55)}.d{font:12px ui-monospace,monospace;color:#8fe39a}.d.b{color:#ff6b6b}</style></head>
<body><h1>Weekly pulse</h1><p>Sample data · refreshed Mon 5:30 AM</p><div class="g">
<div class="t"><div class="l">Revenue</div><div class="v">$18.4k</div><div class="d">+6% wk</div></div>
<div class="t"><div class="l">Active users</div><div class="v">2,310</div><div class="d">+3% wk</div></div>
<div class="t"><div class="l">Churn</div><div class="v">2.1%</div><div class="d">−0.4 pt</div></div>
<div class="t"><div class="l">Open tickets</div><div class="v">14</div><div class="d b">+5</div></div></div></body></html>`;

// Entry point last: seed() reads DASHBOARD_HTML, which must be initialized first.
if (import.meta.main) {
  if (process.argv.includes('pair')) {
    const token = await Bun.file(join(DEMO_DIR, 'internal.token')).text();
    const res = await fetch(`http://127.0.0.1:${DEMO_INTERNAL_PORT}/internal/pair`, { method: 'POST', headers: { authorization: `Bearer ${token.trim()}` } });
    console.log(`Pairing code: ${((await res.json()) as any).code}  →  http://127.0.0.1:${DEMO_PORT}`);
    process.exit(0);
  }
  if (process.argv.includes('--reset')) rmSync(DEMO_DIR, { recursive: true, force: true });
  const fresh = !existsSync(join(DEMO_DIR, 'duet.db'));
  mkdirSync(DEMO_DIR, { recursive: true });
  if (fresh) await seed();
  await import('../server/index.ts');
  console.log(`[demo] ${fresh ? 'seeded' : 'reusing'} ${DEMO_DIR}. Pair with: bun scripts/demo.ts pair`);
}
