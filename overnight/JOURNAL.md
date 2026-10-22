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

## 2026-10-22T00:50:22Z — loop iteration 7
- exit=0 gate=green committed=True files=11
- gate: typecheck: exit 0
- answer:
```
ion's connectors
DONE: Approvals carry an editable draft
- `request_approval` now takes an optional `draft`, the exact text to be sent (`server/tools.ts`, `shared/types.ts`, which also adds `edited`). New pure `server/approval.ts` with 5 tests in `server/approval.test.ts`. If the user changes the text and approves, `actOnCard` (`server/runner.ts`) saves their version on the card as `draft` and sets `edited: true`. An empty or too-long edit is refused. Declines, the push notification's Approve button and Hermes-native cards ignore any edit.
- When the draft was edited, the agent gets "APPROVED with edits … Send exactly the text below" followed by the user's text (`approvalPrompt`, used by `decisionPrompt` in `server/prompts.ts`). I also updated the regex that titles these runs so it still matches the new wording. The tool description, the line in the agent's instructions and the README row are updated.
- On the phone (`web/src/components/CardView.tsx`, `web/src/styles.css`), a pending approval shows its draft in an editable box with "Undo edits". Approve sends the text back only if it was changed. A decided card shows the draft read-only, labelled "Sent with your edits" when edited.
- New backlog item, "Push approve skips the draft": the Approve button on the notification can approve a draft card when the push only showed its title.
- typecheck: `tsc -p tsconfig.json --noEmit` → exit 0
- test: `33 pass, 0 fail, 128 expect() calls` → exit 0
- build: `✓ built in 11.40s` → exit 0
```

## 2026-10-22T04:52Z — Morning brief with nothing to decide
- What changed: `briefCard(raw, { morning })` (server/brief.ts) accepts zero decisions for the morning brief when Watching is non-empty; check-ins still need a decision, and a brief with neither is an error. `briefTitle` turns "<N> things need" into "Nothing needs" at zero decisions (capital only where a sentence starts). `post_brief` in server/runner.ts passes `morning` and skips the push when there are no decisions.
- `post_brief` schema drops `minItems`/required `entries` and its description explains the quiet-morning exception; `briefPrompt` step 4 tells the model to still call it on a quiet day. CardView skips the empty decision list. README row updated; 3 new tests in brief.test.ts.
- Why it matters against Claude Duet: a quiet morning still gets a brief card (Watching only) instead of a push of free text, and it doesn't interrupt the user.
- Verified: typecheck pass · test 36 pass / 0 fail · build pass

## 2026-10-22T00:52:26Z — loop iteration 8
- exit=0 gate=green committed=True files=9
- gate: typecheck: exit 0
- answer:
```
⚠ claude.ai connectors are disabled because ANTHROPIC_API_KEY or another auth source is set and takes precedence over your claude.ai login · Unset it to load your organization's connectors
DONE: Morning brief with nothing to decide
- On a quiet morning, the brief can now post with no decisions as long as it has at least one Watching item (`briefCard(raw, { morning })` in `server/brief.ts`). Check-ins still need at least one decision. A brief with no decisions and no Watching items is refused.
- When there are no decisions, `briefTitle` rewrites "N things need you" to "Nothing needs you", capitalized only at the start of a sentence. `post_brief` in `server/runner.ts` posts that card without sending a push.
- `server/tools.ts`: in the `post_brief` schema, `entries` is no longer required and can be empty, and the description explains that only the morning brief may skip decisions. `server/prompts.ts`: the morning brief prompt tells the agent to still post a brief on a quiet day. `web/src/components/CardView.tsx` no longer draws an empty decision list. README row updated, and 3 new tests in `server/brief.test.ts`.
- New backlog item: if a morning has no decisions and nothing to watch, the agent's text reply is still pushed as "Your morning brief".
- typecheck: `tsc -p tsconfig.json --noEmit` → exit 0
- test: `36 pass, 0 fail, 134 expect() calls` → exit 0
- build: `✓ built in 102ms` → exit 0
```

## 2026-10-22T04:55Z — Brief entries can become approvals in one tap
- What changed: new pure `useDraft` in `server/brief.ts` (+4 tests in brief.test.ts) builds the hand-back from the stored card: the entry is marked `used` (new `BriefEntry.used`), the thread shows a short "<label>: <title>" line, and the agent gets "[brief <id>] …" with the entry's title/detail, the button's intent, and the draft verbatim, told to call request_approval with exactly that text if it goes out. `actOnCard(id, 'use_draft', index)` in `server/runner.ts` applies it; `submitUser` takes an optional agent `input` separate from the shown text.
- Web: `BriefList` gives every entry with a draft a chip (`action_label` or "Send as drafted") that calls the card action, stays "On it" from `used` across reloads, and shows errors. `post_brief` tool description, `briefPrompt` and README row updated. Discovered: other follow-up chips keep "On it" only in memory (new backlog item).
- Why it matters against Claude Duet: a brief decision with its draft ready goes to a one-tap approval card with that same draft, instead of the agent redrafting from a vague message.
- Verified: typecheck pass · test 40 pass / 0 fail · build pass

## 2026-10-22T00:56:34Z — loop iteration 9
- exit=0 gate=green committed=True files=10
- gate: typecheck: exit 0
- answer:
```
Tapping it sends the action `use_draft` with the entry's index (`actOnCard` in `server/runner.ts`). The server reads the draft from the saved card, not from the phone, and marks the entry `used`. The thread shows a short "<label>: <title>" line. The agent gets the entry and the draft word for word, with an instruction to call `request_approval` with exactly that text if it goes out. The prompt is built by the new `useDraft` in `server/brief.ts`.
- `submitUser` can now take what the agent receives separately from what the thread shows. `BriefEntry` has a new `used` field (`shared/types.ts`), and the model can't set it itself.
- `web/src/components/CardView.tsx`: the button still reads "On it" after a reload because it reads `used` from the saved card, and errors show under the list. Entries without a draft still send `action_message` as before. Also updated: the `post_brief` description in `server/tools.ts`, `briefPrompt` in `server/prompts.ts`, and the README row. 4 new tests in `server/brief.test.ts`.
- New backlog item: the other one-tap buttons (`action_message` buttons on brief entries and the follow-ups on finished-task cards) only remember the tap until reload. After that they can be tapped again and send the same request twice.
- typecheck: `tsc -p tsconfig.json --noEmit` → exit 0
- test: `40 pass, 0 fail, 153 expect() calls` → exit 0
- build: `✓ built in 2.33s` → exit 0
SessionEnd hook [node "${CLAUDE_PLUGIN_ROOT}/hooks/session-end-cleanup.mjs"] failed: Hook cancelled
```

## 2026-10-22T05:01Z — Standing page: storage, schedule and tool
- What changed: `pages` table + `pages` accessor (server/db.ts) and `Page` / `Task.page_id` (shared/types.ts). New pure `server/pages.ts` (`refreshTime` = brief_time − 30 min clamped at 00:00, `pagesDue` once per local day with catch-up until midday and skip-while-running, `pageInput`) + `server/pages.test.ts` (6 tests). New `save_page` tool (create from a delivered `file_id` + rebuild instructions, update via `page_id`, `remove`); creation marks today as refreshed; max 10 pages.
- `server/scheduler.ts` calls `refreshPage` for due pages before the brief block; it starts a background task "Refresh: <title>" from `pageRefreshInstructions` (prompts.ts: saved instructions, path of the current version, write to ~/duet-work/page-<id>/). In `deliverFile`, a page task's file replaces `page.file_id` only if the mime matches. `pageRefreshEnded` (via `announceEnd`) records `last_ok`/`last_result`, never pushes, posts no card on success and the muted retry card on failure; done without a new file counts as not refreshed. Persona line and README row added. "Refresh time" is derived from `brief_time`, not stored, so it follows the setting.
- Why it matters against Claude Duet: "build me one page I can check every morning" now has a standing artifact that rebuilds itself before the brief.
- Verified: typecheck pass · test 46 pass / 0 fail · build pass

## 2026-10-22T01:01:33Z — loop iteration 10
- exit=0 gate=green committed=True files=11
- gate: typecheck: exit 0
- answer:
```
h is still running is skipped. 6 tests in `server/pages.test.ts`.
- **Tool:** new `save_page` in `server/tools.ts` and `server/runner.ts`. It creates a page from a delivered `file_id` plus rebuild instructions, updates one with `page_id`, and stops one with `page_id` + `remove`. It is capped at 10 pages, and a new page counts as already refreshed today.
- **Schedule:** `server/scheduler.ts` calls `refreshPage` before the brief check. That starts a background task "Refresh: <title>" using `pageRefreshInstructions` (`server/prompts.ts`). A file the task delivers replaces the page's current version only if it is the same file type.
- **When a refresh ends:** it never sends a push. Success posts no card. Failure leaves the muted card with "Try again". A task marked done that delivered no new file is recorded as not refreshed.
- Also added a line to the agent's standing instructions and a README tool row. The backlog item is ticked, a new item "Stop a standing page from the app" is added, and the next item now also covers putting pages in `Snapshot` and holding the brief while a refresh is still running.
- typecheck: `tsc -p tsconfig.json --noEmit` → exit 0
- test: `46 pass, 0 fail, 171 expect() calls` → exit 0
- build: `✓ built in 109ms` → exit 0

> CORRECTION: the item lists "refresh time" as a stored column. I compute it from `brief_time` instead, so changing the brief time moves the refresh too. The page stores `refreshed_on` (to refresh once a day) and `refreshed_at` instead.
```

## 2026-10-22T05:04Z — Standing page: what changed, pinned in Make
- What changed: `update_task` takes `changed` (tools.ts, stored on `Task.changed`); `pageRefreshEnded` copies it to `Page.changed` on a successful refresh and clears it on failure; `refreshPage` resets last_ok/last_result/changed when a refresh starts. `pageRefreshInstructions` asks for `changed`. Every page write goes through `putPage`, which broadcasts a new `page` event (`page_removed` on save_page remove); `Snapshot.pages` added (server/index.ts, shared/types.ts).
- `runBrief` passes one `pageBriefLine` per page (server/pages.ts: refreshed + change / failed + reason / still running / stopped / not refreshed / new today) into `briefPrompt`, which tells the model to call out each page's one change or failed refresh. Scheduler holds a due brief while any page is refreshing, at most `BRIEF_HOLD_MIN` (30) via pure `holdBrief`; a held brief may go out past the midday cutoff. Make pins pages under "Every morning" (refreshed time, change line in gold, failure in red, "Refreshing now…"). 2 new tests in pages.test.ts; README row updated.
- Why it matters against Claude Duet: the standing page now "calls out the one thing that changed", both on the page in Make and in the morning brief, and the brief waits for the refresh.
- Verified: typecheck pass · test 48 pass / 0 fail · build pass

## 2026-10-22T01:05:15Z — loop iteration 11
- exit=0 gate=green committed=True files=14
- gate: typecheck: exit 0
- answer:
```
ars the previous day's result when it starts. Files: `server/tools.ts`, `server/runner.ts`, `server/prompts.ts`, `shared/types.ts`.
- **The app stays current:** every page save goes through `putPage`, which sends a new `page` event, and removing a page sends `page_removed`. The startup snapshot now includes `pages` (`server/index.ts`, `web/src/store.ts`).
- **Brief:** the morning brief prompt gets one line per page from the new `pageBriefLine` in `server/pages.ts`. It says what changed, or that the refresh failed (with the reason), is still running, was stopped, hasn't run today, or the page is new today. The model is told to mention each page's one change or failure.
- **Brief waits for a refresh:** if any page is still refreshing when the brief is due, the scheduler holds the brief for at most 30 minutes (`holdBrief`, `BRIEF_HOLD_MIN`, in `server/scheduler.ts`). A brief that started waiting before midday can still go out after the midday cutoff.
- **Make tab:** pages are pinned at the top under "Every morning". Each shows when it was last refreshed and the change line, "Didn't refresh: …" in red after a failure, or "Refreshing now…" while running (`web/src/components/MakeView.tsx`, `web/src/styles.css`). The README row is updated.
- 2 new tests in `server/pages.test.ts`. I ticked the item in the backlog and added the journal entry.
- typecheck: `tsc -p tsconfig.json --noEmit` → exit 0
- test: `48 pass, 0 fail, 181 expect() calls` → exit 0 · build: `✓ built in 96ms` → exit 0
```

## 2026-10-22T05:12Z — Stop a standing page from the app
- What changed: `removePage` in server/runner.ts (shared by `save_page` remove and the app) drops the row, broadcasts `page_removed`, and cancels a refresh still in flight via the pure `refreshToCancel` (server/pages.ts, never the calling task itself) so it can't deliver over the file afterwards. `stopPage` adds a context note so the agent knows the user stopped it. New `DELETE /api/pages/:id` (server/index.ts), behind pairing and the same-origin check like the other state-changing routes.
- Web: `api.stopPage`; each pinned page in Make has "Stop refreshing" under it, with a second-tap confirm ("Stop / Keep", says today's refresh will be cancelled if one is running, files stay) and an inline error. 1 new test in pages.test.ts; README save_page row updated.
- Why it matters against Claude Duet: the standing artifact is the user's to manage, so stopping it is one tap in the app instead of a message to the agent.
- Verified: typecheck pass · test 49 pass / 0 fail · build pass

## 2026-10-22T01:08:05Z — loop iteration 12
- exit=0 gate=green committed=True files=10
- gate: typecheck: exit 0
- answer:
```
et it to load your organization's connectors
DONE: Stop a standing page from the app
- **Server:** new `removePage` in `server/runner.ts`, used both by `save_page` with `remove` and by the app. It deletes the page row and sends `page_removed`. If a refresh is still running, it cancels it so it can't save a new file over the page afterwards. It never cancels the task that asked for the removal; that check is the new pure `refreshToCancel` in `server/pages.ts`. `stopPage` also leaves the agent a note that the user stopped the page.
- **Route:** new `DELETE /api/pages/:id` in `server/index.ts`. It requires pairing and passes the same-origin check like the other routes that change state. The client call is `api.stopPage` in `web/src/api.ts`.
- **Make tab:** each pinned page now has a "Stop refreshing" button under it, which needs a second tap to confirm (Stop / Keep). The confirm line says today's refresh will be cancelled if one is running, and that the files stay. Errors show under the row. Files: `web/src/components/MakeView.tsx`, `web/src/styles.css`.
- 1 new test in `server/pages.test.ts`. The `save_page` row in `README.md` is updated, the backlog item is ticked, and the journal entry is added.
- typecheck: `tsc -p tsconfig.json --noEmit` → exit 0
- test: `49 pass, 0 fail, 186 expect() calls` → exit 0
- build: `✓ built in 107ms` → exit 0

> CORRECTION: the backlog item lists `server/db.ts` as a file to change, but `pages.remove` was already there, so it didn't need touching.
```

## 2026-10-22T05:20Z — Push that survives iOS
- What changed: new pure `server/presence.ts` (+3 tests in presence.test.ts): each open window reports visible/hidden with a random client id, and a visible report holds a 40s lease. New authenticated, same-origin `POST /api/presence` (server/index.ts). `notify` (server/push.ts) skips subscriptions whose device has a visible window, unless `always` is set (the test push).
- web/public/sw.js always calls `showNotification` (the visibility check is gone) and handles `pushsubscriptionchange` by re-subscribing and posting the new subscription. web/src/api.ts reports presence on connect, visibilitychange, pagehide (keepalive) and every 15s while visible, and re-registers the subscription once per launch when permission is granted (shared `subscribeDevice` with `enablePush`). README line updated.
- WebKit check: web search was not permitted this run. The rule that Safari revokes push permission when a push shows no notification comes from memory of WebKit's "Web Push for Web Apps on iOS and iPadOS" post, not a fresh read. Added a backlog item for checking it on a real device.
- Why it matters against Claude Duet: "goes quiet until something needs you" depends on the push channel staying alive; iOS no longer sees silent pushes, so it has no reason to cut the subscription.
- Verified: typecheck pass · test 52 pass / 0 fail · build pass

## 2026-10-22T01:10:34Z — loop iteration 13
- exit=0 gate=green committed=True files=9
- gate: typecheck: exit 0
- answer:
```
t lasts 40 seconds unless renewed. It's reported through a new `POST /api/presence` route in `server/index.ts`, which requires pairing and the same-origin check. `notify` in `server/push.ts` doesn't send to a device that has the app on screen, except for the test push. 3 new tests in `server/presence.test.ts`.
- **Service worker:** `web/public/sw.js` now shows every push it receives; the check that skipped pushes while the app was visible is gone. It also handles `pushsubscriptionchange` by subscribing again and sending the new subscription to the server.
- **App:** `web/src/api.ts` reports visibility when it connects, when visibility changes, when the page closes, and every 15 seconds while visible. Once per launch, if notifications are allowed, it registers its push subscription again. README line updated.
- I couldn't check the WebKit rule against current docs because web search wasn't permitted. The rule (Safari revokes push permission when a push shows no notification) is from memory of WebKit's "Web Push for Web Apps on iOS and iPadOS" post, and I don't know whether iOS Safari fires `pushsubscriptionchange`. I added a backlog item, "Check push on a real iPhone", which needs the owner.
- typecheck: `tsc -p tsconfig.json --noEmit` → exit 0
- test: `52 pass, 0 fail, 195 expect() calls` → exit 0
- build: `✓ built in 102ms` → exit 0

> CORRECTION: `server/bus.ts` didn't need changing. Visibility goes through its own small route instead of being tied to the live event stream.
```

## 2026-10-22T05:15Z — Continuity is visible
- Skipped "Check push on a real iPhone": it needs the owner on a device. It's now marked BLOCKED in the backlog.
- What changed: new `server/capabilities.ts` (+5 tests in capabilities.test.ts) builds a names-only `Capabilities` (shared/types.ts). It has: context-file bullet labels; Hermes skills counted per category from `GET /v1/skills`, falling back to a read-only SKILL.md walk of `~/.hermes/skills`; enabled toolset labels from `GET /v1/toolsets` (both new in server/hermes.ts); and MCP server names from `~/.hermes/config.yaml` (disabled servers and `duet` left out, no YAML parser). Cached 5 min. New paired `GET /api/capabilities` (server/index.ts).
- Web: new `WhatICanSee` component. Settings has a "What I can see" section (context, skills, tools, apps). The empty thread shows a one-line "Already here: …". `api.capabilities`, CSS, README line.
- Found: the installed Hermes `_handle_skills` passes `include_editorial=True` to a function that doesn't accept it, so `/v1/skills` probably returns 500 here and the file fallback is used. Added as an owner backlog item.
- Why it matters against Claude Duet: "memory, skills and apps are there from the first message", and now the user can see that they are.
- Verified: typecheck pass · test 57 pass / 0 fail · build pass

## 2026-10-22T01:15:46Z — loop iteration 14
- exit=0 gate=green committed=True files=13
- gate: typecheck: exit 0
- answer:
```
ntext sources, from the bullets in the context file;
  - Hermes skills, counted per category, from `GET /v1/skills`, or by reading `~/.hermes/skills` if that call fails;
  - the enabled tools, from `GET /v1/toolsets`;
  - the connected apps, meaning MCP server names from `~/.hermes/config.yaml`, leaving out disabled ones and `duet`.
- **Route:** new `GET /api/capabilities` in `server/index.ts`, which requires pairing. The two Hermes calls are in `server/hermes.ts`, and the `Capabilities` type is in `shared/types.ts`.
- **App:** the new `web/src/components/WhatICanSee.tsx` adds a "What I can see" section to Settings and an "Already here: …" line on the empty thread. Also touched: `web/src/api.ts`, `web/src/styles.css`, `README.md`, and 5 new tests in `server/capabilities.test.ts`.
- **Possible Hermes bug:** the installed Hermes code for `/v1/skills` passes an argument (`include_editorial=True`) that the function it calls doesn't accept, so it probably returns an error here and the app falls back to reading the skills folder. I didn't confirm this against the running gateway. It's added to the backlog as an owner check.
- typecheck: `tsc -p tsconfig.json --noEmit` → exit 0
- test: `57 pass, 0 fail, 203 expect() calls` → exit 0
- build: `✓ built in 90ms` → exit 0

> CORRECTION: the backlog item expected that Hermes might not list skills or toolsets at all. It does have `GET /v1/skills` and `GET /v1/toolsets`, so the app uses those and reads `~/.hermes/skills` only as a fallback.
```

## 2026-10-22T05:25Z — Recovery card says what was retried
- Skipped "Hermes /v1/skills may 500": it needs the owner to call the running gateway; now marked BLOCKED in the backlog.
- What changed: new pure `server/recovery.ts` (+4 tests in recovery.test.ts). `resumeCardBody` writes the "Pick it back up?" card body: says when the turn had already been through the silent unpause-and-retry (`spec.retried`), and names the last finished step (the task's last ticked checklist step, else the last completed tool call) or "Nothing had finished yet." Used by the INTERRUPTED branch of `finish` (server/runner.ts).
- `recoverOrphans` now seeds `run.steps` from the saved activity item. Before, a run reattached after a Duet restart started with no steps, so when Hermes no longer knew the run, `finish` overwrote the thread's activity with an empty step list and the card had nothing to report. A replay that does arrive matches the seeded steps by tool_call_id.
- Why it matters against Claude Duet: the user can tell at a glance how far the interrupted work got before tapping "Pick it up".
- Verified: typecheck pass · test 61 pass / 0 fail · build pass

## 2026-10-22T01:17:32Z — loop iteration 15
- exit=0 gate=green committed=True files=5
- gate: typecheck: exit 0
- answer:
```
recedence over your claude.ai login · Unset it to load your organization's connectors
DONE: Recovery card says what was retried

- **Skipped "Hermes /v1/skills may 500":** the owner has to check the running gateway, so I marked it BLOCKED in the backlog.
- **Card wording:** new `server/recovery.ts`. When Hermes restarts mid-run, the "Pick it back up?" card now names the last step that finished: the task's last ticked step, or else the last completed tool call. If nothing finished, it says "Nothing had finished yet." If the run had already been unpaused and retried once without telling the user, the card now says so. `server/runner.ts` uses this wording for the card. 4 new tests in `server/recovery.test.ts`.
- **Bug fix:** when Duet restarts and picks a run back up, it now keeps the steps saved in the thread instead of starting from none (`recoverOrphans` in `server/runner.ts`). Before, if Hermes had also lost the run, Duet wiped those steps from the thread and the card had nothing to show. Steps Hermes sends again are matched by their call id, so they aren't duplicated.
- The backlog item is ticked and the journal entry is added.
- typecheck: `tsc -p tsconfig.json --noEmit` → exit 0
- test: `61 pass, 0 fail, 211 expect() calls` → exit 0
- build: `✓ built in 100ms` → exit 0

> CORRECTION: the item says the card is at `server/runner.ts:542`; it is now at about line 564. "Last completed step from `run.steps`" was always empty after a Duet restart until the recovery change above.
```

## 2026-10-22T05:19Z — Morning brief with nothing at all still pushes free text
- What changed: new pure `morningOutcome` in server/brief.ts (+3 tests in brief.test.ts). `finish()` in server/runner.ts no longer pushes "Your morning brief" when the brief run posted no card. The run's reply has already streamed into the thread as the agent's message, so it stays there unpushed and is logged. A run with no card and no reply leaves a system line (`EMPTY_MORNING_NOTE`) so the user can still see the brief ran.
- briefPrompt step 4/5 (server/prompts.ts): skip post_brief only when there is nothing to decide and nothing to watch, and make the closing line say there was nothing today. Fixed the stale "service worker drops this" comment on the reply push (presence is checked in notify() since iteration 13).
- Why it matters against Claude Duet: "goes quiet until something genuinely needs you". A morning with nothing in it no longer sends a push.
- Verified: typecheck pass · test 64 pass / 0 fail · build pass

## 2026-10-22T01:19:35Z — loop iteration 16
- exit=0 gate=green committed=True files=6
- gate: typecheck: exit 0
- answer:
```
⚠ claude.ai connectors are disabled because ANTHROPIC_API_KEY or another auth source is set and takes precedence over your claude.ai login · Unset it to load your organization's connectors
DONE: Morning brief with nothing at all still pushes free text
- **What changed:** when the morning brief run posts no brief card, `finish()` in `server/runner.ts` no longer pushes its reply as "Your morning brief". The decision is in the new pure `morningOutcome` in `server/brief.ts`, with 3 new tests in `server/brief.test.ts`.
- **What the user sees:** the brief's reply has already streamed into the thread as the agent's message, so it stays there without a push and is logged. If the run posted no card and also said nothing, the thread gets a short system line instead, so the user can see the brief ran.
- **Prompt:** in `briefPrompt` (`server/prompts.ts`) the agent skips `post_brief` only when there's nothing to decide and nothing to watch, and its closing line has to say there was nothing today. I also fixed a stale comment on the reply push, and ticked the backlog item and added the journal entry.
- typecheck: `tsc -p tsconfig.json --noEmit` → exit 0
- test: `64 pass, 0 fail, 215 expect() calls` → exit 0
- build: `✓ built in 97ms` → exit 0

> CORRECTION: the backlog said to "post that reply as a quiet thread note", but brief runs aren't marked quiet, so the reply was already in the thread. The only change it needed was removing the push.
```

## 2026-10-22T05:21Z — Push approve skips the draft
- What changed: new pure `approvalPush` in server/approval.ts (+1 test in approval.test.ts) builds the request_approval push. A card with a draft gets `has_draft` and the body "<title>. Draft ready to read." The draft text never goes into the payload. Used in server/runner.ts; `has_draft` was added to `PushPayload` (server/push.ts).
- web/public/sw.js: when `has_draft` is set, the first action is "Read the draft" (`open`, which falls through to the existing open-the-card path) instead of Approve. "Not now" stays. Cards without a draft keep one-tap Approve.
- Not changed: notifications already on screen from the old SW still have Approve until they're dismissed. The server still accepts a bare approve, because the app sends `value` only when the user edited the draft.
- Found: Hermes-native "Allow once" pushes have the same problem with the command text. Added to the backlog.
- Why it matters against Claude Duet: "waits for your ok when it matters, with the full draft in the card". An ok has to mean the user saw the draft.
- Verified: typecheck pass · test 65 pass / 0 fail · build pass

## 2026-10-22T01:21:21Z — loop iteration 17
- exit=0 gate=green committed=True files=7
- gate: typecheck: exit 0
- answer:
```
ce over your claude.ai login · Unset it to load your organization's connectors
DONE: Push approve skips the draft
- **Server:** the approval push is now built by a new `approvalPush` in `server/approval.ts`, used in `server/runner.ts` (`request_approval`). If the card has a draft, the push is flagged `has_draft` (new field on `PushPayload` in `server/push.ts`) and the banner reads "<title>. Draft ready to read." The draft text itself is not put in the push. 1 new test in `server/approval.test.ts`.
- **Service worker:** in `web/public/sw.js`, a push with `has_draft` shows "Read the draft" instead of Approve, and that button opens the card. "Not now" is still there, and cards without a draft keep one-tap Approve.
- **Not covered:** notifications already on screen from the old service worker still show Approve until they're dismissed. The server still accepts an approve with no draft text attached, because the app only sends the text when the user has edited it.
- **Same problem found elsewhere:** when Hermes itself asks to run a flagged command, the push's "Allow once" approves it without the user seeing the command. I added this to the backlog as the next item.
- typecheck: `tsc -p tsconfig.json --noEmit` → exit 0
- test: `65 pass, 0 fail, 220 expect() calls` → exit 0
- build: `✓ built in 74ms` → exit 0

> CORRECTION: the push payload is built in the new `approvalPush` in `server/approval.ts`, not written inline in `server/runner.ts` as the item says, so that it can be tested.
```

## 2026-10-22T05:23Z — Push "Allow once" runs a command unseen
- What changed: `approvalPush` (server/approval.ts) now builds the push for Hermes-native approvals too. Every one gets `must_read` and the body "<description>. Check the command first."; the command never goes into the payload. `hermesPrompt` in server/runner.ts uses it (clarify pushes are unchanged). `has_draft` is renamed `must_read` on `PushPayload` (server/push.ts). +1 test in approval.test.ts.
- web/public/sw.js: `must_read` (or the old `has_draft`, for pushes queued before the rename) gives "Read it first", which opens the card, in place of Approve / Allow once.
- Not changed: the server still accepts a bare approve for Hermes cards, so a notification already on screen from the old SW keeps its Allow once until dismissed.
- Why it matters against Claude Duet: "waits for your ok when it matters". An ok to run a flagged command has to mean the user saw the command.
- Verified: typecheck pass · test 66 pass / 0 fail · build pass

## 2026-10-22T01:23:32Z — loop iteration 18
- exit=0 gate=green committed=True files=7
- gate: typecheck: exit 0
- answer:
```
nother auth source is set and takes precedence over your claude.ai login · Unset it to load your organization's connectors
DONE: Push "Allow once" runs a command unseen
- **Server:** `approvalPush` in `server/approval.ts` now also builds the push for Hermes's own approvals, and `hermesPrompt` in `server/runner.ts` uses it. Pushes for questions are unchanged. Every Hermes approval push now carries `must_read`, and its text reads "<description>. Check the command first." The command itself is never put in the push.
- **Rename:** the push flag `has_draft` is now `must_read` on `PushPayload` (`server/push.ts`). Duet cards with a draft still set it, as before.
- **Service worker:** in `web/public/sw.js`, a push with `must_read` (or the old `has_draft`) shows a "Read it first" button that opens the card, instead of Approve or "Allow once".
- **Tests:** 1 new test in `server/approval.test.ts`. Backlog item ticked, journal entry added.
- **Not covered:** the server still accepts an approve that comes with nothing else, so a notification already on screen from the old service worker keeps its "Allow once" button until it's dismissed.
- typecheck: `tsc -p tsconfig.json --noEmit` → exit 0
- test: `66 pass, 0 fail, 223 expect() calls` → exit 0
- build: `✓ built in 103ms` → exit 0

> CORRECTION: the item offered putting a shortened command in the push text. I left it out on purpose, as with drafts, because a command can contain private details and the push text appears on the lock screen.
```

## 2026-10-22T05:24Z — Interrupted tasks push twice
- What changed: `failTask` (server/runner.ts) takes `{ push = true }`. The INTERRUPTED branch of `finish` calls it with `push: false`, so the task is still marked failed and the agent still gets its context note, but the "Pick it back up?" card's "Work was interrupted" push is the only notification. The other caller (a run that couldn't start) still pushes.
- Why it matters against Claude Duet: "goes quiet until something genuinely needs you". One event now sends one push.
- Verified: typecheck pass · test 66 pass / 0 fail · build pass (no new test: the change is one flag at an impure call site in runner.ts, which has no harness)
