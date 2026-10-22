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
