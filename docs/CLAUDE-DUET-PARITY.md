# Claude Duet vs. Hermes Duet — feature parity research

Research date: **2026-11-09** (updated after **Parity Pass 1** and **Parity Pass 2**, see [`GAPS.md`](../GAPS.md)). Claude Duet is a US-only research preview that changes quickly; this is a snapshot, not a permanent spec. Sources are listed at the bottom.

The short version: after Parity Pass 1 (`71f25c7`–`7fe8e8b`) and Parity Pass 2 (`5975c79`–`6606434`), Hermes Duet reaches **parity or better** across structured approvals, outbound secret scanning, hard-blocked action policies, merchant-bound payment cards, dedicated task sheets with steering and user confirmation, grouped channels with standing instructions, source citations, user-defined routines, notification preferences, editable deliverables, complete FTS indexing, in-app memory editing, read-only connector suggestions, channel repo binding, and always-on Linux/Docker deployment docs. It remains **behind or deliberately different** on cloud isolation, multi-gateway/multi-machine routing, automatic "Everything" channel triage, outbound-thread follow-up tracking, `"Don't ask again"` exceptions, connector OAuth/install flows, native mobile/iPad apps (§4.11), and in-app TTS speed controls.

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
| Topic channels with shared memory | Yes | Channels with own Hermes session; shared `context.local.md` memory + unread `seen_at` dots | Parity (Pass 1) |
| Groups of channels | Reported by reviewers | `channels.group` with grouped strip and channel sheet (`502f270`) | Parity (Pass 1) |
| Per-channel standing instructions | Reported by reviewers | `channels.instructions` injected before `topic` with safety-override clause (`502f270`) | Parity (Pass 1) |
| Automatic sorting of work into channels | Reported by reviewers | Tasks inherit their starting channel; no auto-routing from General | Missing |
| Task list with a page per task | Yes | Tasks tab opening `TaskSheet` with steps, result, sources, files, and composer (`0b148bc`) | Parity (Pass 1) |
| Steer a running task | Yes | `POST /api/tasks/:id/message` → `steerTask()` via `hermes.steer` + `TaskSheet` composer (`0b148bc`) | Parity (Pass 1) |
| User marks a task complete | Yes; agent may suggest, only user confirms | `Task.agent_done_at` vs `confirmed_at`; `/confirm` and `/reopen` in `TaskSheet` (`0b148bc`) | Parity (Pass 1) |
| Handover with result, files, follow-ups | Files in Make; task page | Handover card, retries, follow-ups | Ahead |
| Task history | Task list | 60 tasks / 7 days loaded (`tasks.recent`) | Partial |

### Proactivity

| Capability | Claude Duet | Hermes Duet | Status |
|---|---|---|---|
| Morning brief with prepared drafts | Yes | Yes; decisions, drafts, Watching, Skip | Parity / Ahead |
| Checks through the day | Every few hours, configurable | Check-ins off / 3× daily / hourly + custom user routines | Parity / Partial — fixed check-in presets; arbitrary schedules via routines |
| User controls what to hear and how often | Yes | `server/notify-prefs.ts`: per-category task pushes, `notify_agent`, per-channel mute, daily cap (`d68aefd`) | Parity (Pass 2) |
| Follow up on threads that went quiet | Yes | No outbound-thread tracking | Missing |
| User-defined recurring routines | Routines/scheduled tasks reported and implied | `routines` table + DST-aware scheduler + `save_routine`/`remove_routine` + Routines sheet (`986ad86`) | Parity (Pass 2) |
| Event-driven triggers | Interval checks; no webhook/folder documented | Webhooks, watched folder, meeting proximity | Ahead |
| Quiet hours / held pushes | Not documented | Quiet hours, held "While you were away" | Ahead |

### Deliverables and knowledge

| Capability | Claude Duet | Hermes Duet | Status |
|---|---|---|---|
| Make tab for finished work | Yes | Yes | Parity |
| Editable result files | Yes ("files you can review and edit") | `POST /api/files/:id/versions`; Viewer edit mode for Markdown/text/CSV/JSON and HTML source with sandbox preview (`1415823`) | Parity (Pass 2) |
| Source citation for numbers/summaries | Yes, names the email/file/sheet | `server/sources.ts` validates real ids & URLs across brief entries, watching, cards, task results (`5a072f6`) | Parity (Pass 1) |
| Standing artifacts rebuilt on schedule | Implied via routines | Standing pages, compare slider, brief change line | Ahead |
| Interactive deliverables | Not documented | `window.Duet` bridge to actions/approvals | Ahead |
| Search your past chats | Yes, Duet + Claude chats outside projects | FTS schema v4 (`searchText` + `taskSearchText`) across all items, card subfields, attachments, URLs, sources, tasks, files, pages (`6606434` + v4) | Partial — Duet history fully indexed; external Hermes chats outside Duet not searched |
| Memory visible/resettable in app | Yes | `GET/PUT/DELETE /api/memory` + Settings > Memory sheet with 32 KB cap (`6606434`) | Parity (Pass 2) |
| Skills/connectors from day one | Yes, inherited from Claude account | Connectors sheet + `GET /api/suggestions` + `Channel.repo`; no install/OAuth marketplace (`d01374c`) | Partial (Pass 2) |

### Trust and safety

| Capability | Claude Duet | Hermes Duet | Status |
|---|---|---|---|
| Approval before send/pay/sign/delete | Yes | Prompt-enforced `request_approval` backed by hard policy blocks and deterministic outbound scan | Partial — execution still runs through Hermes unless via connector |
| Approval shows action, destination, content, every recipient | Yes | Structured `action`, `destination`, `recipients`, `content`, `url` pinned on card & resume prompt (`d346b2a`) | Parity (Pass 1) |
| Independent check that action matches intent | Yes, classifier outside the model | Deterministic field/destination/recipient validation and payment merchant-host matching; no LLM classifier | Partial (Pass 1) |
| Sensitive-information classifier on outbound messages | Yes, with "never share" and "needs consent" tiers | `server/safety.ts`: PAN/SSN/IBAN/PEM/API keys (`never_share` vs `needs_consent`) on approvals and `notify` (`d346b2a`) | Parity (Pass 1) |
| Blocked actions even with approval | Securities, bank transfers, other people's accounts | `HARD_BLOCKS` in `server/safety.ts` + `GET /api/policy` + Settings > Always refused (`d346b2a`) | Parity (Pass 1) |
| "Don't ask again" with hard exceptions | Yes for some actions; never for money/send/delete/create-account | Every sensitive action gets a new card | Missing |
| Credentials never reach the model or agent machine | Yes, encrypted single-use path / proxy | Vault CLI returns credentials to the Duet server; agent shares the machine and shell | Partial |
| Browser isolated from agent and user data | Dedicated cloud VM; fixed command surface | Local/container Chrome, separate profile, CDP bound to container/host | Partial |
| Agent identifies itself to websites | Distinct User-Agent and published IPs | Normal Chrome | Missing |
| Pairing / loopback / sandboxed deliverables | Account auth + cloud isolation | Pairing cookie, loopback internal API, sandbox CSP | Ahead for a local install |

### Payments

| Capability | Claude Duet | Hermes Duet | Status |
|---|---|---|---|
| Itemized approval with hard cap | Yes | Yes, items must add up; `DUET_MAX_TRANSACTION_LIMIT` | Ahead |
| Single-use card | Yes | Privacy / Stripe Issuing / Revolut / generic | Parity |
| Card scoped to **merchant and amount** | Yes | `merchant_url` → derived host checked via `sameOriginSite` & active element before `browser.fillCard` (`71f25c7`) | Parity (Pass 1) — host-checked at fill time; provider lock if supported |
| Wallet app approves the spend | Link / Shop Pay | No wallet approval; approval is the card | Partial |
| Recurring payments | Link cannot | Provider-dependent | N/A |

### Platform and reach

| Capability | Claude Duet | Hermes Duet | Status |
|---|---|---|---|
| Works while phone/laptop is off | Cloud VM | Always-on Linux host / Docker documented (`docs/DEPLOY.md`, `0774238`); local host must stay awake | Partial (Pass 2) |
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
  Calendar/Reminders/Mail bridges on macOS. Claude Duet explicitly cannot see local files or run local apps.
- **Live browser.** The globe pane lets the user clear a login or CAPTCHA the agent is stuck on. Claude Duet cannot
  show or hand over its browser.
- **Event-driven, not only interval-driven.** Webhooks, watched folder and meeting proximity are real triggers, not
  just "check every few hours".
- **Approval drafts are editable on the card.** Claude Duet shows content for approval, but Hermes Duet lets the user
  fix a typo and sends their exact text.
- **Search includes deliverables.** Tasks, files, cards and standing pages are in the same FTS index; Claude Duet's
  search is chat-focused.
- **Standing pages with a visual diff.** A rebuilt page can be compared against yesterday's version.
- **Deliberate quietness.** Quiet hours, held pushes, "While you were away", per-category/channel notification
  preferences, and no push while the app is visible.
- **No model lock-in and no waitlist.** A local install can use any Hermes model/profile.

Do not copy the parts that are cloud-only tradeoffs: model lock-in, no local files, no browser visibility.

---

## 4. Implementation status and remaining gaps

### 4.1 Security: structured approvals, outbound scan, and policy engine (Shipped in Pass 1)

**Shipped (`d346b2a`, `7fe8e8b`):**
- Structured `action`, `destination`, `recipients[]`, `content`, and `url` fields on `request_approval`, rendered
  distinctly on approval cards and pinned into the resume prompt (`server/approval.ts`, `server/tools.ts`,
  `server/tools/dispatch.ts`, `CardView.tsx`).
- Deterministic outbound secret scanner (`server/safety.ts`) checking `never_share` (Luhn card numbers, SSNs, PEM
  keys, AWS/GitHub/API tokens) and `needs_consent` (IBANs) across approvals and `notify`.
- Five hard-blocked categories (`HARD_BLOCKS`: bank/wire, securities/crypto, other people's accounts, password/2FA
  changes, account creation) exposed at `GET /api/policy` and shown in Settings > Always refused.

**Remaining:**
- Separate out-of-model LLM intent classifier (beyond deterministic validation and merchant host matching).
- `"Don't ask again"` trust tier with hard exceptions for money/send/delete/account creation.
- Duet-side execution path for common connectors (vs prompt-governed execution on the agent host).

### 4.2 Payments: merchant host binding (Shipped in Pass 1)

**Shipped (`71f25c7`):**
- `request_payment` requires an absolute `http(s)` `merchant_url`, derives and stores `merchant_host`, and displays it
  on the payment card (`server/payments.ts`, `CardView.tsx`).
- `browser.fillCard(card, expectedHost)` re-checks `currentHost()` / origin and active element right before typing via
  `sameOriginSite`, refusing mismatches and hostless legacy cards (`server/browser.ts`).

**Remaining:** Optional provider-side merchant lock controls and wallet approval parity (Link / Shop Pay).

### 4.3 Channel and task model (Shipped in Pass 1)

**Shipped (`0b148bc`, `502f270`):**
- `channels.group` and `channels.instructions` (2,000 chars injected before `topic` with a safety-override clause),
  grouped strip/sheet, and unread `last_at > seen_at` indicator cleared on open.
- Dedicated `TaskSheet` with steps, result, sources, delivered files, and a live steering composer
  (`POST /api/tasks/:id/message` → `steerTask`).
- `Task.agent_done_at` vs user `confirmed_at` (`POST /api/tasks/:id/confirm` and `/reopen`).

**Remaining:** Automatic triage routing from the General channel into topic channels (`assign_channel`), and longer
task history pagination beyond the 60-task / 7-day window.

### 4.4 Source citations (Shipped in Pass 1)

**Shipped (`5a072f6`, `7fe8e8b`):**
- `server/sources.ts` validates real `item`/`task`/`file`/`page` ids and `http(s)` URLs across brief entries,
  watching lines, cards, handover cards, and task results; clickable source chips open files/pages or link out.

### 4.5 User-defined recurring routines (Shipped in Pass 2)

**Shipped (`986ad86`):**
- `routines` table, DST-aware daily/weekly/interval scheduler (`server/routines.ts`, `server/scheduler.ts`),
  `save_routine` / `remove_routine` tools, run-now/pause/resume endpoints, and the Settings > Routines sheet.

### 4.6 Notification preferences (Shipped in Pass 2)

**Shipped (`d68aefd`):**
- `server/notify-prefs.ts` filtering by task push mode (all/failures/off), `agent_notify` toggle, per-channel mute,
  and soft daily push cap in Settings (while keeping approvals, questions, and payments exempt).

**Remaining:** Outbound-thread follow-up tracking for conversations that go quiet.

### 4.7 Editable deliverables (Shipped in Pass 2)

**Shipped (`1415823`):**
- `POST /api/files/:id/versions` (`server/fileversions.ts`) saves edited text as a new `version_of` entry while leaving
  the original intact for Version Compare; `Viewer` edits Markdown/text/CSV/JSON and HTML source with a sandboxed preview.

### 4.8 Search and memory (Shipped in Pass 2)

**Shipped (`6606434`, expanded to schema v4 in `server/schema.ts`):**
- FTS indexing (`server/search.ts`, `server/schema.ts`) via `searchText(item)` and `taskSearchText(task)` covers card
  entries, drafts, watching, follow-ups, checklist items, metrics, line items, approval recipients/content, attachments,
  URLs/hosts, task steps/changes, and source quotes, while omitting superseded `version_of` files from `fts_assets`.
- Memory API (`GET/PUT/DELETE /api/memory`, `server/memory.ts`) and Settings > Memory sheet edit or clear
  `config.contextFile` with a 32 KB cap.

**Remaining:** Search across external Hermes conversations outside Duet (if/when exposed by Hermes).

### 4.9 Always-on availability and multiple machines (Docs shipped in Pass 2)

**Shipped (`0774238`):**
- [`docs/DEPLOY.md`](DEPLOY.md) and [`docker-compose.example.yml`](../docker-compose.example.yml) cover Linux mini-PC/VPS
  systemd deployment, Tailscale, backups, Docker isolation (Chromium/CDP inside the container), and explicit host limits.

**Remaining:** Multi-gateway / multi-agent switching (`DUET_HERMES_URL` per profile) and computer/session selection.

### 4.10 Connectors and channel repo binding (Read-only shipped in Pass 2)

**Shipped (`d01374c`):**
- `Channel.repo` validation and normalization (`owner/name` or GitHub URL) injected into the channel prompt.
- Read-only `GET /api/suggestions` and Connectors sheet showing connected tools and suggested next steps.

**Remaining:** Connector OAuth/install marketplace (intentionally omitted; read-only by design) and per-channel allowed-tool scopes.

### 4.11 Native/mobile polish (Open)

Deliberately deferred until the web/PWA surface stabilizes:
- Native iOS/Android shell (push reliability and background constraints on iOS).
- iPad side-by-side multi-column shell.
- In-app TTS voice/speed controls (currently env-configured).

---

## 5. Remaining roadmap

Core Passes 1 and 2 closed §§4.1–4.8 and the read-only/docs pieces of §§4.9–4.10. Remaining work:

1. **Small behavioral gaps:** automatic channel routing from General, outbound-thread follow-up tracking, and
   `"Don't ask again"` exceptions for low-risk actions (§§4.3, 4.6, 4.1).
2. **Multi-gateway / multi-agent support** (§4.9) — selectable `DUET_HERMES_URL` profiles and per-agent health.
3. **Per-channel tool scopes** (§4.10) — narrowing allowed tools per channel.
4. **Native/mobile polish** (§4.11) — in-app voice/speed UI, iPad layout ergonomics, and optional native shell.

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
