// Shared between the server and the web app. Keep this file dependency-free.

export type ItemKind = 'user' | 'assistant' | 'card' | 'activity' | 'system';

export type CardType =
  | 'approval' // "Needs your OK": Approve / Not now
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
  /** The user tapped the entry's draft chip, which handed `draft` back to the agent to go ahead with as is. */
  used?: boolean;
}

/** Something the agent is keeping an eye on that doesn't need a decision; listed muted under a brief, never pushed. */
export interface WatchEntry {
  title: string;
  detail?: string;
}

/** A one-tap next step; tapping sends `message` to the main thread as the user. */
export interface FollowUp {
  label: string;
  message: string;
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
  task_id?: string;
  updated_label?: string; // e.g. "Updated 5:48 AM"
  /** "Pick it back up?" card offered after Hermes dropped a run mid-flight. */
  resume?: boolean;
  /** Agent session that receives the decision (Duet-tool cards). */
  session_id?: string;
  /** Set when the card mirrors a Hermes-native approval/clarify prompt on a live run. */
  hermes?: { kind: 'approval' | 'clarify'; run_id: string; request_id: string; generation: number };
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
  text?: string; // user / assistant / system
  streaming?: boolean;
  card?: CardData;
  activity?: ActivityData;
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
  | { type: 'agent'; agent: AgentState }
  | { type: 'settings'; settings: Settings }
  | { type: 'hello'; at: number };
