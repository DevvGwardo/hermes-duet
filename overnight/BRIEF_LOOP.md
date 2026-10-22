# Overnight improvement brief — hermes-duet

You are one iteration of an overnight loop that raises **Hermes Duet** toward the product
Anthropic shipped as Claude Duet. Another iteration will follow you; the loop, not you,
commits, verifies and journals. Work as if you are handing the branch to a careful
engineer who will read the diff cold.

## The product you are improving

`~/hermes-duet` — a proactive phone assistant for a local Hermes agent. Bun + SQLite
server (no framework) serving a React PWA; it drives Hermes through the API server's
background runs, exposes `mcp__duet__*` tools via `server/mcp-shim.ts`, and already has:
one thread, morning brief, check-ins, approval cards, `ask`, `post_card`, `deliver_file`,
`start_task`/`update_task`, `notify`, steering, stop, restart recovery, pairing,
web push, quiet hours.

Read `README.md` in the repo first — it is accurate and describes the real architecture,
the tool surface, and the security model. Then read the code you intend to change.

## The reference: what Claude Duet actually is

From Anthropic's product page (https://claude.com/product/claude-duet):

- **Proactive, not reactive.** It briefs you every morning, drafts the next steps, then
  goes quiet until something genuinely needs you.
- **Judgment about what needs you.** The brief is not a feed: it is a short ranked list of
  decisions, each with the draft already prepared, plus a separate "watching" set that will
  not interrupt you.
- **Large tasks run in the background** and come back as a finished artifact, shared when done.
- **Waits for your ok when it matters** — approvals are one tap, with the full draft in the card.
- **Continuity.** Memory, skills and apps are there from the first message; one thread.
- **"Build me one page I can check every morning."** A standing artifact that refreshes on a
  schedule before the brief, and calls out the one thing that changed.

Judge gaps against that list, not against a generic chat-app feature checklist.

## What is already true (do not regress)

- `bun run typecheck`, `bun test`, `bun run build` all pass today. They must still pass when
  you finish, or your change gets reverted.
- The server binds loopback only; pairing, same-origin checks and the internal bearer token
  exist. Do not weaken any of that.
- `deliver_file` serves HTML with `Content-Security-Policy: sandbox`. Keep it.
- The approval gate is an instruction the model is told to follow — do not present it as a sandbox.

## Hard rules for this iteration

1. Work only in `~/hermes-duet`. Do not touch `~/hermes-duet/data/`, `.env`,
   `context.local.md`, `web/dist/` by hand, or anything outside the repo.
2. **Do not run git commands that change history**: no commit, no push, no branch, no stash,
   no checkout, no reset, no revert. The loop does that. `git diff` / `git status` / `git log`
   are fine.
3. **Do not restart, stop or install the service.** `bin/hermes-duet restart` and
   `launchctl` are out of bounds — the owner is using this app right now.
4. No new dependencies. No network calls added at runtime. No telemetry.
5. One coherent item per iteration. Small enough that a reviewer can hold the whole diff in
   their head; large enough to be worth the commit.
6. Match the existing code: no framework, no state library, no ORM, no CSS framework.
   Comments explain the mechanism, not the obvious.
7. If you find that the backlog item is wrong, already done, or blocked by something the loop
   cannot do safely, say so at the top of your answer, mark it blocked in the backlog with a
   one-line reason, and stop. That is a successful iteration.

## The loop protocol

`overnight/BACKLOG.md` is the shared to-do list, in priority order. Each item is one
checkbox line in this exact shape:

```
- [ ] **<short title>** — <one or two sentences: the user-visible problem, and the shape of the fix> (files: <paths>)
```

Protocol per iteration:

1. Read `overnight/BACKLOG.md` and the tail of `overnight/JOURNAL.md` (your own history —
   do not redo work a previous iteration already finished).
2. Take the **first unchecked, unblocked item**. Do only that item.
3. Implement it properly: server, shared types and web all as needed. Add or extend tests
   where the repo already has them (`server/*.test.ts`, `bun test`).
4. Verify locally: `bun run typecheck`, then `bun test`, then `bun run build`. If a check
   fails and you cannot fix it inside the item's scope, revert your own edits
   (`git checkout -- .` is forbidden — instead re-edit the files back to their committed
   state) and mark the item blocked with the real error.
5. Update `overnight/BACKLOG.md`: tick the box, and append any new items you discovered at
   the right priority (a discovery that blocks the product matters more than polish).
6. Append to `overnight/JOURNAL.md`:

```
## <UTC timestamp> — <item title>
- What changed: <files and mechanism, 2-4 lines>
- Why it matters against Claude Duet: <one line>
- Verified: typecheck <pass/fail> · test <n pass/fail> · build <pass/fail>
```

## Final answer shape (short — the loop parses it)

First line: `DONE: <item title>` or `BLOCKED: <item title> — <reason>`.
Then at most eight lines: what changed and which files, plus the real tail of the three
verification commands with their exit codes. "'Not run' is acceptable; a fabricated pass is not."
If anything in this brief is wrong about the code, put a `> CORRECTION:` line in this answer.