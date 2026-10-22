# Backlog — Claude Duet parity

Priority order. One item per loop iteration: take the first unchecked item, do only it, tick it,
append to `JOURNAL.md`. Add discovered items where they belong; a blocker beats polish.

The first three items are **hypotheses** written by the loop author without reading the code.
Iteration 1 must validate them against the real repo and rewrite anything that is wrong or
already done before implementing.

- [ ] **Audit and rewrite this backlog** — read `server/`, `shared/`, `web/src/` and the tool surface, then replace these hypotheses with the real gaps against Claude Duet, in priority order, keeping the same checkbox shape. Do not implement anything else this iteration. (files: overnight/BACKLOG.md)
- [ ] **Brief = decisions, not a feed** — the morning brief should be a short ranked list of things that need a decision, each with the draft already prepared, plus a separate `Watching` set that never interrupts. Check what `post_brief` actually renders and what the brief prompt asks for, then make the shape enforced rather than hoped for. (files: server/prompts.ts, server/tools.ts, web/src)
- [ ] **Silence when nothing needs you** — a check-in that finds nothing actionable must send nothing at all (no "all clear" message, no push). Verify the path end to end and make it structural, not prompt-dependent. (files: server/scheduler.ts, server/prompts.ts)
- [ ] **Standing artifacts** — "build me one page I can check every morning": a saved artifact with its own refresh schedule that runs *before* the brief, and the brief calls out what changed inside it since yesterday. (files: server/scheduler.ts, server/db.ts, web/src)
- [ ] **Approvals carry the whole draft** — an approval card should show the exact payload that will be sent (message body, amount, file), let the user edit it inline, and resume the turn with the edited version. (files: server/tools.ts, server/mcp-shim.ts, web/src)
- [ ] **Finished tasks hand over cleanly** — when a background task completes, the thread gets the artifact plus a one-line summary and at most three follow-up actions; the Tasks tab shows the same state. (files: server/runner.ts, server/bus.ts, web/src)
- [ ] **Continuity is visible** — from the first message the user can see what the agent already has: context file, skills, connected apps. Surface it in the thread header and in the first-turn prompt. (files: server/hermes.ts, server/prompts.ts, web/src)
- [ ] **Readable agent activity** — tool calls should collapse by default into a one-line trace that expands on tap, so a long run does not bury the answer. (files: web/src)
- [ ] **Push that survives** — verify web push on iOS/desktop: re-subscribe on failure, prune dead subscriptions, respect quiet hours, and never push when the thread is already open in front of the user. (files: server/push.ts, server/bus.ts)
- [ ] **Phone-first interaction** — thumb-reachable primary action, safe-area padding, no layout shift on keyboard open, and an offline state that says what is queued. (files: web/src)
- [ ] **Recovery that reads like a person** — after a gateway restart mid-run, the recovery message should say what was interrupted, what was retried, and offer one tap to resume, instead of explaining internals. (files: server/runner.ts, server/prompts.ts)
- [ ] **One place for what needs you** — a single "Needs you" rail that aggregates open approvals, unanswered questions and brief items with drafts, so nothing waits in a scrolled-away card. (files: web/src, server/db.ts)