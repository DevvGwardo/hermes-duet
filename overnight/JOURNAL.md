# Journal — overnight Claude Duet parity loop

## 2026-10-22T04:32Z — Audit and rewrite this backlog
- What changed: overnight/BACKLOG.md rewritten from a code read of server/, shared/, web/src/, web/public/sw.js. Added three real gaps the hypotheses missed: non-NOOP check-in text gets posted and pushed (runner.ts:565), "Needs you" only sees the latest 150 loaded items, and start_task promises a "[task <id> finished]" message that is never sent. Split standing artifacts into two items, and added a "brief entry → approval" item.
- Dropped as already done: collapsed activity trace, no push while visible, offline queued notice, safe-area padding. Downgraded recovery copy to polish.
- Why it matters against Claude Duet: each loop iteration now works on a real, verified gap (silence, judgment, approvals, handover, standing page) instead of a guess.
- Verified: typecheck pass · test 7 pass / 0 fail · build pass (docs-only change, no code touched)

## 2026-10-22T00:32:52Z — loop iteration 1
- exit=0 gate=green committed=True files=3
- gate: typecheck: exit 0
- answer:
```
⚠ claude.ai connectors are disabled because ANTHROPIC_API_KEY or another auth source is set and takes precedence over your claude.ai login · Unset it to load your organization's connectors
DONE: Audit and rewrite this backlog
- Rewrote `overnight/BACKLOG.md` after reading the code in `server/`, `shared/`, `web/src/` and `web/public/sw.js`. There are 11 open items, each pointing at specific file:line locations, and I dropped three hypotheses that are already done. No code was changed.
- Three gaps the old list missed: any check-in reply other than exactly `NOOP` gets posted and pushed (`server/runner.ts:565`); "Needs you" and the Chat badge only look at the 150 most recent items; and `start_task` promises a `[task <id> finished]` message that nothing ever sends.
- Created `overnight/JOURNAL.md` with the first entry. I didn't touch `overnight/loop.py`, which already had uncommitted changes.
- typecheck: `tsc -p tsconfig.json --noEmit` → exit 0
- test: `7 pass, 0 fail, 68 expect() calls` → exit 0
- build: `✓ built in 104ms` → exit 0
> CORRECTION: "Readable agent activity" is already done: `Activity` in `web/src/components/Thread.tsx` starts collapsed and expands on tap. The phone-first offline notice already exists in `Composer.tsx`, and safe-area padding is already in `styles.css`.
> CORRECTION: `server/tools.ts:117` tells the model it will receive a `[task <id> finished]` message, but the code never sends one. It's now backlog item "Finished tasks hand over cleanly".
```

## 2026-10-22T04:35Z — Check-ins stay silent unless a brief has entries
- What changed: new pure `server/brief.ts` holds `briefEntries` (post_brief normalization, now throws on an empty list) and `checkinOutcome` (a check-in surfaces only if it posted a brief; its free text is never posted, non-NOOP text is just logged as `[checkin] not posted`). `server/runner.ts` uses both and no longer creates an assistant item or "Heads up" push from check-in text; the context note now fires whenever a check-in brief was posted, even if the run later errored.
- `server/tools.ts`: post_brief `entries` gets `minItems: 1` and the description says not to call it with nothing. `server/prompts.ts` check-in prompt tells the model its text is never shown. New `server/brief.test.ts` (6 tests).
- Why it matters against Claude Duet: "goes quiet until something genuinely needs you" — a chatty "Nothing new." can no longer buzz the phone.
- Verified: typecheck pass · test 13 pass / 0 fail · build pass

## 2026-10-22T00:35:17Z — loop iteration 2
- exit=0 gate=green committed=True files=7
- gate: typecheck: exit 0
- answer:
```
⚠ claude.ai connectors are disabled because ANTHROPIC_API_KEY or another auth source is set and takes precedence over your claude.ai login · Unset it to load your organization's connectors
DONE: Check-ins stay silent unless a brief has entries
- New `server/brief.ts` has two small pure functions. `briefEntries` cleans up the `post_brief` entries and rejects an empty list. `checkinOutcome` decides whether a check-in reaches the user: only when it posted a brief. Its text reply is never posted; non-NOOP text is just logged as `[checkin] not posted`.
- `server/runner.ts:565`: check-in text no longer becomes a thread message or a "Heads up" push. The context note now fires whenever a check-in brief was posted, even if the run errored afterwards.
- `server/tools.ts`: the `post_brief` schema now requires at least one entry (`minItems: 1`), and the description tells the model not to call it when nothing needs the user. `server/prompts.ts`: the check-in prompt now says its text reply is never shown.
- New tests in `server/brief.test.ts` (6). Also updated `overnight/BACKLOG.md` (ticked) and `overnight/JOURNAL.md`.
- typecheck: `tsc -p tsconfig.json --noEmit` → exit 0
- test: `13 pass, 0 fail, 84 expect() calls` → exit 0
- build: `✓ built in 108ms` → exit 0
```

## 2026-10-22T04:37Z — "Needs you" sees every pending card, not just the loaded page
- What changed: `Snapshot.pending` (shared/types.ts) is filled from `items.pendingCards()` in `/api/state` (server/index.ts). New dependency-free `shared/pending.ts` (`isPendingCard`, `trackPending`) folds each `item` event into `store.pending` (web/src/store.ts), so a card decided outside the loaded page still leaves the list.
- Rail, Tasks "Needs you" and the Chat tab badge/app badge (App.tsx) now read `store.pending`. Tapping a card older than the loaded thread used to do nothing; `loadUntil` (web/src/api.ts) now pages back (max 20 pages) and Thread.tsx scrolls to the card once it renders. New server/pending.test.ts (5 tests).
- Why it matters against Claude Duet: "waits for your ok when it matters": an old approval can't drop out of view while it's still waiting on the user.
- Verified: typecheck pass · test 18 pass / 0 fail · build pass

## 2026-10-22T00:37:14Z — loop iteration 3
- exit=0 gate=green committed=True files=12
- gate: typecheck: exit 0
- answer:
```
⚠ claude.ai connectors are disabled because ANTHROPIC_API_KEY or another auth source is set and takes precedence over your claude.ai login · Unset it to load your organization's connectors
DONE: "Needs you" sees every pending card, not just the loaded page
- `/api/state` now returns a `pending` list of every card still waiting, taken from `items.pendingCards()` (`server/index.ts`, `shared/types.ts`). New `shared/pending.ts` updates `store.pending` from each `item` event (`web/src/store.ts`), so a card that gets decided drops off the list even if it's older than the loaded page.
- The Rail, the Tasks "Needs you" section and the Chat tab badge / app icon badge all read `store.pending` now (`Rail.tsx`, `TasksView.tsx`, `App.tsx`).
- I also fixed something the item didn't list: tapping a card older than the loaded thread did nothing. `loadUntil` in `web/src/api.ts` now loads earlier messages (up to 20 pages) until the card is there, and `Thread.tsx` scrolls to it.
- New `server/pending.test.ts` (5 tests). Ticked the item in `overnight/BACKLOG.md` and added an entry to `overnight/JOURNAL.md`.
- typecheck: `tsc -p tsconfig.json --noEmit` → exit 0
- test: `18 pass, 0 fail, 92 expect() calls` → exit 0
- build: `✓ built in 106ms` → exit 0
```

## 2026-10-22T04:40Z — Finished tasks hand over cleanly
- What changed: new pure `server/handover.ts` (`followUps` normalizer, `handoverCard` builder) with `server/handover.test.ts` (4 tests). `server/runner.ts`: background task runs no longer stream text into the thread, and their `deliver_file` calls post no card of their own. When a task ends done, `handOver` posts one `handover` card (title, result, the task's files, up to 3 follow-ups), or refreshes it in place via `task.handover_id`. The push now opens it, and the main session's context note lists the files. A task that fails or stops leaves a one-line system note, since its text no longer shows. MEDIA markers in task text are still delivered, at finish.
- Tool surface: `update_task` takes `follow_ups`; the `start_task` description and return text no longer promise a "[task <id> finished]" message; `taskPrompt` tells the worker its text is never shown. Web: `CardView` renders the handover card (files + follow-up chips), and `TasksView` rows list the task's files (`FileRow` exported). README tool row updated.
- Why it matters against Claude Duet: "large tasks run in the background and come back as a finished artifact, shared when done". The user now gets one card with the result, not a stream of a worker's chatter.
- Verified: typecheck pass · test 22 pass / 0 fail · build pass

## 2026-10-22T00:40:53Z — loop iteration 4
- exit=0 gate=green committed=True files=13
- gate: typecheck: exit 0
- answer:
```
ne" push now opens that card.
- The thread no longer shows the task's running commentary, and files a task delivers no longer get a card each mid-run (they still go to the Make tab right away). A task that fails or stops now leaves a one-line note in the thread, because its own text is no longer shown there.
- `update_task` now takes `follow_ups`. The `start_task` description no longer promises a `[task <id> finished]` message; it describes the card and the note the main conversation gets on the user's next message. The task prompt tells the worker its text isn't shown to the user. Files: `server/runner.ts`, `server/tools.ts`, `server/prompts.ts`, `shared/types.ts`, `README.md`.
- New pure `server/handover.ts` with `server/handover.test.ts` (4 tests). On the web side, `CardView.tsx` draws the card, each task in the Tasks list (`TasksView.tsx`) now shows its files, plus small changes in `App.tsx` and `styles.css`.
- Added a backlog item, "Failed tasks hand over too": a failed task should get the same card with the reason, any files so far and a "Try again" button.
- typecheck: `tsc -p tsconfig.json --noEmit` → exit 0
- test: `22 pass, 0 fail` → exit 0
- build: `✓ built in 107ms` → exit 0
> CORRECTION: the item says "the thread gets whatever free text the task run streamed". In the code, that text appeared as normal assistant messages labelled "Task · <title>", and every `deliver_file` from a task also posted its own file card. Both are now replaced by the single Finished card.
```

## 2026-10-22T04:45Z — Failed tasks hand over too
- What changed: `server/handover.ts` `handoverCard` now builds a muted card for a `failed` task: the reason as body, files delivered so far (only from the current attempt, via `retried_at`), no follow-ups, and `retry` when the task's `instructions` were kept (new on `Task`, set by `startTask`). `server/runner.ts`: a failed or stopped run, an agent-set `failed`, and a background task that couldn't start all go through one `announceEnd` (card + context note + one push that opens the card) instead of a system note.
- "Try again": `actOnCard(id, 'retry')` → `retryTask` resets the task, restarts it in a fresh Hermes session from the stored instructions (`taskPrompt` gets the earlier failure reason), and marks the old card "Tried again". The finished retry posts a new card at the bottom. Web: `CardView` shows "Didn’t finish", the chip, and the decision stamp; muted styles in `styles.css`. 3 new tests; README tool row and `update_task.result` description updated.
- Why it matters against Claude Duet: background work always comes back as one card, including when it doesn't work out, and recovering takes one tap.
- Verified: typecheck pass · test 25 pass / 0 fail · build pass

## 2026-10-22T00:44:03Z — loop iteration 5
- exit=0 gate=green committed=True files=11
- gate: typecheck: exit 0
- answer:
```
inished one, styled muted with a "Didn’t finish" label. The card shows the reason, any files delivered so far, and a **Try again** button where the follow-ups would go. This covers three cases: a run that errors or stops, the agent marking the task `failed` itself, and a task that couldn't start. All three now go through one `announceEnd` step (card, a note for the main conversation, and one push that opens the card) instead of the one-line system note (`server/runner.ts`, `server/handover.ts`).
- **Try again** restarts the same task from its saved instructions in a fresh Hermes session, telling the agent why the earlier attempt failed. The old card then reads "Tried again", and the new result arrives as a new card at the bottom of the thread. The button only appears when instructions are saved, so tasks started before this change won't show it. Files from the failed attempt don't appear on the new card. Changes: `shared/types.ts`, `server/prompts.ts`, `web/src/components/CardView.tsx`, `web/src/styles.css`, `README.md`, and the `update_task.result` description in `server/tools.ts`.
- 3 new tests in `server/handover.test.ts`. Ticked the item and wrote the journal entry. Added a backlog item, "Interrupted tasks push twice": when Hermes restarts mid-task, the phone gets both "Task failed" and "Work was interrupted" for the same event.
- typecheck: `tsc -p tsconfig.json --noEmit` → exit 0
- test: `25 pass, 0 fail, 105 expect() calls` → exit 0
- build: `✓ built in 103ms` → exit 0
```

## 2026-10-22T04:46Z — Brief = ranked decisions with drafts, plus Watching
- What changed: `BriefEntry.draft` and a new `WatchEntry` / `CardData.watching` (shared/types.ts). `server/brief.ts` now has `briefCard`, which sorts decisions high→low (stable), caps them at 5 and moves any overflow to the front of Watching (named in the tool result), and `briefTitle`, which rewrites "N things need you" to the real decision count with matching singular/plural. `server/runner.ts` uses both; the push lists decisions only (+N more), never Watching.
- `post_brief` schema/description gain `draft` and `watching`; both prompts say decisions go in entries with their draft and everything else goes in watching. `CardView` shows the draft collapsed under the entry ("Draft ready") and a muted Watching section (styles.css). README tool row updated. brief.test.ts: 3 new tests, existing ones moved to `briefCard`.
- Why it matters against Claude Duet: the brief is a short ranked list of decisions, each with its draft ready, plus a separate Watching set that doesn't interrupt.
- Verified: typecheck pass · test 28 pass / 0 fail · build pass

## 2026-10-22T00:46:34Z — loop iteration 6
- exit=0 gate=green committed=True files=11
- gate: typecheck: exit 0
- answer:
```
ude.ai connectors are disabled because ANTHROPIC_API_KEY or another auth source is set and takes precedence over your claude.ai login · Unset it to load your organization's connectors
DONE: Brief = ranked decisions with drafts, plus Watching
- Each brief item can now carry a `draft`, and briefs have a separate `watching` list (`shared/types.ts`). In `server/brief.ts`, `briefCard` sorts items high to low and keeps the top 5. Extras move to the top of Watching and their drafts are dropped; the tool result lists them so the agent knows. `briefTitle` rewrites a count like "7 things need you" to the real number of items, fixing singular and plural.
- `server/runner.ts`: the push lists items only, plus "+N more" when there are more than 3. Watching is never pushed. `server/tools.ts` (the `post_brief` schema and description) and both prompts in `server/prompts.ts` explain the new fields. The README tool row is updated.
- On the card (`web/src/components/CardView.tsx`, `web/src/styles.css`), each draft sits collapsed under its item behind "Draft ready", and Watching is a muted section at the bottom.
- 3 new tests in `server/brief.test.ts`; the existing ones now call `briefCard`.
- New backlog item, "Morning brief with nothing to decide": a quiet morning with only Watching items can't post a brief, because at least one item is still required.
- typecheck: `tsc -p tsconfig.json --noEmit` → exit 0
- test: `28 pass, 0 fail, 113 expect() calls` → exit 0
- build: `✓ built in 83ms` → exit 0
```

## 2026-10-22T04:52Z — Approvals carry an editable draft
- What changed: new pure `server/approval.ts` (`approvalDecision`, `approvalPrompt`) + `server/approval.test.ts` (5 tests). `request_approval` takes an optional `draft` (exact text to send); `CardData` gains `draft`/`edited`. `actOnCard` passes the card's `value` through `approvalDecision`: an approve with changed text stores it as `draft` with `edited: true`; empty/oversized edits are refused; decline, push actions and Hermes-native cards ignore it. `decisionPrompt` delegates to `approvalPrompt`, which says "APPROVED with edits … Send exactly the text below" with the text appended; `runTitle`'s regex accepts the new form.
- Web: `CardView` renders a pending Duet approval's draft as a textarea (Undo edits, empty guard) and sends it with Approve only when changed; decided cards show the draft read-only and "Sent with your edits". Tool description, persona line and README row updated.
- Why it matters against Claude Duet: "approvals are one tap, with the full draft in the card": the user can fix a typo without a round trip to the agent.
- Verified: typecheck pass · test 33 pass / 0 fail · build pass
