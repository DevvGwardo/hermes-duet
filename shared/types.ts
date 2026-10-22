// Shared between the server and the web app. Keep this file dependency-free.

export type ItemKind = 'user' | 'assistant' | 'card' | 'activity' | 'system';

export type CardType =
  | 'approval' // "Needs your OK": Approve / Not now
  | 'choice' // a question with fixed options
  | 'brief' // morning brief / check-in digest
  | 'checklist'
  | 'metrics'
  | 'file'
  | 'note';

export type CardStatus = 'pending' | 'approved' | 'declined' | 'answered' | 'expired' | 'info';

export interface BriefEntry {
  title: string;
  detail?: string;
  priority?: 'high' | 'medium' | 'low';
  /** Optional one-tap follow-up; tapping sends this text as a user message. */
  action_label?: string;
  action_message?: string;
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
  options?: string[]; // choice
  entries?: BriefEntry[]; // brief
  checklist?: ChecklistEntry[]; // checklist
  metrics?: MetricEntry[]; // metrics
  file_id?: string; // file
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
  created_at: number;
  updated_at: number;
  background: boolean;
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

export interface Snapshot {
  items: Item[];
  has_more: boolean;
  /** Every pending card, including ones older than the `items` page. */
  pending: Item[];
  tasks: Task[];
  files: FileEntry[];
  settings: Settings;
  agent: AgentState;
  push_enabled: boolean;
}

export type ServerEvent =
  | { type: 'item'; item: Item }
  | { type: 'delta'; item_id: string; text: string }
  | { type: 'task'; task: Task }
  | { type: 'file'; file: FileEntry }
  | { type: 'agent'; agent: AgentState }
  | { type: 'settings'; settings: Settings }
  | { type: 'hello'; at: number };
