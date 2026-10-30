# GAPS — audit outcome

A 10-agent audit of `hermes-duet` (architect, backend, frontend, api, data, test, debug, security, perf, reviewer)
produced the findings below. This file is now the record of what happened to each one: **fixed**, **still open** (with
why), or **rejected** (the crew was wrong — do not re-investigate without new evidence).

**Baseline at audit time:** 348 tests pass, `tsc` clean. **Now:** 393 tests pass, `tsc` clean, `bun run build` clean.

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
*Residual:* a Stop tapped in the window between a lane going active and `run.id` arriving is still dropped; fixing it
needs a "stop requested" flag checked inside `launch` after `startRun`.

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
| 2.6 | No idempotency or rate limits on mutations | **Open** |
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

**2.6 Open.** No `Idempotency-Key` and no per-device throttling on `/api/messages`, `/api/tasks`, `/api/brief/run`,
`/api/push/test`. Deliberately deferred: it is a contract change for every client and this app is single-user, single
device, over a private network. The cheap half (rate-limit `push/test` and `brief/run`) is worth doing before the app
is ever put in front of more than one person.

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
| 5.6 | Single 388 KB bundle, no code splitting | **Open** |
| 5.7 | Small a11y and mobile gaps | **Fixed** `a5ba574` |

**5.1** `Markdown` and each thread item are memoised; the store preserves item identity, so a token delta re-renders
only the bubble being written into.

**5.4 Open.** Still no offline shell and no cache versioning. Adding one means designing invalidation for a PWA that
talks to a LAN server, and a wrong cache is a worse failure than a blank screen while offline.

**5.5 Open.** `/api/state` still sends 150 items plus every file, page and task on reconnect. Trimming it changes what
the phone has when it comes back; worth doing with a measurement on a real device, not blind.

**5.6 Open.** ~388 KB (120 KB gzip) in one bundle, no `React.lazy`, no vendor chunk. A build-level change with a
first-paint tradeoff.

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

1. **2.6** rate-limit `push/test` and `brief/run`, and accept an `Idempotency-Key` on `/api/messages`. (Small, and it
   is the last thing between this and being safe to hand to a second person.)
2. **5.5 + 5.6** measured on a real phone: trim the reconnect snapshot, then split the four overlays out of the first
   paint.
3. **3.3** encryption at rest, once the key-holding decision is made (keychain for a Mac install, passphrase for a VPS).
4. **5.4** an offline shell with a versioned cache.
5. **6.6** lint + `bun audit` in CI, and a nightly smoke against a real gateway.

`server/runner.ts` is still ~1,950 lines with a large tool-dispatch switch. Splitting it
(`server/cards/actions.ts`, `server/runs/manager.ts`, `server/tools/dispatch.ts`, `runner.ts` as facade) is the
structural fix that keeps 1.1–1.9 reviewable. Do not attempt that in the same change as a behavioural fix.
