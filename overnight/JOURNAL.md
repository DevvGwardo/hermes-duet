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

## 2026-10-22T01:24:41Z — loop iteration 19
- exit=0 gate=green committed=True files=3
- gate: typecheck: exit 0
- answer:
```
⚠ claude.ai connectors are disabled because ANTHROPIC_API_KEY or another auth source is set and takes precedence over your claude.ai login · Unset it to load your organization's connectors
DONE: Interrupted tasks push twice
- **Change:** in `server/runner.ts`, `failTask` now takes an option `{ push = true }`. When Hermes restarts mid-task, `finish` calls it with `push: false`. The task is still marked failed and the agent still gets its note, but the "Work was interrupted" push from the "Pick it back up?" card is now the only notification. When a run can't start at all, it still sends its "Task failed" push.
- **No new test:** the fix is one flag at a call site in `runner.ts`, and `runner.ts` has no test setup. The existing 66 tests still pass.
- Backlog item ticked; journal entry added.
- typecheck: `tsc -p tsconfig.json --noEmit` → exit 0
- test: `66 pass, 0 fail, 223 expect() calls` → exit 0
- build: `✓ built in 103ms` → exit 0
```

## 2026-10-22T05:27Z — Follow-up chips forget they were tapped
- What changed: two new card actions in `actOnCard` (server/runner.ts). `send_action` (a brief entry without a draft) and `follow_up` (a handover chip) read the message from the stored card, mark that entry or follow-up `used`, then send the message as the user through `submitUser`. The pure rules are the new `useAction` (server/brief.ts) and `useFollowUp` (server/handover.ts), sharing `chipIndex`. `FollowUp.used` was added in shared/types.ts.
- `handoverCard` takes the previous card, so `handOver` refreshing a card in place keeps chips that were already tapped spent. web/src/components/CardView.tsx: both chip kinds go through a shared `useChips` hook, read "On it" from `used`, and show errors. They no longer call `api.send` directly. +6 tests (brief.test.ts, handover.test.ts).
- Why it matters against Claude Duet: one tap means one request. A reload or a second device can no longer send the same follow-up twice.
- Verified: typecheck pass · test 72 pass / 0 fail · build pass

## 2026-10-22T01:27:25Z — loop iteration 20
- exit=0 gate=green committed=True files=9
- gate: typecheck: exit 0
- answer:
```
d your organization's connectors
DONE: Follow-up chips forget they were tapped
- **Server:** `actOnCard` in `server/runner.ts` takes two new actions. `send_action` is for brief entries without a draft, and `follow_up` is for the chips on a finished task's card. Each one reads the message from the saved card, not from the phone, marks that chip `used`, and sends the message as the user. A second tap is refused with "already sent to Hermes". The rules are in new functions in `server/brief.ts` (`useAction`, `chipIndex`) and `server/handover.ts` (`useFollowUp`). `FollowUp.used` is added in `shared/types.ts`.
- **Card refresh:** `handoverCard` now takes the previous card. Before, refreshing a finished-task card in place would turn chips the user had already tapped back on.
- **Web:** in `web/src/components/CardView.tsx`, both kinds of chip go through a shared `useChips` hook. They show "On it" based on `used` from the saved card, so it holds after a reload and on other devices, and errors are shown. The chips no longer call `api.send` directly.
- **Tests:** 6 new, in `server/brief.test.ts` and `server/handover.test.ts`. Backlog item ticked and journal entry added.
- typecheck: `tsc -p tsconfig.json --noEmit` → exit 0
- test: `72 pass, 0 fail, 246 expect() calls` → exit 0
- build: `✓ built in 103ms` → exit 0

> CORRECTION: the item lists `server/brief.ts`, `server/handover.ts` and both test files only implicitly. The check logic lives there, not in `runner.ts`, so it can be tested.
```

## 2026-10-22T05:31Z — Check-ins re-raise this morning's decisions
- What changed: the backlog had no open, unblocked items, so this iteration audited check-ins against Claude Duet and added this item. Brief cards are `info`, so they never appear in the check-in's "already waiting" list, and the check-in session never saw the morning brief. New pure `raisedToday` (server/brief.ts, +3 tests) turns today's brief cards into prompt lines: decisions tagged with their card id and "already acted on" when the chip was used, plus watching titles, deduplicated by title and capped at 15 each.
- New `items.briefsSince` query (server/db.ts). `runCheckin` (server/runner.ts) passes the briefs since local midnight. `checkinPrompt` (server/prompts.ts) tells the agent not to raise those decisions again unless something material changed, and to raise a watching item only once it needs a decision.
- Why it matters against Claude Duet: "goes quiet until something genuinely needs you". A decision raised at breakfast shouldn't come back as an 11 AM "Heads up".
- Verified: typecheck pass · test 75 pass / 0 fail · build pass

## 2026-10-22T01:29:36Z — loop iteration 21
- exit=0 gate=green committed=True files=7
- gate: typecheck: exit 0
- answer:
```
item was ticked except two that wait on the owner. So I looked for gaps and found this one. Check-ins only get pending cards in their "already waiting" list, but brief cards have status `info`, so they never appear there. The check-in also runs in its own session, which never saw the morning brief. That means it could push "Heads up" about a decision the user already read that morning.
- **Fix:** a new pure function `raisedToday` in `server/brief.ts` turns today's brief cards into prompt lines. Each decision carries its card id and notes when the user already acted on it. Watching titles are listed separately. Titles are deduplicated and capped at 15 each.
- **Wiring:** a new `items.briefsSince` query in `server/db.ts`, and `runCheckin` in `server/runner.ts` passes in the briefs posted since local midnight. `checkinPrompt` in `server/prompts.ts` tells the agent not to raise those again unless something material changed. A watching item is raised only once it needs a decision.
- **Tests:** 3 new in `server/brief.test.ts`. I added the item to the backlog already ticked, plus a journal entry.
- **Limit:** this is a prompt instruction, not a hard filter, so the model can still repeat itself.
- typecheck: `tsc -p tsconfig.json --noEmit` → exit 0
- test: `75 pass, 0 fail, 251 expect() calls` → exit 0
- build: `✓ built in 103ms` → exit 0

> CORRECTION: there was no unchecked, unblocked item for this iteration, so I found and added this one myself instead of taking one from the list.
```

## 2026-10-22T05:32Z — A failed morning brief is lost for the day
- What changed: the backlog had no open, unblocked items, so this iteration audited the brief path and added this item. A brief run that ended in an error before posting (INTERRUPTED, timeout, model error) left only the generic "Something went wrong… ask me differently" note, and `brief_last_date` was already set, so no brief until tomorrow.
- New pure `briefFailure` + `BRIEF_RETRY` (server/brief.ts, +3 tests) words the reason. `finish` (server/runner.ts) posts a pending choice card "This morning's brief didn't finish" with `rerun: 'brief'` (shared/types.ts) and pushes it like the brief (`ignoreQuiet`). In `actOnCard`, "Run it now" calls `runBrief('manual')` with no agent turn, and "Skip today" does nothing. `expireBriefRetries` expires older retry cards when a morning `post_brief` lands or the brief fails again. README "Survives restarts" mentions it.
- Not changed: a brief the user stops with Stop stays silent, because that was deliberate. Queued a backlog item on quiet hours dropping pushes.
- Why it matters against Claude Duet: "it briefs you every morning". A failure at brief time has to come back to the user with a one-tap retry, not disappear.
- Verified: typecheck pass · test 78 pass / 0 fail · build pass

## 2026-10-22T01:33:05Z — loop iteration 22
- exit=0 gate=green committed=True files=7
- gate: typecheck: exit 0
- answer:
```
cked, unblocked backlog item (only the two that wait on the owner). So I looked for a gap myself, fixed it, and added it to the backlog already ticked, as iteration 21 did.

- **The gap:** the scheduler marks today's brief as sent before it runs. If the run then errors (Hermes restarts under it, it times out, or the model call fails), the user only got a generic "Something went wrong… ask me differently" line, with no push and no retry until tomorrow.
- **Fix:** a new `briefFailure` in `server/brief.ts` turns the error into a plain reason. `finish` in `server/runner.ts` then posts a pending "This morning's brief didn't finish" card with **Run it now / Skip today**, flagged `rerun: 'brief'` in `shared/types.ts`. It pushes even in quiet hours, the same as the brief itself.
- **Behaviour:** "Run it now" calls `runBrief('manual')` directly, with no extra agent turn. When a morning brief does post, or the brief fails again, older retry cards are marked expired. A brief the user stopped with Stop still leaves no card, on purpose. README "Survives restarts" mentions it. 3 new tests in `server/brief.test.ts`.
- **New backlog item (open):** quiet hours throw away pushes for questions, finished tasks and interrupted work instead of holding them, while approvals ignore quiet hours. The owner should decide whether approvals should respect them.
- typecheck: `tsc -p tsconfig.json --noEmit` → exit 0
- test: `78 pass, 0 fail, 259 expect() calls` → exit 0
- build: `✓ built in 120ms` → exit 0
```

## 2026-10-22T05:35Z — Quiet hours drop pushes instead of holding them
- What changed: `notify` (server/push.ts) no longer drops a push that quiet hours suppress. It adds it to kv `push_held` via the new pure `holdPush` (server/held.ts). Only pushes about a card are held: questions, interrupted work, Done/Task failed. Each card is held once, newest wins, capped at 20, and the list survives restarts.
- `releaseHeld` in server/scheduler.ts runs on the first tick outside quiet hours. It clears the list and sends one "While you were away" push (`awayPush`: up to 3 lines plus "+N more", and it links the card when there is only one). Cards still pending and task handovers are kept, anything resolved overnight is dropped. If `briefCoversHeld` finds the brief due within the hour (or catching up) and not yet sent, nothing is pushed. README updated. +5 tests (server/held.test.ts).
- Not changed: approvals, Hermes clarify questions and the brief still push with `ignoreQuiet`. The item said to ask the owner, so I queued that as a blocked owner question.
- Why it matters against Claude Duet: "goes quiet until something genuinely needs you" now means quiet, without losing anything. What needed the user overnight still reaches them once, when they're awake.
- Verified: typecheck pass · test 83 pass / 0 fail · build pass

## 2026-10-22T01:35:44Z — loop iteration 23
- exit=0 gate=green committed=True files=7
- gate: typecheck: exit 0
- answer:
```
n · Unset it to load your organization's connectors
DONE: Quiet hours drop pushes instead of holding them
- **Holding:** when quiet hours block a push, `notify` in `server/push.ts` now saves it instead of dropping it. Only pushes about a card are saved: questions, interrupted work and finished or failed tasks. Each card keeps only its newest push, the list holds at most 20 and survives restarts. The rules are in the new `server/held.ts`.
- **Sending:** at the first scheduler check after quiet hours end, `releaseHeld` in `server/scheduler.ts` sends one "While you were away" push. It lists up to 3 items plus "+N more", and links straight to the card when there is only one. It skips cards the user already answered overnight, and sends nothing if today's brief hasn't gone out yet and is due within the hour.
- **Not changed:** approvals, Hermes's own clarifying questions and the brief still push during quiet hours. The item said to ask you first, so I added a blocked backlog item for your decision.
- **Docs and tests:** README updated; 5 new tests in `server/held.test.ts`. Backlog item ticked and journal entry added.
- typecheck: `tsc -p tsconfig.json --noEmit` → exit 0
- test: `83 pass, 0 fail, 279 expect() calls` → exit 0
- build: `✓ built in 103ms` → exit 0

> CORRECTION: finished or failed task cards are never "pending" (they're info cards), so I kept their saved pushes as well as pending cards. Otherwise the "Done:" and "Task failed" pushes the item lists would still be lost.
```

## 2026-10-22T05:40Z — Interrupted page refresh asks and pushes like user work
- What changed: the backlog had no open, unblocked items, so this iteration audited standing pages and added this item. A Hermes restart during a scheduled refresh used to take `finish`'s generic INTERRUPTED branch, which posted "Pick “Refresh: …” back up?" and a "Work was interrupted" push, left `last_ok` unset, and showed nothing in Make.
- New pure `afterInterruption` (server/pages.ts, +2 tests). The first interruption calls the new `requeueTask` (server/runner.ts, now shared with "Try again"), which starts a fresh session with spec `restarted: true` and an "it's starting over on its own" line from `taskPrompt(…, auto)` (server/prompts.ts). There is no card and no push, and the brief still holds while the refresh is running. A second interruption goes through `onTaskRunEnd` → `pageRefreshEnded`, which shows the muted failed card with Try again and no push, and the brief reports that the refresh failed. README "Survives restarts" mentions it.
- Why it matters against Claude Duet: the standing page "refreshes on a schedule before the brief". A gateway restart at 6:30 shouldn't buzz the user about a job they never started.
- Verified: typecheck pass · test 85 pass / 0 fail · build pass

## 2026-10-22T01:39:51Z — loop iteration 24
- exit=0 gate=green committed=True files=7
- gate: typecheck: exit 0
- answer:
```
KEY or another auth source is set and takes precedence over your claude.ai login · Unset it to load your organization's connectors
DONE: Interrupted page refresh asks and pushes like user work
- **Gap found:** the backlog had no open, unblocked items, so I looked for a gap myself. When Hermes restarted during a standing page's scheduled refresh, the user got a "Pick “Refresh: …” back up?" card and a "Work was interrupted" push for a job they never started. The page also never recorded that the refresh failed.
- **Fix:** a new rule, `afterInterruption` in `server/pages.ts`, makes the first interruption quietly start the refresh over in a fresh session, with no card and no push. The morning brief still waits while it runs. If it's interrupted a second time, it ends the way any failed refresh does: a muted card with Try again, no push, and the brief says it failed.
- **Supporting changes:** `requeueTask` in `server/runner.ts` is now shared with "Try again". `taskPrompt` in `server/prompts.ts` has an `auto` wording for this restart, so the agent isn't told the user tapped Try again. README updated, 2 new tests in `server/pages.test.ts`. Backlog item added already ticked, plus a journal entry.
- typecheck: `tsc -p tsconfig.json --noEmit` → exit 0
- test: `85 pass, 0 fail, 284 expect() calls` → exit 0
- build: `✓ built in 97ms` → exit 0

> CORRECTION: there was no unchecked, unblocked item for this iteration, so I found and added this one myself instead of taking one from the list.
```

## 2026-10-22T05:45Z — Hermes prompts outlive their run
- What changed: the backlog had no open, unblocked items, so this iteration audited approvals and added this item. New pure `deadPrompts` (server/approval.ts, +1 test) picks pending `card.hermes` prompts whose run is not live. Duet's own cards are left alone, because their answer resumes the session as a new turn.
- `expireDeadPrompts` (server/runner.ts) marks them `expired` with decision "Its run ended". It runs in `finish` (before the fg-task and task "waiting" checks count pending cards), at the end of `recoverOrphans` once live runs are reattached (which also clears cards left over from before this change), and in `actOnCard`, so a stale tap gets an error and the card isn't recorded as approved. CardView shows "Expired · Its run ended".
- Why it matters against Claude Duet: "Needs you" and the brief should list only what the user can actually act on. A dead "Allow once" card is noise that looks like a decision.
- Verified: typecheck pass · test 86 pass / 0 fail · build pass

## 2026-10-22T01:42:20Z — loop iteration 25
- exit=0 gate=green committed=True files=6
- gate: typecheck: exit 0
- answer:
```
use ANTHROPIC_API_KEY or another auth source is set and takes precedence over your claude.ai login · Unset it to load your organization's connectors
DONE: Hermes prompts outlive their run
- **Gap I found:** the backlog had no open, unblocked items, so I picked this one myself. When Hermes asks for approval or asks a question, the card can only be answered while that run is still going. If the run ended first (Stop, a timeout, or Hermes restarting), the card stayed pending forever. It sat in "Needs you", the brief and check-ins listed it as waiting, and tapping "Allow once" marked it approved even though nothing happened.
- **Fix:** a new `deadPrompts` in `server/approval.ts` finds those cards. Duet's own approval cards are left alone, because answering one restarts the conversation as a new turn. `expireDeadPrompts` in `server/runner.ts` marks the dead cards expired in three places: when a run finishes, after restart recovery (this also clears cards left over from before this change), and when the user taps one, which now shows an error. `CardView.tsx` shows "Expired · Its run ended".
- **Tests:** 1 new in `server/approval.test.ts`. Backlog item added already ticked, plus a journal entry.
- typecheck: `tsc -p tsconfig.json --noEmit` → exit 0
- test: `86 pass, 0 fail, 286 expect() calls` → exit 0
- build: `✓ built in 72ms` → exit 0

> CORRECTION: there was no unchecked, unblocked item for this iteration, so I found and added this one myself instead of taking one from the list.
```

## 2026-10-22T05:50Z — A missed morning brief silences the whole day
- What changed: the backlog had no open, unblocked items, so this iteration audited the scheduler and added this item. Check-ins waited for `brief_last_date === today`, but a brief past its catch-up window (after midday, or an afternoon brief time missed by its one minute) never sets it, so a late wake meant no check-ins all day.
- New pure `briefSlot` (server/clock.ts, +1 test) returns off/sent/early/due/missed. `startScheduler` (server/scheduler.ts) runs or holds the brief on `due`, and check-ins now wait only on `early`. `briefCoversHeld` (server/held.ts) uses the same rule, so its catch-up window can't drift from the scheduler's.
- Not changed: a missed brief still isn't sent late. A 3 PM "morning brief" is still noise.
- Why it matters against Claude Duet: "goes quiet until something genuinely needs you". Being quiet because the Mac slept through breakfast is a different thing, and it shouldn't last all day.
- Verified: typecheck pass · test 87 pass / 0 fail · build pass

## 2026-10-22T01:45:42Z — loop iteration 26
- exit=0 gate=green committed=True files=6
- gate: typecheck: exit 0
- answer:
```
⚠ claude.ai connectors are disabled because ANTHROPIC_API_KEY or another auth source is set and takes precedence over your claude.ai login · Unset it to load your organization's connectors
DONE: A missed morning brief silences the whole day
- **The gap:** the backlog had no open, unblocked items, so I picked this one myself. Check-ins wait until today's brief has gone out. If the Mac slept past midday, the brief is skipped as too late, but it never gets marked as handled. So that day there was no brief and no check-ins at all. The same happens if an afternoon brief time is missed by its one minute.
- **Fix:** a new `briefSlot` in `server/clock.ts` says where today's brief stands: off, sent, early, due or missed. `server/scheduler.ts` runs or holds the brief when it's due, and check-ins now wait only while it's still early. `briefCoversHeld` in `server/held.ts` uses the same rule, so the "While you were away" push and the scheduler always agree on when the brief is late.
- **Not changed:** a missed brief still isn't sent in the afternoon.
- **Tests:** 1 new in `server/clock.test.ts`. Backlog item added already ticked, plus a journal entry.
- typecheck: `tsc -p tsconfig.json --noEmit` → exit 0
- test: `87 pass, 0 fail, 295 expect() calls` → exit 0
- build: `✓ built in 104ms` → exit 0

> CORRECTION: there was no unchecked, unblocked item for this iteration, so I found and added this one myself instead of taking one from the list.
```

## 2026-10-22T05:55Z — Notification taps on briefs and handovers don't open the card
- What changed: the backlog had no open, unblocked items, so this iteration audited the push-to-card path and added this item. Brief, check-in and Done/Task failed pushes set only `url: /?card=…`. When a window already exists, the SW posts `{ card_id: null, url }`, and `App.tsx` only used `card_id`. So the tap switched to Chat and never scrolled to the card.
- `cardOf` moved from server/held.ts to the new dependency-free shared/links.ts, and held.ts imports it. In App.tsx the SW message handler and the cold-start `location.search` read now both go through `cardOf`. The handler clears `jump` before setting it, so a repeat tap on the same card scrolls again. Cold start drops `?card=` with `history.replaceState`, so a reload doesn't jump back. +2 assertions in server/held.test.ts.
- Not changed: server push payloads and sw.js. The client now reads either form, including notifications already on the lock screen.
- Why it matters against Claude Duet: large tasks "come back as a finished artifact" and the brief is the morning's entry point. Tapping either notification has to land on that card.
- Verified: typecheck pass · test 87 pass / 0 fail · build pass

## 2026-10-22T01:48:08Z — loop iteration 27
- exit=0 gate=green committed=True files=6
- gate: typecheck: exit 0
- answer:
```
tors are disabled because ANTHROPIC_API_KEY or another auth source is set and takes precedence over your claude.ai login · Unset it to load your organization's connectors
DONE: Notification taps on briefs and handovers don't open the card
- **What was wrong:** the backlog had no open items the loop could take, so I picked this one myself. The morning brief, check-in and "Done:" / "Task failed" notifications only put their card in the link (`/?card=…`), and the app only looked at `card_id`. So tapping one while the app was open in the background opened Chat without scrolling to the card. Tapping the same card twice did nothing, and after opening from a notification every reload jumped back to that card.
- **Fix:** `cardOf` moved from `server/held.ts` into the new shared file `shared/links.ts`. `web/src/App.tsx` now uses it for both the in-app tap and the cold-start link. A repeat tap scrolls again, and the `?card=` is cleared from the address once it has been read.
- **Tests:** 2 new checks in `server/held.test.ts`. The new item is in the backlog already ticked, and the journal entry is added. I didn't change the server's notifications or `sw.js`, and I haven't tried this on a real phone.
- typecheck: `tsc -p tsconfig.json --noEmit` → exit 0
- test: `87 pass, 0 fail, 297 expect() calls` → exit 0
- build: `✓ built in 104ms` → exit 0

> CORRECTION: there was no unchecked, unblocked item for this iteration, so I found and added this one myself instead of taking one from the list.
```

## 2026-10-22T06:00Z — Agent notify leaves nothing in the thread
- What changed: the backlog had no open, unblocked items, so this iteration audited the tool surface and added this item. `notify` (server/runner.ts) now posts a note card with `alert: true` (shared/types.ts) through `postCard` and pushes with its `card_id`/`url`. The tap opens that card, and `run.cards` stops a chat turn from also pushing its reply. Its return text now says where the card is and whether quiet hours are holding the push.
- `stillWorth` (server/held.ts) keeps held pushes for `alert` notes, so a notify sent during quiet hours comes back in "While you were away". The new pure `notifyRefusal` (server/brief.ts) refuses `notify` in check-in and morning-brief runs, which reach the user only through `post_brief`. CardView labels these notes "Heads up". The tool description and README are updated. +1 test, +2 assertions.
- Why it matters against Claude Duet: "goes quiet until something genuinely needs you". Check-ins could no longer bypass their judgment rule, and what did need the user is now in the one thread instead of only in a banner.
- Verified: typecheck pass · test 88 pass / 0 fail · build pass

## 2026-10-22T01:51:36Z — loop iteration 28
- exit=0 gate=green committed=True files=11
- gate: typecheck: exit 0
- answer:
```
 connectors
DONE: Agent notify leaves nothing in the thread
- **What was wrong:** the backlog had no open items the loop could take, so I picked this one myself. When the agent used `notify`, it got told "The item is in the thread", but nothing was ever posted there. Tapping the notification opened Chat with nothing to see, and quiet hours threw the push away. A check-in could also use `notify` to buzz the phone without going through `post_brief`, which skipped its rule of only speaking up when something needs a decision.
- **Fix:** in `server/runner.ts`, `notify` now posts a "Heads up" note card in the thread (new `alert` flag in `shared/types.ts`, label in `CardView.tsx`), and the notification opens that card. `stillWorth` in `server/held.ts` keeps these pushes during quiet hours, so they come back in the "While you were away" push.
- **Check-ins and briefs:** a new `notifyRefusal` in `server/brief.ts` refuses `notify` in check-ins and the morning brief, so they reach you only through `post_brief`. The tool description in `server/tools.ts` and the README say so.
- **Tests:** 1 new test and 2 new checks. Backlog item added already ticked, plus a journal entry. Not tried on a real phone.
- typecheck: `tsc -p tsconfig.json --noEmit` → exit 0
- test: `88 pass, 0 fail, 305 expect() calls` → exit 0
- build: `✓ built in 102ms` → exit 0

> CORRECTION: there was no unchecked, unblocked item for this iteration, so I found and added this one myself instead of taking one from the list.
```

## 2026-10-22T06:05Z — A redrafted approval leaves the old one approvable
- What changed: the backlog had no open, unblocked items, so this iteration audited the approval flow and added this item. The new pure `replaceRefusal` (server/approval.ts, +1 test) decides whether the card named in `replaces` can be withdrawn. It must be the same kind, still pending, from the calling session, and not a Hermes prompt or a resume/rerun card.
- `replacing` (server/runner.ts) checks before posting. Once the new card is up it expires the old one with decision "Replaced by a newer version", which happens before the push reads the badge count. The new push reuses the old card's tag, so the banner on the lock screen is swapped rather than added. A refused `replaces` still posts the new card, and the tool result says why nothing was withdrawn. Updated: tool schemas (server/tools.ts), a persona line (server/prompts.ts), README.
- Why it matters against Claude Duet: "waits for your ok when it matters". There should be one approval per decision, and approving a stale card must never send a draft the user already asked to change.
- Verified: typecheck pass · test 89 pass / 0 fail · build pass

## 2026-10-22T01:54:59Z — loop iteration 29
- exit=0 gate=green committed=True files=8
- gate: typecheck: exit 0
- answer:
```
ef counted both, and approving the old card told the agent to send the draft the user had asked to change.
- **Fix:** `request_approval` and `ask` now take an optional `replaces` card id. A new check, `replaceRefusal` in `server/approval.ts`, only lets the agent withdraw its own pending card of the same kind from the same conversation. It can't withdraw a Hermes prompt or one of Duet's own cards.
- **How it behaves:** `replacing` in `server/runner.ts` marks the old card expired ("Replaced by a newer version") before the push reads the badge count. The new notification replaces the old one on the lock screen. If the replace is refused, the new card is still posted and the agent is told why nothing was withdrawn.
- **Limit:** this only works if the agent passes the old card's id. If it forgets, both cards stay up as before.
- **Also changed:** tool descriptions (`server/tools.ts`), a line in the agent's instructions (`server/prompts.ts`), README, 1 new test in `server/approval.test.ts`. The backlog item is added already ticked, plus a journal entry. Not tried with a real model or on a phone.
- typecheck: `tsc -p tsconfig.json --noEmit` → exit 0
- test: `89 pass, 0 fail, 314 expect() calls` → exit 0
- build: `✓ built in 105ms` → exit 0

> CORRECTION: there was no unchecked, unblocked item for this iteration, so I found and added this one myself instead of taking one from the list.
SessionEnd hook [node "${CLAUDE_PLUGIN_ROOT}/hooks/session-end-cleanup.mjs"] failed: Hook cancelled
```

## 2026-10-22T06:10Z — Decided approvals stay on the lock screen
- What changed: the backlog had no open, unblocked items, so this iteration audited the push lifecycle and added this item. A "Needs your OK" or "Quick question" banner stayed on the lock screen after the card was settled anywhere (in the app, on another device, replaced, expired with its run). Its Approve action then got a 400 the SW swallows.
- New pure `isSettledAsk` / `settledNotifications` in shared/links.ts (+3 tests in the new server/links.test.ts). `clearSettledNotifications` (web/src/api.ts) closes those via `registration.getNotifications()`, with pending cards overriding older copies in the loaded page. App.tsx runs it on launch and whenever the set of settled asks changes; that set is a string selector, so streaming deltas don't re-run it. Briefs, handovers, "Heads up" notes and cards that aren't loaded are left alone. README line updated.
- Not changed: server and sw.js. Clearing without the app open is a new low-priority backlog item; it can't be a push of its own, because iOS revokes subscriptions that push silently.
- Why it matters against Claude Duet: "goes quiet until something genuinely needs you". A banner for a decision already made is a false "needs you".
- Verified: typecheck pass · test 92 pass / 0 fail · build pass

## 2026-10-22T02:01:33Z — loop iteration 30
- exit=0 gate=green committed=True files=7
- gate: typecheck: exit 0
- answer:
```
unblocked, so I picked this gap myself. A "Needs your OK" or "Quick question" notification stayed on the lock screen after the card was dealt with: approved, declined, answered, replaced by a redraft, or expired with its run. On Android and desktop, its Approve button then failed without telling the user.
- **Fix:** a new `settledNotifications` in `shared/links.ts` finds the notifications whose approval or question is no longer waiting. `clearSettledNotifications` in `web/src/api.ts` closes them through `getNotifications()`. `web/src/App.tsx` runs it when the app opens and each time another question or approval is settled, but not on every streamed word. Notifications for briefs, finished tasks and "Heads up" notes are left alone.
- **Limit:** the cleanup only runs when the app is open on that device, so a card approved on the desktop keeps its phone notification until the phone app opens. That is a new low-priority backlog item. I haven't tried it on a real phone.
- **Also:** 3 new tests in `server/links.test.ts`, one README line, the backlog item added already ticked, and a journal entry.
- typecheck: `tsc -p tsconfig.json --noEmit` → exit 0
- test: `92 pass, 0 fail, 317 expect() calls` → exit 0
- build: `✓ built in 94ms` → exit 0

> CORRECTION: there was no unchecked, unblocked item for this iteration, so I found and added this one myself instead of taking one from the list.
SessionEnd hook [node "${CLAUDE_PLUGIN_ROOT}/hooks/session-end-cleanup.mjs"] failed: Hook cancelled
```

## 2026-10-22T06:15Z — Clear settled banners without opening the app
- What changed: new pure `askMarks` (server/approval.ts, +1 test) gives every push `sent_at`, `open` (ids of all pending approval/choice cards, omitted above `OPEN_ASKS_MAX` = 30 so the payload stays small) and `ask: true` when the push is about one of them. `notify` (server/push.ts) applies it after the quiet-hours hold, so a held push released later carries the list as of sending.
- web/public/sw.js stores `ask`/`sent_at` on the notification, and after showing each push closes earlier ask banners whose card is not in `open`. Banners newer than the push (out-of-order delivery) and banners from before this change (no `ask`) are left alone. README line updated.
- Not changed: no push is ever sent only to clear a banner (iOS silent-push rule), so a stale banner lasts until the next real push or until the app opens (iteration 30's path). Not tried on a real phone; `getNotifications()` in an iOS service worker is unverified, and a failure there is caught after the notification is already shown.
- Why it matters against Claude Duet: "goes quiet until something genuinely needs you". A decision made on the desktop should stop showing as waiting on the phone.
- Verified: typecheck pass · test 93 pass / 0 fail · build pass

## 2026-10-22T02:05:14Z — loop iteration 31
- exit=0 gate=green committed=True files=7
- gate: typecheck: exit 0
- answer:
```
nnectors
DONE: Clear settled banners without opening the app
- **What changed:** every push now lists the approvals and questions still waiting, so the phone can take down a stale "Needs your OK" banner even when the app isn't open. A new `askMarks` in `server/approval.ts` adds three things: `sent_at`; `open`, the ids of every pending approval or question (left off above 30, so the push stays small); and `ask: true` when the push itself is about one of them. `notify` in `server/push.ts` adds them at the moment the push is sent, so a push held through quiet hours carries an up-to-date list.
- **Service worker:** `web/public/sw.js` first shows the push as before. Then it closes earlier ask banners whose card isn't in `open`. It leaves alone banners newer than the push, banners from before this change, and everything when `open` is missing.
- **Limit:** no push is ever sent just to clear a banner, because iOS revokes subscriptions that push silently. So a stale banner stays until the next real push arrives or the app opens. I haven't tried this on a real phone, and I couldn't confirm that iOS lets the service worker list its notifications. If it fails there, the error is caught after the new notification is already showing.
- **Also:** 1 new test in `server/approval.test.ts`, a README line, the backlog item ticked, and a journal entry.
- typecheck: `tsc -p tsconfig.json --noEmit` → exit 0
- test: `93 pass, 0 fail, 321 expect() calls` → exit 0
- build: `✓ built in 168ms` → exit 0
```

## 2026-10-22T06:20Z — The brief's page line doesn't open the page
- What changed: the backlog had no open, unblocked items, so this iteration audited the standing-page path and added this item. The brief already names each page's one change, but as plain text with no way to reach the page from it. `post_brief` entries and watching lines now take an optional `page_id` (server/tools.ts). The pure `briefCard` (server/brief.ts, +1 test) resolves it through a `pageFile` lookup to the page's current `file_id`, stores that on the line (shared/types.ts), keeps it when an overflow decision moves to Watching, and lists unknown ids in `unlinked`, which server/runner.ts puts in the tool result.
- CardView renders "Open page" under the line, which opens the viewer. It shows nothing if the file is gone. `briefPrompt` (server/prompts.ts) tells the model to pass the page's id, which `pageBriefLine` already prints. README line updated.
- Why it matters against Claude Duet: "one page I can check every morning … calls out the one thing that changed". The callout should be one tap from the page itself.
- Verified: typecheck pass · test 94 pass / 0 fail · build pass

## 2026-10-22T02:07:52Z — loop iteration 32
- exit=0 gate=green committed=True files=11
- gate: typecheck: exit 0
- answer:
```
ecedence over your claude.ai login · Unset it to load your organization's connectors
DONE: The brief's page line doesn't open the page
- **What was wrong:** nothing in the backlog was open and unblocked, so I picked this gap myself. The morning brief names each standing page's one change, but only as plain text. To see the page you had to leave the brief and go to Make.
- **Fix:** brief decisions and watching lines can now take an optional `page_id`. `briefCard` in `server/brief.ts` turns it into the page's current file and saves that on the line, so the link still works after the page is stopped. If a decision gets bumped to Watching, it keeps its link. Unknown page ids are left without a link, and the agent is told about them (`server/runner.ts`).
- **On the card:** `CardView.tsx` shows "Open page" under the line, and tapping it opens the file. The tool description (`server/tools.ts`), the brief prompt (`server/prompts.ts`), `shared/types.ts`, `styles.css` and the README are updated. There is 1 new test in `server/brief.test.ts`, and the backlog and journal have their entries.
- **Limit:** the link only appears if the agent passes the page id. Not tried with a real model or on a phone.
- typecheck: `tsc -p tsconfig.json --noEmit` → exit 0
- test: `94 pass, 0 fail, 325 expect() calls` → exit 0
- build: `✓ built in 572ms` → exit 0

> CORRECTION: there was no unchecked, unblocked item for this iteration, so I found and added this one myself instead of taking one from the list.
```

## 2026-10-22T06:25Z — Skipped brief decisions come back
- What changed: the backlog had no open, unblocked items, so this iteration audited the brief path and added this item. Brief decisions could be acted on but not dismissed, so one the user didn't care about came back in the day's check-ins and the next brief. New pure `skipEntry` (server/brief.ts) sets or clears `skipped_at` (shared/types.ts) on the stored entry. `actOnCard` handles `skip`/`unskip` with no agent turn (server/runner.ts). `useDraft`/`useAction` refuse a skipped entry.
- `raisedToday` labels skipped decisions for check-ins. The new pure `skippedLately` lists decisions skipped in briefs from the last `SKIP_MEMORY_DAYS` (7), judging each title by its newest brief. `runBrief` passes that list to `briefPrompt` (server/prompts.ts), which says not to raise those again unless something material changed. CardView adds "Skip" next to the chip, and a skipped entry shows struck through with "Undo" (styles.css). README updated. +6 tests.
- Why it matters against Claude Duet: "judgment about what needs you". When the user says something doesn't need them, it should stop coming back.
- Verified: typecheck pass · test 100 pass / 0 fail · build pass

## 2026-10-22T02:11:08Z — loop iteration 33
- exit=0 gate=green committed=True files=10
- gate: typecheck: exit 0
- answer:
```


> CORRECTION: there was no unchecked, unblocked item for this iteration, so I found and added this one myself instead of taking one from the list.

- **What was wrong:** you could act on a brief decision but not dismiss it. Nothing recorded that you didn't care about it, so the same day's check-ins and the next morning's brief raised it again.
- **Fix:** each decision you haven't acted on now has a "Skip" link, with Undo. Skipping only marks `skipped_at` on the stored entry (new `skipEntry` in `server/brief.ts`, `shared/types.ts`); it doesn't start an agent turn. `server/runner.ts` handles the `skip`/`unskip` actions. A skipped entry's chip is refused until you undo the skip.
- **What the agent is told:** check-ins see the decision labelled as skipped (`raisedToday`). The morning brief gets the decisions skipped in the last 7 days (new `skippedLately`, wired in `runner.ts` and `server/prompts.ts`) and is told not to raise them again unless something material changed. This is an instruction to the model, not a guarantee.
- **On the card:** `CardView.tsx` and `styles.css` show a skipped entry struck through, with "Skipped · won't come back unless it changes" and Undo.
- **Also:** README line, 6 new tests in `server/brief.test.ts`, the backlog item added already ticked, and a journal entry. Not tried with a real model or on a phone.
- typecheck: `tsc -p tsconfig.json --noEmit` → exit 0
- test: `100 pass, 0 fail, 342 expect() calls` → exit 0
- build: `✓ built in 106ms` → exit 0
```

## 2026-10-22T06:30Z — Old approvals are acted on as if fresh
- What changed: the backlog had no open, unblocked items, so this iteration audited the approval resume path and added this item. Approving or answering a card resumed the agent with "do exactly what the card described" however old the card was. A draft saying "tomorrow" approved two days later went out as written, and an errand handled in the meantime could run twice.
- New pure `askAge` (shared/age.ts) returns "yesterday at 9:14 PM" once a card crosses local midnight or `OLD_ASK_MS` (6h), otherwise null. `oldAskNote` (server/approval.ts) adds it to `approvalPrompt` and the answer prompt (`decisionPrompt`, server/prompts.ts); for an edited draft the note goes before the user's text, which stays last. The note tells the agent to stop and ask rather than edit anything itself. runner.ts passes the age in the user's timezone. A pending approval or question in CardView shows "Written … · check it still fits" / "Asked …" (styles.css `.card-age`). README updated. +4 tests in server/age.test.ts.
- Why it matters against Claude Duet: "waits for your ok when it matters". An ok given days later must not send something that stopped being true.
- Verified: typecheck pass · test 104 pass / 0 fail · build pass

## 2026-10-22T02:14:24Z — loop iteration 34
- exit=0 gate=green committed=True files=10
- gate: typecheck: exit 0
- answer:
```
nnectors
DONE: Old approvals are acted on as if fresh

> CORRECTION: nothing in the backlog was open and unblocked, so I found this gap myself and added it to the backlog already ticked.

- **What was wrong:** approving or answering a card always told the agent "do exactly what the card described", however old the card was. A draft saying "see you tomorrow" approved two days later went out as written, and something already handled in the meantime could be done twice.
- **Fix:** a new `askAge` in `shared/age.ts` gives something like "yesterday at 9:14 PM" once a card is past local midnight or over 6 hours old. `oldAskNote` in `server/approval.ts` adds that to the message the agent gets after an approval or answer (`server/prompts.ts`, `server/runner.ts`). It tells the agent to check dates and whether it's already done, and to ask again instead of changing the text itself. If the user edited the draft, the note goes before their text, so their text is still the last thing in the message. This is an instruction to the model, not a guarantee.
- **On the card:** a waiting approval now shows "Written yesterday at 9:14 PM · check it still fits", and a question shows "Asked …" (`CardView.tsx`, `styles.css`).
- **Also:** README line, 4 new tests in `server/age.test.ts`, backlog and journal entries. Not tried with a real model or on a phone.
- typecheck: `tsc -p tsconfig.json --noEmit` → exit 0
- test: `104 pass, 0 fail, 358 expect() calls` → exit 0
- build: `✓ built in 108ms` → exit 0
```

## 2026-10-22T06:17Z — Cards settled in chat stay tappable
- What changed: the backlog had no open, unblocked items, so this iteration audited the approval path and added this item. A waiting approval or question the user settled in words, not by tapping, stayed pending in "Needs you" and the brief, and could be tapped later as if fresh.
- New pure `withdrawRefusal` and `waitingNote` (server/approval.ts, +2 tests). A new `withdraw_card` tool (server/tools.ts, runner.ts `executeTool`) expires the agent's own pending card with decision "Withdrawn: <reason>", which CardView already renders as "Expired · Withdrawn: …"; the banner clears through the existing settled-ask paths. `launch` prefixes main-thread chat turns with `waitingNote` (read at launch, not enqueue). Persona and README updated. A yes in chat still needs the card's button, so the approval gate is unchanged.
- Not changed: steered mid-run messages don't get the note (new low-priority backlog item). Not tried with a real model.
- Why it matters against Claude Duet: "goes quiet until something genuinely needs you". A decision already given in chat shouldn't still ask for a tap.
- Verified: typecheck pass · test 106 pass / 0 fail · build pass

## 2026-10-22T02:17:32Z — loop iteration 35
- exit=0 gate=green committed=True files=8
- gate: typecheck: exit 0
- answer:
```
 load your organization's connectors
DONE: Cards settled in chat stay tappable

> CORRECTION: nothing in the backlog was open and unblocked, so I found this gap myself and added it to the backlog already ticked.

- **Problem:** if you answered a waiting approval or question by typing ("no, don't send that", "the second one") instead of tapping, the card stayed open. It stayed in "Needs you" and in the brief, and tapping it days later told the agent to "do exactly what the card described".
- **Fix:** a new `withdraw_card` tool lets the agent close one of its own waiting cards. The card then reads "Expired · Withdrawn: <reason>". It is checked by a new `withdrawRefusal`, which uses the same rules as `replaces`. Each chat message now starts with a short list of that conversation's cards still waiting (new `waitingNote`) and says when to withdraw one. Files: `server/approval.ts`, `server/runner.ts`, `server/tools.ts`, `server/prompts.ts`, `README.md`, plus 2 tests in `server/approval.test.ts`.
- **Approvals unchanged:** saying yes in chat still doesn't approve anything. The agent asks you to tap the card's button.
- **Limit:** a message sent while the agent is mid-turn doesn't get the list yet, so I added that as a low-priority backlog item. This only works if the model follows the instruction, and I haven't tried it with a real model.
- typecheck: `tsc -p tsconfig.json --noEmit` → exit 0
- test: `106 pass, 0 fail, 377 expect() calls` → exit 0
- build: `✓ built in 100ms` → exit 0
```

## 2026-10-22T06:20Z — Steered messages miss the waiting-cards note
- What changed: new pure `turnNote(pending, run)` (server/approval.ts, +1 test) returns `waitingNote` for chat runs and '' for briefs, check-ins and tasks. `launch` uses it in place of its inline check, and `submitUser` now prefixes the text it steers into a live run with `turnNote(items.pendingCards(), active.spec)`, read when the message is sent. If the steer isn't accepted, the queued fallback still sends the raw text, and launch adds a fresh note, so it is never doubled. README line updated.
- Checked first (read-only, ~/.hermes/hermes-agent): `agent.steer` strips the text and delivers it unchanged as its own user row inside Hermes's steer marker (`steer_user_row`), so a prefix reaches the model as written. Two steers in one tool batch are joined with "\n", so each carries its own note. That only costs tokens.
- Discovered: the API server returns a steer that is still undelivered when the turn ends as `pending_steer` for client replay, and Duet ignores it, so that message is lost. Added a backlog item for it, ahead of polish.
- Why it matters against Claude Duet: "goes quiet until something genuinely needs you". A "never mind" typed while the agent is working should take the card down too.
- Verified: typecheck pass · test 107 pass / 0 fail · build pass

## 2026-10-22T02:20:46Z — loop iteration 36
- exit=0 gate=green committed=True files=6
- gate: typecheck: exit 0
- answer:
```
list of cards still waiting. A "never mind, don't send it" sent then could leave the approval up.
- **Fix:** I added a small `turnNote` in `server/approval.ts`. `launch` and `submitUser` in `server/runner.ts` both use it now, so a mid-turn message gets the same list as a new one. If Hermes doesn't accept the mid-turn message, the queued retry still sends the plain text and gets the list when it starts, so it never appears twice. Also 1 new test in `server/approval.test.ts` and a README line. This still only works if the model follows the instruction, and I haven't tried it with a real model.
- **Hermes check:** I read the installed Hermes code without changing it. It passes a mid-turn message to the model unchanged inside its own marker, so the list arrives as written.
- **New backlog item, found along the way:** a message that arrives during the agent's last reply is lost. Hermes hands it back as `pending_steer` when the run ends and expects Duet to resend it, but Duet ignores it. The message shows in the thread and the agent never sees it. I added this ahead of polish in `overnight/BACKLOG.md`.
- typecheck: `tsc -p tsconfig.json --noEmit` → exit 0
- test: `107 pass, 0 fail, 382 expect() calls` → exit 0
- build: `✓ built in 110ms` → exit 0

> CORRECTION: the comment in `submitUser` says Hermes re-queues a late mid-turn message as the next turn. The installed API server doesn't; it returns it as `pending_steer` and leaves resending to Duet. That is the new backlog item above.
```

## 2026-10-22T06:23Z — A message sent as a turn ends is lost
- What changed: new pure `undeliveredSteers` (server/steer.ts, +3 tests in server/steer.test.ts) matches each steer's sent text against Hermes's `pending_steer`, which holds the stripped, "\n"-joined steers the run never delivered. Each steer uses up one occurrence, and steers already queued are skipped. `submitUser` keeps each steer (`sent` with its note, `raw`) on the `ActiveRun`. `onEvent` and the `getRun` fallback record `pending_steer` (server/hermes.ts type). `finish` puts the raw texts at the front of the lane queue as one chat turn, so launch adds a fresh waiting-cards note. A refused steer and a replayed one each mark `queued`, so the message is never sent twice. Corrected the `submitUser` comment, and README line updated.
- Checked first (read-only): `terminal_run_status` in api_server_runs.py adds `pending_steer` to every terminal event and status, and `_handle_steer_run` strips the text before `agent.steer`.
- Limit: steers sent before a Duet restart aren't kept, so one returned undelivered after recovery can't be matched. Not tried against a live Hermes.
- Why it matters against Claude Duet: "one thread". A message the user sees in the thread has to reach the agent.
- Verified: typecheck pass · test 110 pass / 0 fail · build pass

## 2026-10-22T02:23:48Z — loop iteration 37
- exit=0 gate=green committed=True files=7
- gate: typecheck: exit 0
- answer:
```
cause ANTHROPIC_API_KEY or another auth source is set and takes precedence over your claude.ai login · Unset it to load your organization's connectors
DONE: A message sent as a turn ends is lost
- **Problem:** a message sent while the agent was on its final model call never reached the agent, even though it showed in the thread. Hermes hands it back as `pending_steer` when the run ends, and Duet ignored it. I read the installed Hermes code without changing it to confirm this.
- **Fix:** each mid-turn message is now kept on the run as two texts: what was sent (with the waiting-cards list in front) and what the user typed. When the run ends, a new `undeliveredSteers` in `server/steer.ts` works out which messages are in `pending_steer`. Those go out first, as one chat turn, using what the user typed, so the next turn adds a fresh waiting-cards list. A message is never sent twice, whether Hermes refused it or handed it back.
- **Files:** `server/runner.ts` (`submitUser`, `onEvent`, the status fallback in `consume`, `finish`; also corrected the `submitUser` comment), the `getRun` type in `server/hermes.ts`, `README.md`, and 3 new tests in `server/steer.test.ts`. Backlog item ticked and journal entry added.
- **Limit:** a message sent before Duet itself restarts can't be matched after recovery. I haven't tried this against a live Hermes.
- typecheck: `tsc -p tsconfig.json --noEmit` → exit 0
- test: `110 pass, 0 fail, 388 expect() calls` → exit 0
- build: `✓ built in 121ms` → exit 0
```

## 2026-10-22T06:27Z — A failed reply is silent
- What changed: the backlog had no open, unblocked items, so this iteration audited `finish` and added this item. A chat or decision turn that errored (model error, run timeout) left only a grey note, with no push and nothing to tap. Now `finish` (server/runner.ts) posts a pending "Try “…” again?" resume card and pushes "Couldn't finish". Quiet hours hold that push like any other card's.
- New pure helpers in server/recovery.ts (+4 tests): `failedTurnBody` gives the reason and the last step that finished; `retryTitle` stops a second failure nesting "Answered: Try …"; `movedOn` picks the main thread's pending resume cards, which `submitUser` expires ("You carried on in chat"). `actOnCard` treats a resume card's first option as the go-ahead, so both "Pick it up" and "Try again" work. `decisionPrompt` passes a resume card's body to the agent (server/prompts.ts). README updated.
- Limit: "Try again" resumes the same Hermes session and relies on its history holding the failed turn. Not tried against a live Hermes.
- Why it matters against Claude Duet: "goes quiet until something genuinely needs you". An errand that didn't happen does need you, and should be one tap to retry.
- Verified: typecheck pass · test 114 pass / 0 fail · build pass

## 2026-10-22T02:27:36Z — loop iteration 38
- exit=0 gate=green committed=True files=7
- gate: typecheck: exit 0
- answer:
```
rganization's connectors
DONE: A failed reply is silent

> CORRECTION: nothing in the backlog was open and unblocked, so I found this gap myself and added it to the backlog already ticked.

- **Problem:** if a chat turn or a post-approval turn errored (model error, or the 45-minute run timeout), all you got was a grey "Something went wrong" note. There was no push, even though a reply that does come pushes, and nothing to tap. If you sent an errand and walked away, you never learned it didn't happen.
- **Fix:** `finish` in `server/runner.ts` now posts a "Try “…” again?" card and pushes "Couldn't finish". Quiet hours hold that push like any card's. The card says why it stopped and what last finished (`failedTurnBody` in `server/recovery.ts`). "Try again" resumes the same conversation, and the agent gets the card's text (`server/prompts.ts`).
- **Sending a new message instead** expires these cards (`movedOn`), so they don't stay in "Needs you". This also applies to the existing "Pick it back up?" cards in the main thread. If a retry fails again, its title names the original work (`retryTitle`).
- **Also:** README line, 4 new tests in `server/recovery.test.ts`, backlog item and journal entry.
- **Limit:** "Try again" depends on Hermes keeping the failed turn in the conversation's history. Not tried against a live Hermes or on a phone.
- typecheck: `tsc -p tsconfig.json --noEmit` → exit 0
- test: `114 pass, 0 fail, 397 expect() calls` → exit 0
- build: `✓ built in 2.71s` → exit 0
```

## 2026-10-22T06:32Z — A hung run holds the thread forever
- What changed: the backlog had no open, unblocked items, so this iteration audited `consume`. Its run deadline was only checked after the event stream dropped, but Hermes keeps that stream open with a keepalive every 10s until the run ends (checked read-only in `api_server_runs.py`; the API-server path has no inactivity timeout of its own), so a wedged run never timed out. Now a 60s watchdog in `consume` (server/runner.ts) stops a run with no event for `DUET_RUN_TIMEOUT_MS` and ends it as `TIMED_OUT`, which already gives the "Try … again?" card, the failed handover with Try again, or the brief's "Run it now". `onEvent` stamps `lastEventAt`.
- New pure `runHung` (server/recovery.ts, +3 tests): judged on silence, not total time (like Hermes's own gateway inactivity timeout), so a long task that keeps reporting steps is not cut off; a run paused on its own Hermes approval/question is never hung, and its clock restarts after the user answers. Card text now says "went N minutes without any progress". Config comment and README updated.
- Changed behaviour: the old deadline was total time since start (when it fired at all); a run that keeps emitting events now has no Duet-side cap, relying on Hermes's iteration limit. Not tried against a live Hermes.
- Why it matters against Claude Duet: "large tasks run in the background and come back". A stuck one has to come back as a failure, not hold the thread forever.
- Verified: typecheck pass · test 117 pass / 0 fail · build pass

## 2026-10-22T02:32:26Z — loop iteration 39
- exit=0 gate=green committed=True files=7
- gate: typecheck: exit 0
- answer:
```
 and added it to the backlog already ticked.

- **Problem:** Hermes keeps a run's event stream open, sending a keepalive every 10s until the run ends. I confirmed this by reading the installed `_handle_run_events` in `api_server_runs.py` without changing it. Duet only checked its 45-minute timeout after the stream dropped, so a stuck tool or model call was never stopped. It blocked the chat thread (new messages went into the dead run and no "Try again" card ever appeared) or held one of the two background task slots for good.
- **Fix:** in `server/runner.ts`, `consume` now checks every 60s and stops a run that has sent no event for `DUET_RUN_TIMEOUT_MS`. It then ends the same way a timeout already did (the "Try … again?" card, the failed task card with Try again, or the brief's "Run it now"). `onEvent` records when each event arrives. The rule is a new `runHung` function in `server/recovery.ts` with 3 tests. It only counts time with no events, never total time, and it never stops a run that is waiting on you to answer a Hermes approval or question.
- **Behaviour change:** a run that keeps sending events no longer has any time limit in Duet; it relies on Hermes's own iteration limit. The card now reads "went N minutes without any progress". The README and the comment in `server/config.ts` are updated. Not tried against a live Hermes.
- typecheck: `tsc -p tsconfig.json --noEmit` → exit 0
- test: `117 pass, 0 fail, 401 expect() calls` → exit 0
- build: `✓ built in 78ms` → exit 0
```

## 2026-10-22T06:38Z — A queued brief reports a stale world
- What changed: the backlog had no open, unblocked items, so this iteration audited how briefs and check-ins start. `runBrief` built the prompt at enqueue, but the brief waits in the main lane behind any running chat turn or a Hermes outage, so its "already waiting" list, tasks and page lines could be stale by launch (a card approved meanwhile listed as waiting and re-raised; "refresh still running" after it finished). Now both queue with `input: ''` and `launch` (server/runner.ts) fills it from new `briefInput()` / `checkinInput(since)`; `RunSpec.since` carries the check-in's "since" label. A re-queued spec (transient start failure, unknown_execution retry) is rebuilt on its next launch; old persisted queue entries are simply rebuilt too.
- No new test: the change is wiring in runner.ts, which has no harness; the prompt builders it calls are unchanged. Not tried against a live Hermes.
- Discovered: after an outage the brief still launches in the same pass as the page refreshes queued before it (new backlog item).
- Why it matters against Claude Duet: "judgment about what needs you". The brief has to rank what's true when you read it, not what was true before your last chat.
- Verified: typecheck pass · test 117 pass / 0 fail · build pass

## 2026-10-22T02:34:52Z — loop iteration 40
- exit=0 gate=green committed=True files=3
- gate: typecheck: exit 0
- answer:
```
load your organization's connectors
DONE: A queued brief reports a stale world

> CORRECTION: the backlog had no open, unblocked items, so I found this gap myself and added it to the backlog already ticked.

- **Problem:** the morning brief's prompt was built when the brief was queued, but the brief waits behind any chat turn already running, or behind a Hermes outage. A card you approved while it waited was still listed as waiting and could be raised again, and a standing page could still read "refresh is still running" after it had finished. A check-in queued during an outage had the same problem.
- **Fix:** briefs and check-ins now queue with no prompt. `launch` builds it when the run actually starts, using the new `briefInput()` and `checkinInput(since)`. A new `RunSpec.since` field keeps the check-in's "anything new since …" time. A brief or check-in that gets re-queued after a failed start is rebuilt the next time it starts. The only file changed is `server/runner.ts`, plus the backlog and journal.
- **No new test:** this is wiring inside `runner.ts`, which has no test harness, and the prompt builders it calls are unchanged. I haven't tried it against a live Hermes.
- **New backlog item:** after a Hermes outage, the brief still starts at the same moment as the page refreshes queued before it, so it says they're still running.
- typecheck: `tsc -p tsconfig.json --noEmit` → exit 0
- test: `117 pass, 0 fail, 401 expect() calls` → exit 0
- build: `✓ built in 102ms` → exit 0
```

## 2026-10-22T06:37Z — After a Hermes outage the brief starts before the page refreshes
- What changed: new pure `briefWait(refreshing, backAt, now)` (server/pages.ts, +1 test) gives the ms a queued scheduled brief should still wait: only while a page refresh is queued or running, and only until `BRIEF_HOLD_MIN` after Hermes came back from `down` (outside that window the scheduler already held it, so no second wait). `setHermesStatus` stamps `hermesBackAt` on down→ok; `pumpAll` (server/runner.ts) skips a held brief in the main lane while chat queued behind it still launches, and one timer pumps again when the wait runs out; a finished refresh pumps through `finish()` as before.
- `RunSpec.scheduled` marks briefs the scheduler queued; "Run it now" never waits, and tapping it while a scheduled brief is held clears that flag so it goes at once. README line updated.
- Limit: a Duet restart forgets `hermesBackAt` (the startup unknown→ok doesn't count as coming back), and specs persisted before this change have no `scheduled` flag, so they never wait. Not tried against a live Hermes.
- Why it matters against Claude Duet: the standing page "refreshes on a schedule before the brief", so the brief should report its change, not "still running".
- Verified: typecheck pass · test 118 pass / 0 fail · build pass

## 2026-10-22T02:37:19Z — loop iteration 41
- exit=0 gate=green committed=True files=6
- gate: typecheck: exit 0
- answer:
```
fore the page refreshes
- **Problem:** if the scheduler queued the brief while Hermes was down, it started the moment Hermes came back, alongside the page refreshes queued before it. So it reported "today's refresh is still running".
- **Fix:** a new rule, `briefWait` in `server/pages.ts`, with 1 new test in `server/pages.test.ts`. A scheduled brief waits while any page refresh is queued or running, for at most `BRIEF_HOLD_MIN` (30 minutes) after Hermes comes back. At any other time the scheduler has already held the brief once, so it doesn't wait a second time.
- **Wiring in `server/runner.ts`:** `setHermesStatus` records when Hermes comes back. `pumpAll` leaves a held brief in the queue, but chat messages queued behind it still go out. A timer checks again when the 30 minutes run out, and a finished refresh triggers the same check through `finish()`.
- **"Run it now" never waits:** the new `RunSpec.scheduled` flag marks briefs the scheduler queued. Tapping "Run it now" while a scheduled brief is waiting clears the flag, so that brief starts at once.
- **Limits:** if Duet itself restarts, it forgets when Hermes came back. Queue entries saved before this change have no `scheduled` flag, so they never wait. Not tried against a live Hermes.
- README line, backlog tick and journal entry updated. No open, unblocked backlog items remain.
- typecheck: `tsc -p tsconfig.json --noEmit` → exit 0
- test: `118 pass, 0 fail, 407 expect() calls` → exit 0 · build: `✓ built in 97ms` → exit 0
```
