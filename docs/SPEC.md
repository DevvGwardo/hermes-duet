# Technical & Product Specification: Hermes Duet v2
### Open-Source, Local-First "Claude Duet" for Hermes Agent

**Document Version:** 2.0.0  
**Target Architecture:** Bun / SQLite / React PWA / Hermes Gateway (Nous Research) / Tailscale  
**Status:** Implemented (v2 Architecture Reference)  

---

## 1. Executive Summary & Product Vision

### 1.1 Context
On October 21, 2026, Anthropic launched [Claude Duet](https://claude.com/resources/articles/claude-duet), a proactive personal agent for mobile and desktop. Claude Duet shifts AI interaction from reactive prompt-and-response to proactive collaboration: the agent messages first, prepares morning briefs, runs background tasks, checks in during the day, asks before taking sensitive actions, and integrates with everyday tools.

**Hermes Duet** is the open-source, local-first alternative built for [Nous Research's Hermes Agent](https://github.com/NousResearch/hermes-agent). Operating locally on macOS/Linux through a secure Bun server, SQLite, and an installable React PWA connected privately over Tailscale, Hermes Duet already implements core Duet paradigms:
- Single continuous thread with structured cards
- Ranked morning briefs with editable drafts and silent "Watching" lists
- Silent check-ins that only notify when actionable decisions exist
- Proactive human-in-the-loop approvals with inline draft editing (`request_approval`, `ask`, `withdraw_card`)
- Isolated background task execution with handover summary cards (`start_task`, `update_task`)
- Standing pages that rebuild 30 minutes before the brief with diff tracking (`save_page`)
- Real-time CDP-streamed interactive browser takeover for logins and CAPTCHAs
- Resilient web push with iOS presence leases, quiet-hours suppression, and banner pruning

### 1.2 The Goal of this Specification
This specification outlines the next architectural evolution (**Hermes Duet v2**) to achieve full parity with—and in key areas surpass—Anthropic's Claude Duet. It addresses existing gaps: voice and multimodal camera capture, multi-topic channels, past chat search with FTS5, automated connector management, safe purchasing workflows, event-driven reactive triggers, and cross-platform server deployment.

---

## 2. Feature Comparison Matrix: Claude Duet vs. Hermes Duet

| Feature Area | Anthropic Claude Duet | Hermes Duet (v1 Current) | Hermes Duet (v2 Target Spec) |
|---|---|---|---|
| **Host & Privacy** | Cloud SaaS (Anthropic cloud VM) | Local-first (Mac, Tailscale private access) | Local-first (macOS + Linux systemd / Docker) |
| **Model Brain** | Claude Opus 5.5 | Hermes Agent (Local open-weights or API) | Hermes Agent (Multimodal + Function Calling) |
| **Proactivity & Briefs** | Morning brief + regular checks | Morning brief (top 5 ranked) + 3x/hourly checks | Morning brief + dynamic event/calendar triggers |
| **Sensitive Approvals** | Approval cards before action | Editable draft approval cards + `withdraw_card` | Approvals + dedicated `request_payment` card |
| **Live Browser** | Headless cloud VM (No live viewing) | Interactive CDP streaming over WebSocket | CDP streaming + 1Password CLI autofill + touch |
| **Input Modalities** | Text + Voice dictation | Text + Web Speech API dictation | Audio voice memos + Camera/Photo upload + TTS |
| **Conversational Scope** | Multi-channel topic threads | Single linear thread | Multi-channel workspaces + shared memory |
| **History & Memory** | Search past chats | SQLite last 150 items page + backward pagination | SQLite FTS5 instant search across history & files |
| **Standing Artifacts** | Make tab deliverables | Make tab + standing pages rebuilt daily | Make tab + bidirectional postMessage widgets |
| **Commerce / Spend** | Stripe Link & Shop Pay virtual cards | None | Privacy.com / Revolut / Stripe virtual cards |
| **Connectors & Tools** | 6,000+ Claude Marketplace connectors | Static `context.local.md` + Hermes MCP tools | In-app Connectors UI + native Apple/OS hooks |

---

## 3. Core Architectural Epics

```
+---------------------------------------------------------------------------------+
|                                 Hermes Duet PWA                                 |
|   [Chat / Channels]   [Tasks & Handover]   [Make & Pages]   [Live Browser Pane] |
|   [Voice & Camera]    [FTS5 Chat Search]   [Connectors UI]  [Approval Cards]    |
+----------------------------------------+----------------------------------------+
                                         | HTTPS / WSS (Tailscale)
+----------------------------------------v----------------------------------------+
|                               Duet Bun Server                                   |
|   +--------------------+  +---------------------+  +------------------------+   |
|   | /api/channels      |  | Audio STT / TTS     |  | Event Triggers & Cron  |   |
|   | /api/uploads       |  | FTS5 Search Engine  |  | Push & Presence Leases |   |
|   | /api/connectors    |  | Virtual Card Proxy  |  | CDP Browser Driver     |   |
|   +--------------------+  +---------------------+  +------------------------+   |
|                                        |                                        |
|   +------------------------------------+------------------------------------+   |
|   | SQLite WAL Storage (duet.db)                                            |   |
|   | - items / channels / tasks / files / pages / routines / triggers / FTS5 |   |
|   +------------------------------------+------------------------------------+   |
+----------------------------------------|----------------------------------------+
                                         | Localhost / Internal MCP
+----------------------------------------v----------------------------------------+
|                         Hermes Agent Gateway (:8642)                            |
|   - Multi-agent sessions (Main lane, Task lanes, Side check-in sessions)        |
|   - Local & Remote MCP Tools (duet shim, memory, system tools, web tools)       |
+---------------------------------------------------------------------------------+
```

---

### Epic 1: Multimodal Ingestion (Audio Voice Memos & Camera Capture)

#### Problem Statement
Claude Duet allows users to "message it through typing or voice" on walks or commutes. In Hermes Duet v1, input is restricted to text and the browser's native `SpeechRecognition` web API (which is spotty on iOS Safari and requires network access). Furthermore, mobile users cannot snap a picture of a receipt, whiteboard, document, or physical object to hand off to Hermes.

#### Target User Experience
1. **Audio Voice Notes**:
   - Hold-to-record or tap-to-record mic button with audio waveform preview.
   - On release, the client records an audio memo (`audio/webm` or `audio/mp4`), sends it to `/api/audio/transcribe`.
   - The server transcribes the audio using a fast local engine (Hermes's local Whisper endpoint, `whisper.cpp`, or fallback to API) and streams the transcription into the Composer for quick review or auto-sends it.
2. **Spoken Morning Briefings (Audio Player)**:
   - Next to the morning brief, a "Listen" button streams text-to-speech audio of the brief via the Media Session API, allowing the user to listen to their day's priorities while commuting or walking.
3. **Camera & Image Uploads**:
   - Paperclip / camera button next to the composer allowing:
     - Taking a live photo with the camera.
     - Selecting an image or PDF from the photo library or file picker.
   - File uploads stream to `/api/uploads` and are stored in `data/uploads/`.
   - The message payload sent to Hermes includes image file paths or base64 data URIs so multimodal models (e.g. Hermes Vision / Llama 3.2 Vision / Claude / GPT-4o) can analyze the content directly.

#### Implemented Server & Media Surface
- **Server Endpoints**:
  - `POST /api/uploads`: Streaming multipart upload (`server/multipart.ts`, 25 MB cap), validates MIME type (`image/png`, `image/jpeg`, `image/svg+xml`, `image/webp`, `image/heic`, `image/gif`, `application/pdf`, `text/*`, `audio/*`, `video/mp4`), writes to `data/uploads/<id>.<ext>` with `0600`, returns `{ attachment }`. `GET /api/uploads/:id` serves uploads with byte-range support and sandbox CSP; `DELETE /api/uploads/:id` removes unlinked uploads.
  - `POST /api/audio/transcribe` (and `POST /api/audio/transcribe/:id` retry): Accepts `multipart/form-data` or binary audio chunk, saves the voice memo, transcribes via `DUET_STT_URL` or local `whisper.cpp` (`DUET_STT_CMD` / `whisper-cli` / `whisper-cpp`, using `ffmpeg` for non-WAV transcoding), returns `{ text, attachment }`.
  - `GET /api/brief/:id/audio`: Generates and caches TTS audio (`data/tts/`) using OpenAI-compatible `DUET_TTS_URL`, `DUET_TTS_CMD` (e.g. Piper), or macOS `say` + `afconvert`, served with HTTP byte-range support (`206 Partial Content`).
- **PWA Media Hooks**:
  - `web/src/hooks/useAudioRecorder.ts` and `web/src/components/VoiceInput.tsx`: MediaRecorder capture with waveform preview, iOS Safari audio handling, and retry support.
  - File/camera attachment picker in `web/src/components/Composer.tsx`.

---

### Epic 2: Topic Channels & Unified Long-Term Memory

#### Problem Statement
Currently, Hermes Duet operates a single, continuous chat thread. When a user juggles diverse projects (e.g., `#general`, `#finances`, `#home`, `#project-launch`), messages interleave, context windows fill up, and it becomes difficult to maintain ongoing distinct conversations. Claude Duet provides separate channels that share persistent memory.

#### Target User Experience
1. **Channels Strip & Sheet (`web/src/components/Channels.tsx`)**:
   - Users can create, group, set standing instructions/repos for, switch between, and archive channels (e.g., `#general`, `#work`, `#taxes`, `#home-automation`).
   - The Morning Brief and daily Check-ins continue to live in `#general` (`chan-general`).
2. **Cross-Channel Shared Memory**:
   - Each channel runs its own active Hermes session (`duet-main-<id>` for general, `duet-chan-<id>` for topic channels), maintaining immediate conversational flow.
   - All channels share a unified memory file (`config.contextFile`, default `./context.local.md`, managed by `server/memory.ts` and `GET/PUT/DELETE /api/memory` with a 32 KB limit) injected into Hermes's context.
   - When Hermes learns or records a fact in `#finances` in `context.local.md`, it is accessible across all channels.
3. **Full-Text Search (SQLite FTS5)**:
   - A global Search bar (`Cmd+K` or magnifier icon) indexing (`fts_items` + `fts_assets`, schema v4):
     - Chat messages across all channels (including card subfields, attachments, URLs, and sources)
     - Background task descriptions, steps, changes, and handover cards
     - Standing page contents and latest delivered files (omitting superseded `version_of` rows)
     - Brief decisions and watching items
   - Instant search results with highlighted snippets jumping directly to the message or deliverable.

#### Data Schema (Implemented in `server/schema.ts`, `SCHEMA_VERSION = 4`)
```sql
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  topic TEXT,
  session_id TEXT NOT NULL,
  seen_at INTEGER,
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  "instructions" TEXT,
  "group" TEXT,
  "repo" TEXT
);

-- Virtual tables for full-text search (items + tasks/files/pages)
CREATE VIRTUAL TABLE IF NOT EXISTS fts_items USING fts5(
  item_id UNINDEXED,
  channel_id UNINDEXED,
  kind UNINDEXED,
  text,
  tokenize = 'porter unicode61'
);

CREATE VIRTUAL TABLE IF NOT EXISTS fts_assets USING fts5(
  ref UNINDEXED,
  kind UNINDEXED,
  channel_id UNINDEXED,
  title,
  text,
  tokenize = 'porter unicode61'
);
```

---

### Epic 3: Safe Purchasing & Commercial Transactions ("Open Link")

#### Problem Statement
One of Claude Duet's flagship enterprise capabilities is making autonomous purchases on behalf of users via Stripe Link and Shop Pay using single-use virtual cards, requiring strict user approval before spending money. Open-source agents currently lack a clean, safe pattern for handling payments.

#### Target User Experience
1. **`request_payment` MCP Tool**:
   - When the agent prepares to execute a purchase (e.g. buying train tickets, office supplies, ordering food, or paying an invoice), it calls `request_payment`.
   - Duet renders a high-visibility, gold-bordered **Payment Approval Card**:
     - Merchant name and logo
     - Itemized receipt breakdown and total amount
     - Currency and max authorized cap
     - Single-tap **Approve & Pay ($X.XX)** or **Decline**
2. **Virtual Card Generation & Sandbox**:
   - Integrates with virtual card providers (Privacy.com API, Revolut API, or Stripe Issuing test/live mode).
   - Upon user approval:
     - The server requests a one-time virtual card capped at the exact approved dollar amount.
     - The card details (PAN, CVV, Exp) are securely injected directly into the agent's live browser CDP session via DOM input filling.
     - Card details are **never stored** in the chat thread, database, or LLM context window.

#### MCP Tool Definition (`server/tools.ts`)
```typescript
{
  name: 'request_payment',
  description: 'Ask the user to approve spending money BEFORE you buy anything: tickets, supplies, food, an invoice. ...',
  inputSchema: {
    type: 'object',
    properties: {
      merchant: { type: 'string', description: 'Vendor or store name, e.g. "Amtrak".' },
      merchant_url: { type: 'string', description: 'The exact checkout page, e.g. "https://shop.example.com/checkout". The single-use card is only typed into this page\'s host.' },
      amount_cents: { type: 'number', description: 'Total in cents (2450 for $24.50). Must equal the items.' },
      currency: { type: 'string', description: 'Three-letter code. Default USD.' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            price_cents: { type: 'number' },
            quantity: { type: 'number' }
          },
          required: ['title', 'price_cents']
        }
      },
      task_id: taskId
    },
    required: ['merchant', 'merchant_url', 'amount_cents', 'items']
  }
}
```

---

### Epic 4: Automated Connectors Hub & Local macOS Integrations

#### Problem Statement
Currently, Duet relies on a static Markdown file (`context.local.md`) where users manually write instructions on where their files and tasks live. Claude Duet, by contrast, automatically integrates with connected cloud accounts. In a local-first environment, Hermes Duet should seamlessly bind to the user's native macOS applications and services.

#### Implemented Integrations (`server/connectors.ts`)
1. **Apple Reminders (`reminders`)**:
   - Native macOS CLI probe via `remindctl`; lets the agent fetch due reminders for the morning brief.
2. **Apple Calendar (`calendar`)**:
   - Native macOS AppleScript via `osascript` reading upcoming events in the next 6 hours.
   - Meeting prep card: Automatically posts a prep nudge when a calendar event enters the `DUET_MEETING_LEAD_MIN` window (default 15 minutes).
3. **Apple Mail (`mail`)**:
   - Native macOS AppleScript via `osascript` scanning unread inbox messages for the morning brief.
4. **Watched Folder (`folder`) & Webhooks (`webhook`)**:
   - Cross-platform event triggers (`~/Downloads` watcher and authenticated webhook ingress).
5. **Connectors Settings UI**:
   - Read-only discovery in PWA `Settings → Connectors` (`GET /api/connectors` and `GET /api/suggestions`) with live test probes (`POST /api/connectors/:id/test`), plus Hermes toolsets and MCP servers. (Google Calendar OAuth, IMAP, Apple Notes, and Slack/Discord connectors are not built-in.)

---

### Epic 5: Event-Driven Proactive Triggers Engine

#### Problem Statement
Currently, Duet's proactive runs are strictly time-bound: the morning brief runs at `brief_time`, standing pages run 30 minutes earlier, and check-ins run 3x daily or hourly. Real-world assistance requires **event-driven proactivity**: reacting when a file is downloaded, a webhook arrives, or a meeting is about to start.

#### Architecture of Trigger Engine (`server/triggers.ts`, `server/triggers-runtime.ts`)
- **Webhook Ingress (`/api/webhooks/:token`)**:
  - Allows GitHub webhooks, Stripe events, or Zapier/n8n hooks to wake Hermes with the payload as text.
- **Directory Watcher (15 s polling with 20 s settle window)**:
  - Watches `DUET_WATCH_DIR` (default `~/Downloads`) for incoming documents, spreadsheets, images, and `.eml` files, triggering automatic review turns.
- **Proximity Calendar Engine**:
  - Periodically inspects local Apple Calendar events; if a meeting is within `DUET_MEETING_LEAD_MIN` minutes (default 15), queues a briefing run to prepare meeting notes.

---

### Epic 6: Interactive Deliverables & Live Widgets (Make Tab v2)

#### Problem Statement
`deliver_file` currently serves static HTML/Markdown/PDF documents in a sandboxed iframe. If an agent builds a dynamic dashboard, task manager, or interactive calculator, the user cannot easily interact with it or send data back to the agent.

#### Target Features
1. **Bidirectional PostMessage Bridge (`server/index.ts`)**:
   - Deliverable HTML pages receive a lightweight script bridge (`document.documentElement.setAttribute('data-duet', '1')`):
     ```javascript
     window.Duet = {
       version: 1,
       sendAction: (action, payload) => window.parent.postMessage({ type: 'duet_action', data: { action, payload } }, '*'),
       requestApproval: (data) => window.parent.postMessage({ type: 'duet_approval', data: { title, summary, action_label } }, '*')
     };
     ```
   - Allows delivered dashboards to have interactive buttons routed through `POST /api/deliverables/:id/action` or `/approval`.
2. **Version History, Inline Editing & Visual Diffs for Standing Pages**:
   - In the Make tab under "Every morning", users can compare today's version against the previous version with a sliding visual diff, and edit delivered text/Markdown/CSV/JSON/HTML files (`POST /api/files/:id/versions`).
3. **Native Document Export**:
   - Download / export buttons in `Viewer.tsx` (`?download=1`) alongside sandboxed HTML preview.

---

### Epic 7: Live Browser Upgrades (CDP & Credential Autofill)

#### Enhancements
1. **1Password / Bitwarden CLI Integration**:
   - When the agent stalls at a login wall in the live browser, instead of manually typing passwords on a mobile keyboard, the PWA offers an **"Autofill with 1Password"** button.
   - The server queries `op item get <domain>` and dispatches trusted CDP input events directly into Chrome.
2. **Mobile Viewport Emulation**:
   - Allow toggling between desktop and mobile viewport (`390x844` iPhone layout) so responsive sites don't render microscopic desktop layouts on mobile phones.
3. **Virtual Keyboard Handling**:
   - Improved software keyboard detection and tap coordinate scaling for pinch-to-zoom on iOS Safari.

---

### Epic 8: Cross-Platform Deployment (Linux systemd & Docker)

#### Enhancements
1. **Linux `systemd` Support**:
   - Provide `bin/hermes-duet install-systemd` alongside `launchd` for users running on Ubuntu/Debian headless homelabs or remote VPSs.
2. **Docker / Container Support**:
   - Multi-stage Dockerfile bundling Bun runtime, headless Chrome, and SQLite data volume.

---

## 4. Database Schema Evolution (`server/schema.ts`)

Current schema is `SCHEMA_VERSION = 4`. Key additions beyond the initial tables (`items`, `tasks`, `files`, `runs`, `pages`, `kv`, `devices`, `push_subs`, `pair_codes`) include:

```sql
-- Channels (plus idempotent addColumn migrations for instructions, group, repo)
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  topic TEXT,
  session_id TEXT NOT NULL,
  seen_at INTEGER,
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS channels_session ON channels(session_id);

-- Default general channel (`chan-general`) created by db.ts with a generated `duet-main-<id>` session
-- Channel association and expression index on pending cards
ALTER TABLE items ADD COLUMN "channel_id" TEXT DEFAULT 'chan-general';
CREATE INDEX IF NOT EXISTS items_channel ON items(channel_id, created_at);
CREATE INDEX IF NOT EXISTS items_card_status ON items(json_extract(json, '$.card.status'), created_at) WHERE kind = 'card';

-- Attachments and media uploads
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  item_id TEXT,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  path TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- User-defined recurring routines
CREATE TABLE IF NOT EXISTS routines (
  id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  next_run INTEGER,
  created_at INTEGER NOT NULL,
  json TEXT NOT NULL
);

-- Event triggers
CREATE TABLE IF NOT EXISTS triggers (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL, -- 'calendar' | 'webhook' | 'folder'
  config_json TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  last_triggered_at INTEGER,
  created_at INTEGER NOT NULL
);

-- Full-Text Search Virtual Tables (v4)
CREATE VIRTUAL TABLE IF NOT EXISTS fts_items USING fts5(
  item_id UNINDEXED,
  channel_id UNINDEXED,
  kind UNINDEXED,
  text,
  tokenize = 'porter unicode61'
);

CREATE VIRTUAL TABLE IF NOT EXISTS fts_assets USING fts5(
  ref UNINDEXED,
  kind UNINDEXED,
  channel_id UNINDEXED,
  title,
  text,
  tokenize = 'porter unicode61'
);

-- The index row is written by db.items.save() from searchText(item), which flattens every card
-- subfield (entries, drafts, watching, follow-ups, checklist, metrics, line items, attachments,
-- URLs, sources) into one text column. Only the delete trigger remains, so a deleted item cannot leave a stale hit.
CREATE TRIGGER IF NOT EXISTS items_fts_delete AFTER DELETE ON items BEGIN
  DELETE FROM fts_items WHERE item_id = old.id;
END;
```

---

## 5. API Endpoints Reference (`server/index.ts`)

### 5.1 Health, Pairing & State
- `GET /api/health`, `GET /api/version`, `GET /api/events` (SSE stream), `GET /api/state` (snapshot), `GET /api/items`, `GET /api/items/:id`.
- `POST /api/pair`, `GET /api/devices`, `DELETE /api/devices/:id`.
- `POST /api/messages`, `POST /api/runs/stop`, `POST /api/cards/:id/act`, `PUT /api/settings`, `GET /api/policy`, `POST /api/brief/run`.

### 5.2 Channels & Routines API
- `GET /api/channels`: List all active channels with unread state and last message timestamp.
- `POST /api/channels`: Create a channel or edit an existing one when `id` is provided.
- `DELETE /api/channels/:id`: Archive channel.
- `POST /api/channels/:id/seen`: Mark channel as seen.
- `GET /api/channels/:id/items`: Paginated messages for a specific channel (`?before=<id>`).
- `GET/POST /api/routines`, `DELETE /api/routines/:id`, `POST /api/routines/:id/(run|pause|resume)`.

### 5.3 Tasks, Deliverables, Memory & Media API
- `POST /api/tasks`, `POST /api/tasks/:id/(cancel|confirm|reopen|message)`.
- `GET /api/files/:id`, `GET /api/files/:id/meta`, `POST /api/files/:id/versions`, `DELETE /api/pages/:id`, `POST /api/deliverables/:id/(action|approval)`.
- `GET/PUT/DELETE /api/memory`: Read, update (32 KB cap), or clear `config.contextFile` (`./context.local.md`).
- `POST /api/uploads`: Streaming multipart upload (`file` field, 25 MB cap). Returns `{ attachment }`.
- `GET /api/uploads/:id` / `DELETE /api/uploads/:id`: Ranged inline serving (sandbox CSP) and unlinked upload removal.
- `POST /api/audio/transcribe` / `POST /api/audio/transcribe/:id`: Transcribes uploaded/recorded audio (or retries an existing attachment), returns `{ text, attachment }`.
- `GET /api/brief/:id/audio`: Streams synthesized speech audio of the brief with byte-range support.

### 5.4 Global Search, Connectors, Triggers, Push & Live Browser API
- `GET /api/search?q=<query>&limit=20`: Searches across `fts_items` and `fts_assets`, returns `{ hits, terms }`.
- `GET /api/connectors`, `POST /api/connectors/:id/test`, `GET /api/capabilities`, `GET /api/suggestions`.
- `GET /api/triggers`, `POST /api/webhooks/:token` (unauthenticated token-gated webhook ingress).
- `GET /api/push/key`, `POST /api/push/subscribe`, `POST /api/presence`, `POST /api/push/test`.
- `GET /api/browser/ws` (WebSocket frame/input stream), `GET /api/browser/status`, `GET /api/browser/tabs`, `POST /api/browser/open`, `POST /api/browser/input`, `POST /api/browser/viewport`, `GET /api/browser/vaults`, `POST /api/browser/autofill`.

---

## 6. Implementation Phasing & Milestones (Completed)

### Phase 1: Multimodal Voice & Camera Inputs
- [x] Implement `POST /api/uploads` (`server/uploads.ts`, `server/multipart.ts`) and local `0600` file storage.
- [x] Add Camera / File attachment button to `Composer.tsx` with thumbnail preview.
- [x] Integrate local Whisper / HTTP audio transcription endpoints in `server/audio.ts`.
- [x] Add voice memo recording UI in `VoiceInput.tsx` and `useAudioRecorder.ts`.
- [x] Add attachment path passing for multimodal inspection in Hermes turns.

### Phase 2: Search & Multi-Topic Channels
- [x] Execute SQLite FTS5 migrations in `server/schema.ts` and `server/search.ts`.
- [x] Implement `GET /api/search` with keyword highlighting (`SearchOverlay` in `web/src/components/Channels.tsx`).
- [x] Create `Channels.tsx` (`ChannelsStrip`, `ChannelsSheet`) and multi-channel UI routing.
- [x] Partition Hermes sessions by channel while routing background tasks cleanly.
- [x] Add unified memory injection (`context.local.md`, `server/memory.ts`) into `persona()` across all channels.

### Phase 3: Connectors Hub & Event-Driven Triggers
- [x] Implement macOS Reminders / Calendar / Mail native bridges (`server/connectors.ts`).
- [x] Build in-app Connectors & Triggers views in `SettingsSheet.tsx`.
- [x] Implement event-driven trigger scheduler (`server/triggers.ts`, `server/triggers-runtime.ts`).
- [x] Add ranged audio playback for morning briefs (`GET /api/brief/:id/audio`).

### Phase 4: Commercial Sandboxing & Virtual Cards
- [x] Add `request_payment` MCP tool to `server/tools.ts` and `server/mcp-shim.ts`.
- [x] Build Payment Approval Card component in `web/src/components/CardView.tsx`.
- [x] Implement Privacy.com / Stripe Issuing / Revolut / generic single-use card integration (`server/payments.ts`).
- [x] Add 1Password / Bitwarden CLI autofill trigger (`server/vault.ts`) to the live browser pane.

---

## 7. Security, Trust & Sandbox Boundaries

1. **Local-First Zero Cloud Exfiltration**:
   - All chat histories, uploaded photos, voice recordings, and database records remain strictly on the local machine (`data/`).
   - Remote access is restricted to encrypted, authenticated Tailnet tunnels.
2. **Payment Safety Guarantees**:
   - `request_payment` enforces a single-transaction cap (`DUET_MAX_TRANSACTION_LIMIT` / `DUET_MAX_TRANSACTION_LIMIT_CENTS`) and binds `merchant_url` host checks (`sameOriginSite`) before filling.
   - Virtual cards are single-use and expire within 60 minutes of issuance where supported by the provider.
3. **Strict Content Security Policy**:
   - Serve HTML deliverables with `Content-Security-Policy: sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals; frame-ancestors 'self'` (and uploads with `default-src 'none'; style-src 'unsafe-inline'; sandbox`) to isolate agent-generated files from device cookies and Duet API tokens.
4. **Credential Isolation**:
   - Never log, stream, or store plain-text passwords or card numbers in LLM prompts, SQLite logs, or PWA local storage.
