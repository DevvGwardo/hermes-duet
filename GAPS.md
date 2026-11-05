# GAPS — audit outcome

A 10-agent audit of `hermes-duet` (architect, backend, frontend, api, data, test, debug, security, perf, reviewer)
produced the findings below. This file is now the record of what happened to each one: **fixed**, **still open** (with
why), or **rejected** (the crew was wrong — do not re-investigate without new evidence).

**Baseline at audit time:** 348 tests pass, `tsc` clean. **Now:** 438 tests pass, `tsc` clean, `bun run build` clean.

Line numbers in the original findings refer to commit `8fbabc7`; they have moved.

---

## 1. Runner correctness — `server/runner.ts`

| # | Finding | Status |
|---|---|---|
| 1.1 | Card persisted `approved` before the Hermes POST | **Fixed** `c4d2c7e` |
| 1.2 | Stop never settles the lane locally | **Fixed** `47c8e91` (one residual, below) |
| 1.3 | Tool-call attribution guesses | **Fixed** `b6bcbaa` |
| 1.4 | Restart reattach drops steers and replay cursors | **Fixed** `4a91be4` |
| 1.5 | Timeout abort is local-only, so "Try again" can double the work | **Fixed** `9803c9f` |
| 1.6 | Steer-failure enqueue can double-queue | **Fixed** `dfc1f03` |
| 1.7 | Non-atomic multi-write sequences | **Fixed** `dfc1f03`, `c9820db` |
| 1.8 | `lanes` map is never evicted | **Fixed** `dfc1f03` |
| 1.9 | No graceful shutdown | **Fixed** `dfc1f03` |

**1.1** `settleHermesAsk` awaits `hermes.approve`/`clarify`; the card stays `pending` until it resolves, goes back to
`pending` with `card.error` (and its decision cleared) when it fails, and a per-card in-flight set refuses a double tap.
Tests fail against the old fire-and-forget ordering.

**1.2** `stopRun` settles the lane on our own clock: `finish` immediately on refusal/404, after a 1 s grace if Hermes
accepts but never sends a terminal event, at 5 s if the POST does not answer. `finish` was already idempotent.
*Residual closed* `4074432`: the window between a lane going active and `run.id` arriving is exactly the length of the
start POST, and a Stop tapped inside it used to do nothing — worse, `cancelTask` had already written `cancelled`, so
the agent kept posting cards under a task the user believed was stopped. `stopRun` now sets `stopRequested` when there
is no id yet, `launchRun` honours it the moment the id lands, and a transient start failure behind a stop is dropped
instead of quietly re-queued. The same commit closed a harder failure: everything `launch` did after `l.active = run`
was outside its try, and `pumpAll` calls it fire-and-forget, so a throw there left the lane held forever with no
watchdog to release it. It now funnels through `finish`, which always releases the lane.

**1.3** Step matching is still tried first. With two or more live turns and no unique match, the call is **refused**
("nothing was posted", the candidate ids, and the `task_id` to retry with) instead of falling back to the main lane.
`task_id: "main"` is the escape hatch for the main conversation; an unknown `task_id` is refused rather than silently
posted to chat. *Correction to the original finding:* the shim does **not** carry task context — it is one process
serving every session — so attribution still depends on the model passing `task_id`, which the persona instructs.

**1.4** Run meta now carries `steers`, `lastSeq` and `lastEventAt`, written at start, throttled once a second from
`onEvent`, and immediately when a steer is added or re-queued. A restored cursor resumes into the segment that was
still streaming; a run with no cursor replays from 0 as before.

**1.5** The watchdog asks Hermes and waits, bounded (`stopped` / `gone` / `unknown`). `unknown` still releases the lane
but sets `stopUnconfirmed`, and the "Try again" card says the agent may still be finishing, so the user knows not to tap
immediately. This warns rather than fences; the alternative is leaving the user with no way forward.

**1.6** A steer whose POST fails after its run has already finished is not queued again — `finish` had its chance to
replay whatever Hermes reported as undelivered.

**1.7** Transactions (`tx`) around: the handover card + `handover_id`, a delivered file + its standing page pointer,
`tasks.save` + its FTS row, `files.add`/`update` + FTS, `pages.save` + FTS, `devices.revoke`'s two deletes, and
`channels.create`'s read-then-insert (a lost slug race is now "already archived", not a 500).

**1.8** A lane with no active run and an empty queue is deleted from the map; `lane()` recreates it on demand.

**1.9** SIGTERM stops both listeners, aborts live event streams (rows stay `running` so `recoverOrphans` reattaches
them), waits 150 ms for the last write, then closes the database.

---

## 2. HTTP surface — `server/index.ts`

| # | Finding | Status |
|---|---|---|
| 2.1 | Exact-match routing falls through to the SPA | **Fixed** `c1acdf3` |
| 2.2 | Error handler echoes internals | **Fixed** `c1acdf3` |
| 2.3 | Upload limits disagree | **Fixed** (limit); streaming still open |
| 2.4 | Loopback internal API skips public validation | **Fixed** `c1acdf3` |
| 2.5 | `/api/browser/input` is an `any` cast | **Fixed** `c1acdf3` |
| 2.6 | No idempotency or rate limits on mutations | **Fixed** (Round 4) |
| 2.7 | No 405/OPTIONS, no `/api/version` | **Fixed** (405 + version) `c1acdf3` |

**2.1** A trailing slash is the same route (`/api/items/?before=…` no longer 404s) and every `/api` path — including
bare `/api` — answers JSON, never the app shell.

**2.2** `apiError` returns a small code plus a request id. Validation sentences the server wrote ("no such channel")
stay readable; errno paths, gateway bodies and stack fragments are replaced with a code and logged with that id.

**2.3** One constant: the 40 MB gate now uses `uploads.ts`'s 25 MB, checked before the body is read. *Still open:* the
form body is buffered (`req.formData()`), so a huge multipart body is fully materialised before the per-file check —
streaming to disk under a hard byte cap needs a multipart parser.

**2.4–2.5** `/internal/message` applies the same empty/length rules as `/api/messages`; browser input is passed as
`unknown` and validated by `normalizeInput` (which already clamped coordinates and rejected unknown event types — the
original claim that raw payloads reached CDP was overstated).

**2.6** Closed in Round 4. `server/limits.ts` gives each paired device a sliding budget for messages, tasks, brief
runs and test pushes, and `POST /api/messages` accepts an `Idempotency-Key` scoped to the device. A repeated key
returns the first item instead of enqueuing a second turn. The limits are in memory (a restart forgives recent
hits), which is the right trade for an abuse brake; the durable brakes stay in SQLite.

**2.7** `GET /api/version` (from `package.json`) and 405 + `Allow` for a known route called with the wrong method.
`OPTIONS`/CORS is still not handled — the app is same-origin only, so a preflight cannot happen.

---

## 3. Security

| # | Finding | Status |
|---|---|---|
| 3.1 | Autofilled secrets are readable by the page | **Fixed** `6e2707d` |
| 3.2 | Pairing lockout is in-memory and global | **Fixed** `b8464a5` |
| 3.3 | Nothing is encrypted at rest | **Open** |
| 3.4 | Agent markdown has no image allowlist | **Fixed** `b8464a5` |
| 3.5 | Agent HTML can mint approval cards | Accepted (mitigation kept) |

**3.1** `fillLogin` re-reads the tab's host immediately before typing and refuses unless it is still the saved site or
a subdomain of it (`sameLoginSite` is one-directional and suffix-safe: not `example.com.evil.test`, not
`evil-example.com`). After the submit keystroke the password field is cleared from the DOM. *Residual:* a page that
reads `input.value` at submit time still sees the value it typed; this removes the resident copy, not the submit read.

**3.2** Failed pair attempts live in `kv`, so a restart no longer resets the brake; a lock returns 429 with
`retry-after`, and every trio of wrong codes doubles the wait (30 s … 1 h).

**3.3 Open.** The VAPID private key, webhook/internal tokens and push subscription keys are plaintext in SQLite,
protected by file mode and the data dir's `0700`. Encrypting at rest needs a key-holding decision (OS keychain vs
passphrase, and what happens on unattended boot), which should not be invented in a bug-fix pass.

**3.4** An `<img>` in a reply may only be something this app serves or an inline `data:` image; anything else is
removed and the alt text names the host. `srcset` is always dropped.

**3.5** By design, and the card records "— from *file*". Keep.

---

## 4. Data layer

| # | Finding | Status |
|---|---|---|
| 4.1 | `pendingCards` is a `json_extract` full scan | **Fixed** `f812cfb` |
| 4.2 | Hot filters without indexes | **Fixed** `f812cfb` |
| 4.3 | `fts_assets` is hand-synced and drifts | **Fixed** (writes + rename) |
| 4.4 | Multi-statement writes are not transactional | **Fixed** `f812cfb`, `c9820db` |
| 4.5 | No retention, prune or VACUUM | **Partly fixed** `f812cfb` |
| 4.6 | Boot backfill is an O(n) anti-join | **Fixed** `f812cfb` |
| 4.7 | No migration versioning | **Fixed** `f812cfb` |

**4.1** `items_card_status` is an expression index on `json_extract(json,'$.card.status')`, partial to `kind='card'`
and ordered by `created_at` — `EXPLAIN QUERY PLAN` shows `SEARCH items USING INDEX items_card_status`, no temp B-tree,
instead of a scan of the whole thread.

**4.2** `runs(status)`, `tasks(status, updated_at)`, `channels(session_id)`.

**4.3** Every asset write (`tasks.save`, `files.add`, `files.update`, `pages.save`) indexes its FTS row in the same
transaction as the row, and `pages.remove` deletes its ref. `files.update` re-indexes, so a rename no longer leaves the
old title searchable. (FTS triggers for assets would be the belt-and-braces version; the transaction closes the drift
window that mattered.)

**4.5** A daily `prune()` deletes terminal run rows older than 30 days and expired pair codes, then `PRAGMA optimize`;
`journal_size_limit` is 16 MB. **Not done, on purpose:** deleting thread items, files, uploads or TTS clips. History is
the product, and silently deleting a user's conversation to reclaim bytes is not a trade this app should make. A
periodic `VACUUM INTO` is also still manual — it locks the database and doubles the disk it uses, which is the wrong
thing to do behind a running daemon.

**4.6–4.7** `PRAGMA user_version` records the shape; the backfill runs once per version as a `NOT EXISTS` anti-join; and
the database is copied to `data/backups/` (three kept) before any version bump, so a bad migration is recoverable rather
than a boot loop.

---

## 5. Web app

| # | Finding | Status |
|---|---|---|
| 5.1 | Streaming re-renders the whole tree and re-parses markdown per token | **Fixed** `f9add4a` |
| 5.2 | No error boundary | **Fixed** `70ab0cc` |
| 5.3 | No live regions | **Fixed** `70ab0cc` |
| 5.4 | Service worker has no offline shell or cache versioning | **Open** |
| 5.5 | Snapshot ships too much on every reconnect | **Open** |
| 5.6 | Single 388 KB bundle, no code splitting | **Fixed** (Round 4) |
| 5.7 | Small a11y and mobile gaps | **Fixed** `a5ba574` |

**5.1** `Markdown` and each thread item are memoised; the store preserves item identity, so a token delta re-renders
only the bubble being written into.

**5.4 Open.** Still no offline shell and no cache versioning. Adding one means designing invalidation for a PWA that
talks to a LAN server, and a wrong cache is a worse failure than a blank screen while offline.

**5.5 Open.** `/api/state` still sends 150 items plus every file, page and task on reconnect. Trimming it changes what
the phone has when it comes back; worth doing with a measurement on a real device, not blind.

**5.6** Closed in Round 4. The two non-chat tabs and the three on-demand overlays are `React.lazy` chunks behind
`Suspense`; `STATUS_LABEL` moved to `web/src/labels.ts` so the Tasks tab could split without Thread pulling it in.
Initial JS is 365,345 B (98,610 B brotli) plus 25,762 B of chunks loaded on first use. The full harness opens every
split view.

---

## 6. Test and CI gaps

| # | Finding | Status |
|---|---|---|
| 6.1 | The HTTP surface has no tests | **Fixed** `c1acdf3` |
| 6.2 | No MCP shim contract test | **Fixed** `70ab0cc` |
| 6.3 | `runner.ts` core loop is untested | **Fixed** across `c4d2c7e`…`4a91be4` |
| 6.4 | Real-money card issuance is never exercised | **Fixed** `a5ba574` |
| 6.5 | Vault subprocess path is untested | **Partly fixed** `f9add4a` |
| 6.6 | CI runs only typecheck + test + build | **Open** |

**6.1** `server/index.test.ts` calls the handlers directly (the servers only bind under `import.meta.main`): pairing
and auth, snapshot, trailing-slash routing, JSON 404s, 405 + `Allow`, the upload cap, error shaping (including that an
errno path never reaches the body), loopback validation, and the pairing lockout.

**6.2** `server/mcp-shim.test.ts` spawns the real shim against a stub internal server: `initialize`, `tools/list` equals
exactly `TOOLS`, `tools/call` reaches `/internal/tool/<name>` with the token, and a failed call comes back as an
`isError` the model can read.

**6.4** Every provider path is asserted against a stubbed `fetch`: privacy's `spend_limit`, stripe's all-time limit and
form fields, revolut's and the generic proxy's totals, and a refusal surfacing as an error rather than a card.

**6.5** `commandFor`/`safeDomain` are covered (`{domain}` reaches exactly one argv word; metacharacters are refused).
`readLogin` itself still shells out to the real CLIs and has no test with a stubbed executor.

**6.6 Open.** CI still runs typecheck + test + build. No lint, format check, dependency audit, coverage report or
smoke run. `scripts/smoke.ts` needs a Hermes gateway, so it belongs in a nightly job rather than on every push.

---

## Round 2 — findings after the audit

A second pass over the same ground, after the fixes above landed. None of these repeats a finding from sections 1–6; the
items those sections still mark open were left open for the reasons given there.

| # | Finding | Status |
|---|---|---|
| 7.1 | The Downloads watcher could never announce a file | **Fixed** `1c71c44` |
| 7.2 | `files.update` and `pages.remove` wrote the row and the index separately | **Fixed** `ad7e20c` |
| 7.3 | `files.update` indexed ids the file table does not have | **Fixed** `ad7e20c` |
| 7.4 | The test preload set an env flag nothing read | **Fixed** `344eb60` |

**7.1** The loop advanced its snapshot past the whole folder on every 15 s poll and only then asked whether a file was
ready. A file is not read until it has been still for 20 s, so the first sighting of every download is always too
fresh, and `previous = current` had already swallowed it: nothing downloaded while the app was running was ever
announced, only files that appeared during a poll gap longer than the settle window (a sleep/wake). A batch held back
by the one-a-minute gap was lost the same way. `folderPass` now returns the files to hand over *and* the snapshot for
the next pass, and only advances past files whose fate is settled — announced, or dropped by quiet hours.

**7.2** GAPS 4.3 says every asset write indexes its search row in the same transaction as the row. Two of the five did
not. That claim is now true rather than nearly true.

**7.3** The asset index is not joined back to the files it describes, so a row for a file that is not in the table is a
search hit that opens a 404. `files.update` now checks that it updated something before indexing it.

**7.4** Harmless, but it made test isolation look stronger than it was: the real guard is `DUET_HERMES_URL` pointing at
port 0.

Left alone on purpose, after checking: the folder watcher drops a batch that lands during quiet hours instead of holding
it (a receipt downloaded at 2am is not news at 7am, and the brief reads the folder anyway); `run.text` would be applied
twice on a reconnect if the gateway ever sent frames with no `id:`, which is a guess about a protocol this app does not
control; and `dayLabel` is recomputed for every row on each streaming delta, which is real work but not worth a cache
without a measurement on a phone.

---

## Round 3 — fresh pass, 2026-11-04

A third pass re-ran the full blueprint suite (10 scripts, **99/99 checks, 37 screenshots reviewed**), typecheck
(clean), `bun test` (**429/429, 47 files**; **438/49** after Round 4) and the build (388 KB bundle plus precompressed siblings). It then
audited the HTTP surface, runner, data layer, web client, CI and deploy docs, fixed the high-impact findings, and
re-ran the browser suite after the changes (99/99 again). Findings are listed in
`docs/blueprint/hermes-duet-blueprint.html#fresh-pass`; this is the ledger.

| # | Finding | Severity | Status |
|---|---|---|---|
| 8.1 | Background task attachments were silently dropped (`POST /api/tasks` ignored `attachment_ids`; `startUserTask` never linked or prompted them; file-only sends 400 "empty message") | High | **Fixed** |
| 8.2 | Static assets and API JSON served with no compression (388,251 B JS; 7,404 B `/api/state`) | Medium | **Fixed** |
| 8.3 | JSON request bodies buffered before the 256 KB cap; chunked bodies bypassed the header gate | Medium | **Fixed** |
| 8.4 | CI ran no browser harness and never built the Docker image | Medium | **Fixed** |
| 8.5 | Dependabot covered `github-actions` only, not the Bun dependency tree | Medium | **Fixed** |
| 8.6 | `launchRun`'s failure path left an idle non-main lane in `lanes` | Low | **Fixed** |
| 8.7 | SSE sink enqueued without backpressure (live-browser frames already drop above 1.5 MB) | Low | **Fixed** |
| 8.8 | `announcedMeetings` only shrank when an event started; cancelled/rescheduled keys persisted | Low | **Fixed** |
| 8.9 | No log rotation for launchd/systemd append-only `server.log` | Low | **Fixed** (Round 4) |
| 8.10 | Authenticated JSON had no `cache-control: no-store` | Low | **Fixed** |
| 8.11 | Webhook 256 KB cap trusted `content-length`; chunked requests bypassed it (still token-gated) | Low | **Fixed** |
| 8.12 | Docker runtime copied tests, `scripts/`, `site/` and `tools/` into the image | Low | **Fixed** |
| 8.13 | Docker pairing command was `bun bin/hermes-duet`, which cannot parse the bash CLI | Medium | **Fixed** |
| 8.14 | Report/harness docs quoted stale counts (348 tests/43 files, 119 ms, `sweep-530da497` 20/20) | Low | **Fixed** |

**8.1** The route now reads `attachment_ids` with the same validation as `/api/messages`, links the rows to the
user item, and passes `attachmentNote(rows)` into `startUserTask`, which stores `attachments` and appends the file
paths to the task instructions. A file-only background send starts a task with "Look at the file I attached."
instead of returning "empty message". Covered by `index.test.ts` and `runner.test.ts`.

**8.2** `bun run build` now writes `.br`/`.gz` siblings (`scripts/precompress.ts`); `serveStatic` negotiates
`br` → `gzip` → raw and always sets `vary: accept-encoding`; `compressJson` compresses JSON over 1 KB. Measured:
JS 388,251 → 103,185 B brotli, CSS 72,768 → 22,277 B, `/api/state` 7,404 → 1,884 B.

**8.3** `readTextCapped` checks `content-length` first and stops a stream at the byte cap. `body()` and the
webhook use it; the webhook answers 413 instead of an unhandled throw. A 300 KB chunked body is refused in
`index.test.ts`.

**8.4** `ci.yml` gained a `docker build` job. `harness.yml` runs seven portable browser scripts nightly and on
demand on Linux, using `CHROME_PATH` (now honoured by every script) and uploading `blueprint-out`. Three scripts
stay local-only, and the workflow says why: `recovery.mjs` restarts the app through the blueprint helper;
`live.mjs` needs a driven Chrome that paints frames; `wheel.mjs` opens that pane and waits for its stage. The
runner's headless Chromium delivered no frames (`Non-black frames` failed), which is an environment limit rather
than an app regression. A workflow that always fails is worse than one that names its blind spot.

**8.6–8.8, 8.10–8.12** Shared `dropIdleLane` on every failure path; SSE drops a sink after 64 queued chunks and
lets EventSource resync; meeting keys expire with their start time; all JSON is `no-store`; the Docker context
drops tests, dev scripts, `site/` and `tools/` (keeping `scripts/precompress.ts` for the build).

**8.13** was proven by running `bun bin/hermes-duet --help` — a syntax error at line 2. `docs/DEPLOY.md` and the
`Dockerfile` comment now call the script directly.

### Left alone on purpose

- `noUncheckedIndexedAccess` is off. Turning it on would surface hundreds of sites in `runner.ts`; it belongs with
  the planned runner split, not a docs pass.
- The single chunk and the reconnect snapshot were tracked as 5.5/5.6. This pass compressed both on the wire (8.2);
  Round 4 split the overlays and the two non-chat tabs (5.6). Snapshot trimming (5.5) still needs a real-thread
  measurement.
- Encryption at rest (3.3) still needs the key-holding decision; no new evidence.
- The pairing lockout remains global by design. A reachable attacker can make pairing wait; the server is private by
  default, and the alternative (per-IP brakes) is weaker behind a tunnel.

---

## Round 4 — closing the remaining tractable gaps, 2026-11-04

After Round 3 shipped, the follow-up pass closed the three items that were safe to finish without a policy or
architecture decision: mutation limits/idempotency (2.6), code splitting (5.6) and log rotation (8.9). The browser
suite was re-run after the client change: **99/99 checks**, 37 screenshots. Unit tests: **438/438 across 49 files**.

| # | Finding | Status |
|---|---|---|
| 9.1 | No per-device limits on messages, tasks, briefs or test pushes; a retried message could enqueue a second turn | **Fixed** |
| 9.2 | The first paint parsed every overlay and both other tabs | **Fixed** |
| 9.3 | launchd/systemd append to `server.log` forever | **Fixed** |

**9.1** `server/limits.ts` adds sliding windows per paired device: 60 messages/min, 20 tasks/min, 6 brief runs per
10 minutes, 5 test pushes per 10 minutes. A refusal is `429` with `retry-after`. `POST /api/messages` accepts
`Idempotency-Key` (`[A-Za-z0-9_-]{8,64}`), scoped to the device, and returns the first item for a repeat instead of
a second turn; the map is bounded and expires after 10 minutes. Because the limiter is in memory, a restart forgives
recent hits; that is the right trade for an abuse brake, and the durable brakes (pairing, webhooks) stay in SQLite.
Tests: `server/limits.test.ts`, plus route tests for the duplicate key and the 429.

**9.2** `TasksView`, `MakeView`, `Viewer`, `SettingsSheet` and `BrowserView` are `React.lazy` chunks behind
`Suspense`. `STATUS_LABEL` moved to `web/src/labels.ts` so `Thread.tsx` no longer statically imports the Tasks tab
(which would have defeated the split; Vite warned about exactly that). Measured: initial JS 388,251 → **365,345 B**
(119,091 → **113,729 gzip**, 103,185 → **98,610 br**); five chunks total **25,762 B** (9,386 gzip), loaded on first
use. The full harness opens every split view, so the chunk boundaries are exercised, not assumed.

**9.3** `hermes-duet rotate-logs [keep]` copytruncates the live log: it copies `server.log` to `.1`, shifts older
generations, then truncates in place so launchd/systemd keep writing to the same descriptor. `doctor` warns above
50 MB, `DUET_LOG_DIR` overrides the location, and `DEPLOY.md` documents a weekly cron. `scripts/log-rotation.test.ts`
spawns the real bash CLI against a temp directory.

### What is deliberately still open

- **5.5** reconnect snapshot trimming: the compressed snapshot is 1.9 KB on the seed, so this needs a measurement on
  a real thread. It changes what a returning phone has; that is a product trade, not a clear defect.
- **3.3** encryption at rest: still needs the key-holding decision (OS keychain vs passphrase, unattended boot).
- **5.4** offline shell: needs cache invalidation designed for a LAN server; a wrong cache is worse than a spinner.
- **6.6** lint/coverage: the nightly browser harness and advisory audit exist; a linter and coverage target are
  separate tool choices.
- **`runner.ts` split**: still the structural fix, and still not something to combine with behavioural changes.

---

## Rejected findings — do not re-open without new evidence

The crew asserted these confidently; the gate checked and they are wrong or already handled.

| Claim | Reality |
|---|---|
| "No migration story at all" | Idempotent `addColumn()` existed; the real gap was versioning (4.7), now fixed. |
| "Vault CLI env template = command injection" | `{domain}` is the only substitution and passes `safeDomain`; now pinned by a test. |
| "Webhook has no body cap" | 256 KB `tooLarge` plus `webhookReady()` 429. |
| "CSRF check trusts spoofable `X-Forwarded-Host`" | Origin check plus SameSite plus JSON-only bodies. |
| "No foreign keys despite `foreign_keys=ON`" | By design: relational state lives in JSON blobs; there are no FK columns to enforce. |
| "Dead SSE sinks accumulate (`idleTimeout: 0`)" | `server/bus.ts` aborts on client close and pings every 25 s. |
| "Fonts are 328 KB and render-blocking" | True as a measurement, but a style-level tradeoff, not a defect. |
| "Approval double-tap double-applies" | No `await` sat between the status check and the write, so single-threaded Bun serialised it. Now also guarded by an in-flight set (1.1). |
| "Tool calls carry task context in the shim" | They do not: the shim is one process for every session. See 1.3. |

---

## Suggested next steps, in order of value

Round 4 closed 2.6, 5.6 and 8.9. What remains, in order:

1. **5.5** measure `/api/state` on a real thread, then trim what a returning phone has. The compressed snapshot is
   1.9 KB on the seed, so this is a product trade measured against real data, not a blind cut.
2. **3.3** encryption at rest, once the key-holding decision is made (keychain for a Mac install, passphrase for a VPS).
3. **5.4** an offline shell with a versioned cache.
4. **6.6** a linter and a coverage target; the nightly browser harness and advisory audit already run.
5. **`runner.ts` split**, as a standalone structural change.

`server/runner.ts` is still ~1,950 lines with a large tool-dispatch switch. Splitting it
(`server/cards/actions.ts`, `server/runs/manager.ts`, `server/tools/dispatch.ts`, `runner.ts` as facade) is the
structural fix that keeps 1.1–1.9 reviewable. Do not attempt that in the same change as a behavioural fix.
