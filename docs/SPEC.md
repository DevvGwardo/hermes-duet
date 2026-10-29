# Technical & Product Specification: Hermes Duet v2
### Open-Source, Local-First "Claude Duet" for Hermes Agent

**Document Version:** 2.0.0  
**Target Architecture:** Bun / SQLite / React PWA / Hermes Gateway (Nous Research) / Tailscale  
**Status:** Ready for Implementation  

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
|   | - items / channels / tasks / files / pages / fts_messages / triggers    |   |
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

#### Technical Implementation
- **New Server Endpoints**:
  - `POST /api/uploads`: Multipart form upload, validates MIME type (`image/png`, `image/jpeg`, `image/webp`, `application/pdf`), writes to `data/uploads/<id>.<ext>`.
  - `POST /api/audio/transcribe`: Accepts binary audio chunk, forwards to local Whisper transcription model, returns `{ text: string }`.
  - `GET /api/brief/:id/audio`: Generates TTS audio stream using macOS `say` / Piper TTS / OpenAI TTS compatible endpoint.
- **PWA Media Hooks**:
  - `web/src/hooks/useAudioRecorder.ts`: Wraps `MediaRecorder`, handles iOS Safari audio context unlocking.
  - Integration with HTML5 `<input type="file" accept="image/*" capture="environment">`.

---

### Epic 2: Topic Channels & Unified Long-Term Memory

#### Problem Statement
Currently, Hermes Duet operates a single, continuous chat thread. When a user juggles diverse projects (e.g., `#general`, `#finances`, `#home`, `#project-launch`), messages interleave, context windows fill up, and it becomes difficult to maintain ongoing distinct conversations. Claude Duet provides separate channels that share persistent memory.

#### Target User Experience
1. **Channels Drawer / Tab**:
   - Users can create, switch between, and archive channels (e.g., `#general`, `#work`, `#taxes`, `#home-automation`).
   - The Morning Brief and daily Check-ins continue to live in `#general` or a dedicated `#briefs` view.
2. **Cross-Channel Shared Memory**:
   - Each channel runs its own active Hermes session (`session_id = duet-channel-<id>`), maintaining immediate conversational flow.
   - All channels share a unified memory repository stored in SQLite (`memories` table) and indexed into Hermes's context injection.
   - When Hermes learns a fact in `#finances` (e.g., "Accountant deadline is April 15"), it is stored in global memory and accessible when chatting in `#work`.
3. **Full-Text Search (SQLite FTS5)**:
   - A global Search bar (`Cmd+K` or magnifying glass icon) indexing:
     - Chat messages across all channels
     - Background task descriptions, steps, and handover cards
     - Standing page contents and delivered files
     - Brief decisions and watching items
   - Instant search results with highlighted snippets jumping directly to the message or deliverable.

#### Data Schema Updates
```sql
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  pinned INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Virtual table for lightning-fast search
CREATE VIRTUAL TABLE IF NOT EXISTS fts_items USING fts5(
  item_id UNINDEXED,
  channel_id UNINDEXED,
  kind UNINDEXED,
  text,
  card_title,
  card_body,
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

#### MCP Tool Definition
```typescript
{
  name: 'request_payment',
  description: 'Ask user approval before spending money or making a purchase. Posts a Payment Approval card with spend limits.',
  inputSchema: {
    type: 'object',
    properties: {
      merchant: { type: 'string', description: 'Vendor or store name' },
      amount_cents: { type: 'number', description: 'Total amount in cents (e.g. 2450 for $24.50)' },
      currency: { type: 'string', default: 'USD' },
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
    required: ['merchant', 'amount_cents', 'items']
  }
}
```

---

### Epic 4: Automated Connectors Hub & Local macOS Integrations

#### Problem Statement
Currently, Duet relies on a static Markdown file (`context.local.md`) where users manually write instructions on where their files and tasks live. Claude Duet, by contrast, automatically integrates with connected cloud accounts. In a local-first environment, Hermes Duet should seamlessly bind to the user's native macOS applications and services.

#### Target Integrations
1. **Apple Reminders & Notes**:
   - Integration via native macOS CLI/AppleScript (`remindctl` or Swift CLI helper).
   - Agent can fetch due items for the morning brief and append completed tasks.
2. **Apple Calendar & Google Calendar**:
   - Real-time read/write access to user calendar events.
   - Meeting prep card: Automatically post an attendee brief 15 minutes before upcoming calendar events.
3. **Local Mail (Mail.app / Fastmail / Gmail IMAP & OAuth)**:
   - Scans unread high-priority emails, extracts action items for morning brief decisions.
4. **Slack & Discord Webhook Ingest**:
   - Listens for direct mentions or urgent keywords and stages them for check-in briefs.
5. **Connectors Settings UI**:
   - In PWA `Settings → Connectors`, provide visual status indicators (Active / Disconnected / Needs Auth) and 1-tap setup scripts.

---

### Epic 5: Event-Driven Proactive Triggers Engine

#### Problem Statement
Currently, Duet's proactive runs are strictly time-bound: the morning brief runs at `brief_time`, standing pages run 30 minutes earlier, and check-ins run 3x daily or hourly. Real-world assistance requires **event-driven proactivity**: reacting when a file is downloaded, a webhook arrives, or a meeting is about to start.

#### Architecture of Trigger Engine
- **Webhook Ingress (`/api/webhooks/:key`)**:
  - Allows GitHub webhooks, Stripe events, or Zapier/n8n hooks to trigger Duet actions.
- **Directory Watcher (Chokidar / macOS FSEvents)**:
  - Watches `~/Downloads` for incoming receipts or bank statements, triggering automatic organization tasks.
- **Proximity Calendar Engine**:
  - Periodically inspects local calendar events; if a meeting is within 15 minutes, queues a lightweight briefing run to prepare meeting notes.

---

### Epic 6: Interactive Deliverables & Live Widgets (Make Tab v2)

#### Problem Statement
`deliver_file` currently serves static HTML/Markdown/PDF documents in a sandboxed iframe. If an agent builds a dynamic dashboard, task manager, or interactive calculator, the user cannot easily interact with it or send data back to the agent.

#### Target Features
1. **Bidirectional PostMessage Bridge**:
   - Deliverable HTML pages receive a lightweight script bridge:
     ```javascript
     window.Duet = {
       sendAction: (action, payload) => window.parent.postMessage({ type: 'duet_action', action, payload }, '*'),
       requestApproval: (data) => window.parent.postMessage({ type: 'duet_approval', data }, '*')
     };
     ```
   - Allows delivered dashboards to have interactive buttons (e.g. "Export to CSV", "Archive row", "Trigger follow-up").
2. **Version History & Visual Diffs for Standing Pages**:
   - In the Make tab under "Every morning", users can toggle between today's version and yesterday's version with a side-by-side or sliding visual diff.
3. **Native Document Export**:
   - One-tap buttons in the viewer to export delivered artifacts to PDF, print, or copy formatted Markdown to clipboard.

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

## 4. Database Schema Evolution (Migration v2)

```sql
-- Migration 002_channels_and_search.sql

-- Channels
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  topic TEXT,
  session_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Insert default general channel
INSERT OR IGNORE INTO channels (id, name, slug, topic, session_id, created_at, updated_at)
VALUES ('chan-general', 'general', 'general', 'General conversation and morning briefs', 'duet-main', strftime('%s','now')*1000, strftime('%s','now')*1000);

-- Channel association on items
ALTER TABLE items ADD COLUMN channel_id TEXT DEFAULT 'chan-general';
CREATE INDEX IF NOT EXISTS items_channel ON items(channel_id, created_at);

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

-- Event triggers
CREATE TABLE IF NOT EXISTS triggers (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL, -- 'calendar' | 'webhook' | 'file_watch' | 'cron'
  config_json TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  last_triggered_at INTEGER,
  created_at INTEGER NOT NULL
);

-- Full-Text Search Virtual Table
CREATE VIRTUAL TABLE IF NOT EXISTS fts_items USING fts5(
  item_id UNINDEXED,
  channel_id UNINDEXED,
  kind UNINDEXED,
  text,
  card_title,
  card_body,
  tokenize = 'porter unicode61'
);

-- Triggers to keep FTS index synchronized with items table
CREATE TRIGGER IF NOT EXISTS items_fts_insert AFTER INSERT ON items BEGIN
  INSERT INTO fts_items(item_id, channel_id, kind, text, card_title, card_body)
  VALUES (
    new.id,
    new.channel_id,
    new.kind,
    json_extract(new.json, '$.text'),
    json_extract(new.json, '$.card.title'),
    json_extract(new.json, '$.card.body')
  );
END;

CREATE TRIGGER IF NOT EXISTS items_fts_update AFTER UPDATE ON items BEGIN
  UPDATE fts_items SET
    channel_id = new.channel_id,
    kind = new.kind,
    text = json_extract(new.json, '$.text'),
    card_title = json_extract(new.json, '$.card.title'),
    card_body = json_extract(new.json, '$.card.body')
  WHERE item_id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS items_fts_delete AFTER DELETE ON items BEGIN
  DELETE FROM fts_items WHERE item_id = old.id;
END;
```

---

## 5. API Endpoints Specification

### 5.1 Channels API
- `GET /api/channels`: List all active channels with unread counts and last message timestamp.
- `POST /api/channels`: Create a new topic channel `{ name: string, topic?: string }`.
- `DELETE /api/channels/:id`: Archive channel.
- `GET /api/channels/:id/items`: Paginated messages for a specific channel.

### 5.2 Media & Multimodal API
- `POST /api/uploads`: Multipart upload endpoint handling camera photos, documents, and screenshots. Returns `{ file_id, url, path, mime }`.
- `POST /api/audio/transcribe`: Accepts audio blob (`audio/webm`, `audio/mp4`), converts to WAV/MP3, returns `{ text }`.
- `GET /api/briefs/:id/listen`: Streams synthesized speech audio of the brief.

### 5.3 Global Search API
- `GET /api/search?q=<query>&limit=20`: Searches across `fts_items`, returns ranked matches with highlight fragments and metadata.

### 5.4 Connectors & Triggers API
- `GET /api/connectors`: Lists installed system connectors (Reminders, Calendar, Mail, Slack) with health checks.
- `POST /api/connectors/:id/test`: Executes a test probe against the connector.
- `POST /api/webhooks/:token`: Authenticated external webhook trigger endpoint that wakes Hermes with an event payload.

---

## 6. Implementation Phasing & Milestones

### Phase 1: Multimodal Voice & Camera Inputs (Weeks 1–2)
- [ ] Implement `POST /api/uploads` and local file storage.
- [ ] Add Camera / File attachment button to `Composer.tsx` with thumbnail preview.
- [ ] Integrate local Whisper audio transcription endpoint in `server/audio.ts`.
- [ ] Add press-to-record voice memo button in `Composer.tsx`.
- [ ] Add image attachment passing to Hermes `/v1/runs` endpoint.

### Phase 2: Search & Multi-Topic Channels (Weeks 3–4)
- [ ] Execute SQLite FTS5 migration in `server/db.ts`.
- [ ] Implement `GET /api/search` with keyword highlighting.
- [ ] Create `ChannelsDrawer.tsx` and multi-channel UI routing.
- [ ] Partition Hermes sessions by channel while routing background tasks cleanly.
- [ ] Add unified memory injection into `persona()` across all channels.

### Phase 3: Connectors Hub & Event-Driven Triggers (Weeks 5–6)
- [ ] Implement macOS Reminders / Calendar CLI bridge.
- [ ] Build in-app Connectors status view in `SettingsSheet.tsx`.
- [ ] Implement event-driven trigger scheduler (meeting proximity alerts and webhook ingress).
- [ ] Add audio playback for morning briefs (Media Session API).

### Phase 4: Commercial Sandboxing & Virtual Cards (Weeks 7–8)
- [ ] Add `request_payment` MCP tool to `server/tools.ts` and `server/mcp-shim.ts`.
- [ ] Build Payment Approval Card component in `web/src/components/CardView.tsx`.
- [ ] Implement Privacy.com / Stripe Issuing API sandbox integration for one-time virtual card provisioning.
- [ ] Add 1Password CLI autofill trigger to the live browser pane.

---

## 7. Security, Trust & Sandbox Boundaries

1. **Local-First Zero Cloud Exfiltration**:
   - All chat histories, uploaded photos, voice recordings, and database records remain strictly on the local machine (`data/`).
   - Remote access is restricted to encrypted, authenticated Tailnet tunnels.
2. **Payment Safety Guarantees**:
   - `request_payment` must enforce a hard-coded single-transaction cap (configurable via `DUET_MAX_TRANSACTION_LIMIT`).
   - Virtual cards must be single-use and automatically expire within 60 minutes of issuance.
3. **Strict Content Security Policy**:
   - Continue serving deliverables in `Content-Security-Policy: sandbox allow-scripts` to isolate agent-generated code from device cookies and Duet API tokens.
4. **Credential Isolation**:
   - Never log, stream, or store plain-text passwords or card numbers in LLM prompts, SQLite logs, or PWA local storage.
