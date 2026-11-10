# Claude Duet vs. Hermes Duet — feature parity research

Research date: **2026-11-09**. Claude Duet is a US-only research preview that changes quickly; this is a snapshot,
not a permanent spec. Sources are listed at the bottom.

The short version: Hermes Duet is already **ahead** on local-machine access, live-browser takeover, event triggers,
editable approval drafts, search over deliverables, standing pages, model choice, and self-hosting. It is **behind**
on the trust layer around approvals, the task/channel model, source citations, user-defined routines, connector
breadth, and always-on availability.

---

## 1. What Claude Duet actually is

Anthropic's official description:

- A standalone app for iOS, Android and `claude.ai`; a research preview on Pro, Max and Ultra plans in the US.
- One main thread for text or voice, plus **channels** for separate topics that share memory.
- A **morning brief** across connected email and calendar, with prepared next steps.
- Background checks every few hours, with notifications only when something needs the user.
- Larger jobs run on its own cloud computer and return editable files in a **Make** tab.
- A **Tasks** tab with a page per task; the user can steer a task mid-run.
- **Approvals before** sending, paying, signing or deleting. A separate classifier checks the action against intent.
- A separate **sensitive-information classifier** checks outgoing messages.
- Credentials, cookies and sign-in tokens stay outside the model; the browser runs in its own cloud VM.
- **Link by Stripe** and **Shop Pay** purchases use a one-time card scoped to the merchant and amount.
- On 2026-11-06 it added **Claude Code sessions**: check, approve and steer sessions on the user's computer or in
  the cloud from the phone. (Secondary source; see sources.)

Two independent reviews add UI-level details not in the help-center article: **groups of channels**, **per-channel
standing instructions**, and the ability to ask one "Everything" channel to sort work into the right channel. Treat
those as observed preview behavior, not documented guarantees.

---

## 2. Scorecard

Legend: **Ahead** = Hermes Duet does more; **Parity** = broadly equivalent; **Partial** = same idea but a material
piece is missing; **Missing** = no equivalent; **N/A** = different product boundary.

### Conversation and task model

| Capability | Claude Duet | Hermes Duet | Status |
|---|---|---|---|
| One persistent main thread | Yes | General channel / main lane | Parity |
| Topic channels with shared memory | Yes | Channels with own Hermes session; shared Agent memory scope | Partial — no shared-memory UI, and channel runs are second-class in the app (see §4.1) |
| Groups of channels | Reported by reviewers | None | Missing |
| Per-channel standing instructions | Reported by reviewers | Only `topic`, injected as one line in `channelLine()` | Missing |
| Automatic sorting of work into channels | Reported by reviewers | A task inherits the channel it started in; no routing from general | Missing |
| Task list with a page per task | Yes | Tasks tab with expandable rows | Partial — no dedicated task page |
| Steer a running task | Yes | `hermes.steer` exists, but only for the chat/channel lane; no UI or route for a task lane | Missing |
| User marks a task complete | Yes; agent may suggest, only user confirms | Agent sets `done`; user can cancel or retry, not confirm | Missing |
| Handover with result, files, follow-ups | Files in Make; task page | Handover card, retries, follow-ups | Ahead |
| Task history | Task list | 60 tasks / 7 days loaded (`tasks.recent`) | Partial |

### Proactivity

| Capability | Claude Duet | Hermes Duet | Status |
|---|---|---|---|
| Morning brief with prepared drafts | Yes | Yes; decisions, drafts, Watching, Skip | Parity / Ahead |
| Checks through the day | Every few hours, configurable | Check-ins off / 3× daily / hourly | Partial — no arbitrary cadence |
| User controls what to hear and how often | Yes | Global brief on/off/time; check-ins level; quiet hours | Partial — no per-category or per-channel preferences |
| Follow up on threads that went quiet | Yes | No outbound-thread tracking | Missing |
| User-defined recurring routines | Routines/scheduled tasks reported and implied | Only fixed check-ins and standing pages | Missing |
| Event-driven triggers | Interval checks; no webhook/folder documented | Webhooks, watched folder, meeting proximity | Ahead |
| Quiet hours / held pushes | Not documented | Quiet hours, held "While you were away" | Ahead |

### Deliverables and knowledge

| Capability | Claude Duet | Hermes Duet | Status |
|---|---|---|---|
| Make tab for finished work | Yes | Yes | Parity |
| Editable result files | Yes ("files you can review and edit") | Viewer is read-only; agent must rebuild | Missing |
| Source citation for numbers/summaries | Yes, names the email/file/sheet | No structured source field | Missing |
| Standing artifacts rebuilt on schedule | Implied via routines | Standing pages, compare slider, brief change line | Ahead |
| Interactive deliverables | Not documented | `window.Duet` bridge to actions/approvals | Ahead |
| Search your past chats | Yes, Duet + Claude chats outside projects | FTS over Duet items, tasks, files, pages | Partial — own history only; card subfields not indexed |
| Memory visible/resettable in app | Yes | "What I can see" is read-only; no reset | Partial |
| Skills/connectors from day one | Yes, inherited from Claude account | Hermes skills/MCP are shown; no install UI | Partial |

### Trust and safety

| Capability | Claude Duet | Hermes Duet | Status |
|---|---|---|---|
| Approval before send/pay/sign/delete | Yes | Designed in; prompt-enforced | Partial — see §4.2 |
| Approval shows action, destination, content, every recipient | Yes | Free-form title/summary plus optional draft | Partial |
| Independent check that action matches intent | Yes, classifier outside the model | None | Missing |
| Sensitive-information classifier on outbound messages | Yes, with "never share" and "needs consent" tiers | None | Missing |
| Blocked actions even with approval | Securities, bank transfers, other people's accounts | No policy engine | Missing |
| "Don't ask again" with hard exceptions | Yes for some actions; never for money/send/delete/create-account | Every action gets a new card | Missing |
| Credentials never reach the model or agent machine | Yes, encrypted single-use path / proxy | Vault CLI returns credentials to the Duet server; agent shares the machine and shell | Partial |
| Browser isolated from agent and user data | Dedicated cloud VM; fixed command surface | Local Chrome, separate profile, full CDP available to the agent | Partial |
| Agent identifies itself to websites | Distinct User-Agent and published IPs | Normal Chrome | Missing |
| Pairing / loopback / sandboxed deliverables | Account auth + cloud isolation | Pairing cookie, loopback internal API, sandbox CSP | Ahead for a local install |

### Payments

| Capability | Claude Duet | Hermes Duet | Status |
|---|---|---|---|
| Itemized approval with hard cap | Yes | Yes, items must add up; `DUET_MAX_TRANSACTION_LIMIT` | Ahead |
| Single-use card | Yes | Privacy / Stripe Issuing / Revolut / generic | Parity |
| Card scoped to **merchant and amount** | Yes | Amount cap only; card is typed into whatever tab is active | Partial — see §4.2 |
| Wallet app approves the spend | Link / Shop Pay | No wallet approval; approval is the card | Partial |
| Recurring payments | Link cannot | Provider-dependent | N/A |

### Platform and reach

| Capability | Claude Duet | Hermes Duet | Status |
|---|---|---|---|
| Works while phone/laptop is off | Cloud VM | Mac must be awake (Docker/Linux supported) | Missing (structural) |
| Live browser viewing/takeover | Explicitly not available | Yes, CDP stream + trusted input | Ahead |
| Access to local files and apps | No | Yes | Ahead |
| Model choice | No; Opus 5.5 only | `DUET_HERMES_MODEL` | Ahead |
| Multiple computers / Claude Code sessions | Yes, added 2026-11-06 | One Hermes gateway per install | Missing (different ecosystem) |
| Native apps / iPad side by side | iOS, Android, web; iPad reported | Installable PWA; responsive web | Partial |
| Voice notes | Yes | Yes, local whisper.cpp, plus TTS brief | Parity |
| Voice/speed settings | Reported | TTS voice/model via env; no in-app speed | Partial |
| Open source / self-hosted / no waitlist | No | Yes | Ahead |

---

## 3. What Hermes Duet already does better

- **Local machine, not a cloud sandbox.** It can read the user's files, run their CLIs, and use their native
  Calendar/Reminders/Mail bridges. Claude Duet explicitly cannot see local files or run local apps.
- **Live browser.** The globe pane lets the user clear a login or CAPTCHA the agent is stuck on. Claude Duet cannot
  show or hand over its browser.
- **Event-driven, not only interval-driven.** Webhooks, watched folder and meeting proximity are real triggers, not
  just "check every few hours".
- **Approval drafts are editable on the card.** Claude Duet shows content for approval, but Hermes Duet lets the user
  fix a typo and sends their exact text.
- **Search includes deliverables.** Tasks, files and standing pages are in the same FTS index; Claude Duet's search
  is chat-focused.
- **Standing pages with a visual diff.** A rebuilt page can be compared against yesterday's version.
- **Deliberate quietness.** Quiet hours, held pushes, "While you were away", and no push while the app is visible are
  more developed than the public Duet documentation shows.
- **No model lock-in and no waitlist.** A local install can use any Hermes model/profile.

Do not copy the parts that are cloud-only tradeoffs: model lock-in, no local files, no browser visibility.

---

## 4. Missing or materially partial features, in priority order

### 4.1 Security: the approval gate is still model-mediated

**Duet:** a separate classifier runs outside the model to judge whether the action matches the request, and a
separate classifier checks outgoing content for sensitive information. Credentials and the browser live outside the
agent's machine.

**Hermes Duet:** `request_approval` is a tool the model is told to call. The card shows a title/summary and an
optional draft, but there is no independent check, no structured destination/recipient, no sensitive-data scan, and
no policy that refuses categories such as bank transfers or securities. The README already says approvals are an
instruction, not a sandbox; this is the largest trust gap versus Duet.

Concrete, tractable pieces:

1. **Structured approval fields.** Add `action` (`send_email`, `send_message`, `post`, `delete`, `sign`, `pay`),
   `destination`, `recipients[]`, `content`, `url` to `request_approval`. Render them as distinct fields on the card,
   not buried in Markdown; require recipients for send actions.
2. **Outbound scan before approval.** Scan `draft`, `content`, `summary` and `notify` bodies for card numbers, bank
   numbers, government IDs, private keys, and configured secret patterns. Refuse to approve a "never share" match and
   require a fresh card after redaction. A model-based classifier can be optional; the deterministic scan is the
   floor.
3. **Action-intent check.** For payments, compare the requested merchant/amount/URL with the card and the active
   browser host. For sends, require the destination and recipients to be present and unchanged at approval time.
4. **Policy engine.** A small deny/allow list per tool and per run kind, with hard blocks for money movement,
   securities, account access, and destructive actions. Surface it in Settings so the user can see what is always
   refused.
5. **Don't rely on the prompt alone.** Recommend/enable Hermes `approvals.mode` for hard enforcement; its prompts
   already map to Duet cards. Consider a Duet-side "execute approved action" path for common connectors so the action,
   not just the card, is controlled by Duet.

Files: `server/tools.ts` (schema), `server/approval.ts` (validation/prompt), `server/runner.ts` (tool dispatch),
`web/src/components/CardView.tsx`, `README.md`.

### 4.2 Payments: the card is not bound to the merchant or the page

**Duet:** one-time card scoped to the merchant and amount; the user approves the spend in Link/Shop Pay; the real
card number is never shared.

**Hermes Duet:** `request_payment` validates the receipt total and cap, and `browser.fillCard()` types the issued
card into whichever tab is active. There is no merchant URL/host on the card and no host check before filling. A
prompt-injected agent could navigate the live browser to another site and have the approved card number typed there.
The card is single-use and time-limited, but this is still a direct theft path.

Tractable fix:

- Add `merchant_url` (or `merchant_host`) to `request_payment`; show the host on the payment card.
- Pass the expected host into `browser.fillCard`; re-read `currentHost()` immediately before typing and refuse unless
  it matches the merchant host (reuse the `sameLoginSite` rule or an exact/suffix rule). This mirrors the existing
  `fillLogin` protection.
- If the provider supports a merchant lock (Privacy/Stripe controls, depending on plan), set it; otherwise treat the
  host check as mandatory.
- Persist the merchant host and fill result on the card, never the number.

Files: `server/payments.ts`, `server/browser.ts`, `server/runner.ts`, `web/src/components/CardView.tsx`,
`server/tools.ts`.

### 4.3 Channel and task model is thinner than Duet's

**Duet:** channels can be grouped, each channel has its own standing instructions, and the "Everything" channel can
sort work into the right channel. Tasks have their own page and can be steered mid-run; only the user marks a task
complete.

**Hermes Duet:** channels have a name/topic/session only. A task inherits its starting channel. Tasks are rows in a
tab; there is no task page, no user "complete" action, and no way to send a message *to a running task* even though
the runner already supports Hermes steering for chat.

Concrete pieces:

- `groups` table (or `group` string on `channels`) and a grouped channel strip/sheet.
- `channels.instructions` field, edited in the channel sheet, injected into `persona()`/`channelLine()` before the
  topic line.
- `POST /api/tasks/:id/message` → `runner.steerTask()`; `hermes.steer` on the task lane, with the same
  `pending_steer` replay as chat. Add a task detail sheet with progress, steps, files and an input.
- `POST /api/tasks/:id/complete` and `Task.confirmed_at`; the agent's `done` remains "looks done", the user's tap is
  the real completion. Show that distinction in Tasks.
- Optional: an `assign_channel` tool (or a routing instruction in the general persona) so general-channel work can be
  filed into a topic channel.

Files: `server/schema.ts`, `server/db.ts`, `server/channels.ts`, `server/prompts.ts`, `server/runner.ts`,
`server/index.ts`, `shared/types.ts`, `web/src/components/Channels.tsx`, `web/src/components/TasksView.tsx`,
`web/src/api.ts`.

### 4.4 Source citations

**Duet:** "When it gives you a number or a summary, it tells you which email, file, or spreadsheet it came from."
This is a trust feature, not decoration.

**Hermes Duet:** brief entries and cards have title/detail/draft, but no structured source. The model can mention a
source in prose, and nothing validates or links it.

Add `sources` to `BriefEntry`, `CardData` and task results: `{ kind: 'item'|'file'|'page'|'url'|'connector', id?,
url?, label, quote? }`. Render them as links/chips; validate that item/file/page ids exist; teach the prompt to cite
a source for every number or claim. This also makes the existing FTS and Make tab more useful.

Files: `shared/types.ts`, `server/brief.ts`, `server/tools.ts`, `server/prompts.ts`,
`web/src/components/CardView.tsx`, `web/src/styles.css`.

### 4.5 User-defined recurring routines

**Duet:** routines/scheduled tasks are a core part of the proactive loop; users create them in plain language.

**Hermes Duet:** the scheduler has fixed slots: one brief, check-ins, page refreshes, meeting proximity, folder and
webhook triggers. There is no user-created "every Monday 9am, summarize last week's messages" routine, and no UI to
pause/resume/run one.

Add a `routines` table: `id, title, prompt, channel_id, schedule (cron or interval), enabled, last_run, last_result,
next_run`. Reuse `startTask`/`submitSystem` with a run kind `routine`; add a Settings/Tasks section to create, pause,
resume, run now and delete. Reuse the quiet-hours and budget rules. This is one of the highest-leverage parity gaps:
it turns the fixed morning/check-in loop into the user's own loop.

Files: `server/schema.ts`, `server/db.ts`, `server/scheduler.ts`, `server/runner.ts`, `server/tools.ts`,
`web/src/components/SettingsSheet.tsx` or a new Routines view.

### 4.6 Notification preferences

**Duet:** users can say what they want to hear about and how often.

**Hermes Duet:** switches are global: brief on/off/time, check-ins off/3×/hourly, quiet hours. There is no per-category
or per-channel preference, and no "only tell me about X" control.

Extend `Settings` with categories and cadence: approvals (always? quiet-hours exception), task done/failed, agent
`notify`, brief, check-ins; per-channel mute; maybe a maximum pushes/day. Apply the filter in `notify()` and in the
brief/check-in prompts. Keep a visible "held" behavior so a muted category is not silently lost.

Files: `shared/types.ts`, `server/db.ts`, `server/push.ts`, `server/runner.ts`, `web/src/components/SettingsSheet.tsx`.

### 4.7 Editable deliverables

**Duet:** files come back "for you to review and edit".

**Hermes Duet:** `Viewer` renders Markdown/text/HTML/PDF but is read-only; a change means asking the agent to rebuild.
The HTML bridge can send actions, but not edit the document.

Add an edit mode for `text/*`, Markdown and CSV: textarea/table edit, save as a new version through
`POST /api/files/:id/versions` (or `PUT /api/files/:id`), with the same filename and `page_id` behavior. For HTML,
keep the sandbox and add a source editor rather than a WYSIWYG. This is a product gap more than a technical one.

Files: `web/src/components/Viewer.tsx`, `server/index.ts`, `server/runner.ts`/`server/db.ts` (version write),
`web/src/api.ts`.

### 4.8 Search and memory

**Duet:** searches past Duet chats and regular Claude chats outside projects; memory can be reviewed/reset.

**Hermes Duet:** FTS covers items, tasks, files and pages, but:
- Card `entries`, `draft`, `watching`, `follow_ups` and payment line items are not in the FTS row (the trigger indexes
  only `card.title` and `card.body`), so a decision or a draft is not searchable.
- There is no memory browser/reset; `context.local.md` is the only editable memory surface.
- No search over the Hermes agent's own conversation history outside Duet (if that is even exposed).

Index card subfields in `items_fts_*` (or in a small card-detail table) and add a `sources`/`memory` view. If Hermes
exposes a memory/search API, wire it; if not, at least make the local FTS complete and let the user edit
`context.local.md` from Settings.

Files: `server/schema.ts`, `server/search.ts`, `server/db.ts`, `web/src/components/SettingsSheet.tsx`.

### 4.9 Always-on availability and multiple machines

**Duet:** runs in the cloud while the phone and laptop are off.

**Hermes Duet:** the Mac must be awake; the README says so. Docker/Linux is supported, but the native connectors are
macOS-only, and there is one Hermes gateway per install.

This is structural. Options:
- Document an always-on Linux mini-PC/NAS/VPS deployment with Tailscale, and move the browser into the container
  (the Dockerfile already bundles Chromium) so it is isolated from the host.
- Support multiple Hermes gateways/profiles as selectable "agents" (e.g. `DUET_HERMES_URL` per profile) and a
  health/latency indicator per agent.
- Wake-on-LAN is not a substitute for a true always-on host; be explicit about that in the README.

Files: docs/deploy, `server/config.ts`, `server/hermes.ts`, possibly a `servers` table.

### 4.10 Connectors, plugins and channel repo binding

**Duet:** inherits 6,000+ connectors/plugins from the Claude account, can suggest plugins, and can attach a GitHub
repo to a channel.

**Hermes Duet:** connectors are the local AppleScript bridges plus MCP servers configured in Hermes; Settings shows
status and test, but there is no discovery, install, suggestion, OAuth flow, or channel-level repo binding. The agent
can use whatever MCP tools Hermes has, which is powerful but invisible to the app.

Start with:
- A read-only "what is connected" list from Hermes `toolsets` + `mcp_servers` (already partly in
  `capabilities.ts`), with a "suggested next connector" section.
- A safe install/update guide rather than an in-app OAuth marketplace.
- A `channels.repo` field and a GitHub connector wrapper, so a channel can carry its own repo.
- Per-channel allowed-tool scopes, which also helps the trust boundary in §4.1.

Files: `server/capabilities.ts`, `server/connectors.ts`, `server/channels.ts`, `web/src/components/SettingsSheet.tsx`.

### 4.11 Native/mobile polish

Duet is a native iOS/Android app; Hermes Duet is an installable PWA. The PWA is a deliberate advantage for
self-hosting, but the gap shows in:
- Push reliability and background execution on iOS.
- iPad side-by-side (reported in Duet).
- Voice/speed settings (TTS is env-only today).
- Swipeable task cards / a dedicated task page.

These are lower priority than the trust and task gaps, but a native wrapper (Capacitor/React Native shell) or better
PWA ergonomics would close the perceived gap. Do not add a native app until the web surface is stable.

---

## 5. Recommended sequence

1. **Payment host binding** (§4.2) — small, concrete, closes a real theft path.
2. **Structured approvals + outbound secret scan + policy deny list** (§4.1) — the largest trust gap.
3. **Task page, task steering, user completion** (§4.3) — the most visible daily-use gap.
4. **Channel instructions + groups + unread state** (§4.3) — closes the conversation-model gap and uses the already
   stored `seen_at` field.
5. **Source citations** (§4.4) — high trust value, moderate effort.
6. **Routines + notification preferences** (§4.5–4.6) — makes proactivity user-controlled rather than fixed.
7. **Editable deliverables + complete FTS** (§4.7–4.8).
8. **Always-on deployment and multi-agent support** (§4.9) — product/docs, not a quick code change.
9. **Connector discovery / channel repo binding** (§4.10).
10. **Native/mobile polish** (§4.11).

Do not copy Duet's model lock-in or cloud-only limitations. Do copy the *shape* of its trust model: structured
approval data, an out-of-model check, and a visible source for every claim.

---

## 6. Sources

Primary (Anthropic):

- [Claude Duet product page](https://claude.com/product/claude-duet)
- [Get started with Claude Duet](https://support.claude.com/en/articles/17631495-get-started-with-claude-duet)
- [Introducing Claude Duet](https://claude.com/resources/articles/claude-duet) (2026-10-21)
- [Claude Duet Safety, Privacy, and Security](https://claude.com/resources/articles/claude-duet-safety-privacy-and-security)
  (2026-10-23)
- [How to use Link by Stripe with Claude Duet](https://support.claude.com/en/articles/17666484-how-to-use-link-by-stripe-with-claude-duet)
- [How to use Shop Pay with Claude Duet](https://support.claude.com/en/articles/17666489-how-to-use-shop-pay-with-claude-duet)
- [Claude's chat search and memory](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context)

Secondary (reviews and reported preview behavior):

- [I Gave Claude Duet the Same Jobs I Gave Every Other Personal Agent](https://aakashgupta.medium.com/i-gave-claude-duet-the-same-jobs-i-gave-every-other-personal-agent-4680f22722ac)
  — groups, channels, per-channel instructions, "Everything" channel, task cards, limitations.
- [Is Claude Duet Worth the Waitlist?](https://aimaker.substack.com/p/claude-duet-review-and-use-cases) — groups,
  channel rules, task behavior, usage cost, Claude Code session caveats.
- [Claude Duet Can Now Monitor, Approve and Steer Claude Code Sessions From Your Phone](https://automater.ai/news/claude-duet-mobile-control-claude-code-sessions/)
  and David Sutton's 2026-11-06 announcement — Claude Code sessions.
- [Engadget: How to use Claude Duet](https://www.engadget.com/2300253/how-to-use-claude-duet) — cloud VM, browser,
  cadence and usage context.
