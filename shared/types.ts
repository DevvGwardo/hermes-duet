// Shared between the server and the web app. Keep this file dependency-free.

export type ItemKind = 'user' | 'assistant' | 'card' | 'activity' | 'system';

export type CardType =
  | 'approval' // "Needs your OK": Approve / Not now
  | 'payment' // "Check before I spend": itemized spend approval, optionally paid with a single-use card
  | 'choice' // a question with fixed options
  | 'brief' // morning brief / check-in digest
  | 'checklist'
  | 'metrics'
  | 'file'
  | 'note'
  | 'handover'; // a background task finished: result, files, follow-ups

export type CardStatus = 'pending' | 'approved' | 'declined' | 'answered' | 'expired' | 'info';

export interface BriefEntry {
  title: string;
  detail?: string;
  priority?: 'high' | 'medium' | 'low';
  /** Optional one-tap follow-up; tapping sends this text as a user message (unless the entry has a draft). */
  action_label?: string;
  action_message?: string;
  /** Markdown the agent already prepared for this decision (a reply, a plan); shown collapsed under the entry. */
  draft?: string;
  /** The user tapped the entry's chip: `draft` went back to the agent as is, or `action_message` was sent. */
  used?: boolean;
  /** When the user tapped "Skip": it doesn't need them. Later check-ins and briefs are told not to raise it again. */
  skipped_at?: number;
  /** The entry is about a standing page: its version when the brief was posted, opened by tapping "Open page". */
  file_id?: string;
}

/** Something the agent is keeping an eye on that doesn't need a decision; listed muted under a brief, never pushed. */
export interface WatchEntry {
  title: string;
  detail?: string;
  /** Same as BriefEntry.file_id: a line about a standing page opens it. */
  file_id?: string;
}

/** A one-tap next step; tapping sends `message` to the main thread as the user. */
export interface FollowUp {
  label: string;
  message: string;
  /** Set on the handover card once tapped, so the chip stays spent across reloads and devices. */
  used?: boolean;
}

export interface ChecklistEntry {
  text: string;
  done?: boolean;
}

export interface MetricEntry {
  label: string;
  value: string;
  delta?: string;
  tone?: 'good' | 'bad' | 'neutral';
}

/** One line of a payment card's receipt. `price_cents` is the unit price. */
export interface PaymentItem {
  title: string;
  price_cents: number;
  quantity?: number;
}

export interface CardData {
  type: CardType;
  title: string;
  body?: string; // markdown
  status: CardStatus;
  /** approval: verb shown on the primary button, e.g. "Send", "Pay $640". */
  action_label?: string;
  /** approval: the exact text the agent will send; editable on the pending card. */
  draft?: string;
  /** approval: the user changed `draft` before approving, so `draft` now holds their version. */
  edited?: boolean;
  options?: string[]; // choice
  entries?: BriefEntry[]; // brief: decisions, ranked high to low
  watching?: WatchEntry[]; // brief
  checklist?: ChecklistEntry[]; // checklist
  metrics?: MetricEntry[]; // metrics
  file_id?: string; // file
  file_ids?: string[]; // handover
  follow_ups?: FollowUp[]; // handover
  /** handover: the task failed or stopped; `body` is the reason. */
  failed?: boolean;
  /** failed handover: the task's instructions were kept, so "Try again" can restart it. */
  retry?: boolean;
  decision?: string; // what the user picked
  decided_at?: number;
  /** A decision the agent never received: the card is pending again and this says why, so it can be re-tapped. */
  error?: string;
  task_id?: string;
  updated_label?: string; // e.g. "Updated 5:48 AM"
  /** "Pick it back up?" card offered after Hermes dropped a run mid-flight. */
  resume?: boolean;
  /** "Run it now?" card left by a morning brief that failed; answering it needs no agent turn. */
  rerun?: 'brief';
  /** note: posted by the agent's `notify`, so the push has a card to open and a quiet-hours hold has one to keep. */
  alert?: boolean;
  /** Agent session that receives the decision (Duet-tool cards). */
  session_id?: string;
  /** Channel the card belongs to; the thread shows only its channel's items. */
  channel_id?: string;
  // ---- payment cards ----
  merchant?: string;
  /** Total the user is approving, in the currency's minor unit (cents). */
  amount_cents?: number;
  currency?: string;
  /** The hard ceiling the total was checked against (config.maxTransactionCents). */
  cap_cents?: number;
  line_items?: PaymentItem[];
  /** Set when a single-use virtual card was issued for this payment. Never the card itself: only how it ended. */
  card_summary?: string;
  /** Set when the card details were typed into the agent's live browser instead of being handed to the model. */
  card_filled?: boolean;
  /** Set when the card mirrors a Hermes-native approval/clarify prompt on a live run. */
  hermes?: { kind: 'approval' | 'clarify'; run_id: string; request_id: string; generation: number };
}

/** A file the user handed over from the composer: a camera photo, a document, or a voice memo. */
export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  /** images and PDFs are shown in the thread; audio is playable in place. */
  kind: 'image' | 'audio' | 'file';
  created_at: number;
}

export function attachmentKind(mime: string): Attachment['kind'] {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}

export interface ToolStep {
  id: string;
  name: string;
  label?: string;
  status: 'running' | 'done' | 'error';
  started_at: number;
  ended_at?: number;
}

export interface ActivityData {
  run_id: string;
  status: 'running' | 'done' | 'error' | 'stopped';
  steps: ToolStep[];
  summary?: string;
  error?: string;
}

export interface Item {
  id: string;
  kind: ItemKind;
  created_at: number;
  updated_at: number;
  run_id?: string | null;
  task_id?: string | null;
  /** Which topic channel this belongs to; absent means the general channel. */
  channel_id?: string;
  text?: string; // user / assistant / system
  streaming?: boolean;
  card?: CardData;
  activity?: ActivityData;
  attachments?: Attachment[];
}

/** A topic thread. Each one runs its own Hermes session but shares the agent's memory across the install. */
export interface Channel {
  id: string;
  name: string;
  slug: string;
  topic?: string;
  /** The Hermes session this channel talks to. */
  session_id: string;
  /** Last time the user opened it here, for the unread dot. */
  seen_at?: number;
  /** Newest item in it, filled in when the channel list is read. */
  last_at?: number;
  archived?: boolean;
  created_at: number;
  updated_at: number;
}

/** One hit from the full-text index: a thread item, a task, a delivered file or a standing page. */
export interface SearchHit {
  kind: 'item' | 'task' | 'file' | 'page';
  /** Item id for thread hits, otherwise the record's id. */
  id: string;
  /** Card or message title; the first line for plain messages. */
  title: string;
  /** Plain-text excerpt with the matched terms in it (the client marks them up). */
  snippet: string;
  channel_id?: string;
  created_at: number;
}

/** A native integration the agent can use on this machine. */
export interface Connector {
  id: string;
  name: string;
  kind: 'reminders' | 'calendar' | 'mail' | 'webhook' | 'folder';
  status: 'active' | 'needs_auth' | 'missing' | 'unsupported';
  detail: string;
  /** The command or setting that turns it on, when it isn't. */
  hint?: string;
}

export type TaskStatus = 'queued' | 'running' | 'waiting' | 'done' | 'failed' | 'cancelled';

export interface TaskStep {
  text: string;
  done?: boolean;
}

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  progress?: string;
  steps: TaskStep[];
  result?: string;
  /** Up to three next steps the task suggests; shown on its handover card. */
  follow_ups?: FollowUp[];
  /** The thread card that handed this task's result over, once it finished. */
  handover_id?: string;
  /** What the task was started with, kept so a failed task can be tried again as-is. */
  instructions?: string;
  /** Set when "Try again" restarted it; files from earlier attempts stay off the new handover card. */
  retried_at?: number;
  /** A standing page's scheduled refresh: the file it delivers becomes the page's current version. */
  page_id?: string;
  /** Which channel to hand the result back in; absent means general. */
  channel_id?: string;
  /** Page refresh only: the agent's one line on what changed since the previous version. */
  changed?: string;
  created_at: number;
  updated_at: number;
  background: boolean;
}

/** A standing artifact the user checks every morning; rebuilt by a background task before each brief. */
export interface Page {
  id: string;
  title: string;
  /** Self-contained rebuild instructions the agent wrote with save_page: sources, layout, what to compare. */
  instructions: string;
  /** The current version; each refresh that delivers the same kind of file replaces it. */
  file_id: string;
  /** Local date ("YYYY-MM-DD") of the last scheduled refresh, so each day refreshes once. */
  refreshed_on?: string;
  /** When a new version last arrived. */
  refreshed_at?: number;
  /** The latest refresh task and how it went (`last_ok` is false when it failed or delivered no new version). */
  task_id?: string;
  last_ok?: boolean;
  last_result?: string;
  /** What changed since the previous version, from the latest successful refresh; cleared when a refresh fails. */
  changed?: string;
  created_at: number;
  updated_at: number;
}

export interface FileEntry {
  id: string;
  title: string;
  name: string;
  mime: string;
  size: number;
  task_id?: string | null;
  /** Set when this file became a version of that standing page; lists show only a page's newest version. */
  page_id?: string;
  created_at: number;
}

export interface Settings {
  brief_enabled: boolean;
  brief_time: string; // "HH:MM" local
  checkins: 'off' | '3x' | 'hourly';
  quiet_start: string; // "HH:MM"
  quiet_end: string;
  timezone: string;
}

export interface AgentState {
  busy: boolean;
  current_run?: { id: string; kind: string; started_at: number } | null;
  queued: number;
  hermes: 'ok' | 'down' | 'unknown';
  background_running: number;
}

/** What the agent already has before the first message ("What I can see"). Names only, never config values. */
export interface Capabilities {
  /** One short label per source line in the context file; empty when there is no context file. */
  context: string[];
  /** Installed Hermes skills, counted per category (largest first). `skills_from` says where the list came from. */
  skills: { total: number; categories: { name: string; count: number }[] };
  skills_from: 'hermes' | 'files' | 'none';
  /** Labels of the toolsets enabled for the API server, or null when Hermes didn't answer. */
  toolsets: string[] | null;
  /** MCP server names from the Hermes config (the Duet tools themselves are left out). */
  apps: string[];
  checked_at: number;
}

export interface Snapshot {
  items: Item[];
  has_more: boolean;
  /** Every pending card, including ones older than the `items` page. */
  pending: Item[];
  tasks: Task[];
  files: FileEntry[];
  pages: Page[];
  /** Topic channels, newest activity last. The app opens the general one first. */
  channels: Channel[];
  settings: Settings;
  agent: AgentState;
  push_enabled: boolean;
}

export type ServerEvent =
  | { type: 'item'; item: Item }
  | { type: 'delta'; item_id: string; text: string }
  | { type: 'task'; task: Task }
  | { type: 'file'; file: FileEntry }
  | { type: 'page'; page: Page }
  | { type: 'page_removed'; id: string }
  | { type: 'channel'; channel: Channel }
  | { type: 'channel_removed'; id: string }
  | { type: 'agent'; agent: AgentState }
  | { type: 'settings'; settings: Settings }
  | { type: 'hello'; at: number };
