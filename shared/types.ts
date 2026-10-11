// PRISM shared contracts. Imported by server/ and web/ (type-only; no runtime deps).

export type User = string; // identity header value, e.g. "arnab", "judge"

export interface DiscoveredTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; title?: string };
}

/** What the browser sees for a connection. The token never leaves the server. */
export interface ConnectionView {
  id: string;
  name: string;
  url: string;
  status: 'ok' | 'error';
  error?: string;
  protocolVersion?: string;
  viaGateway: boolean;
  tools: DiscoveredTool[];
}

export interface Binding {
  connectionId: string;
  tool: string;
  args: Record<string, unknown>;
  /** JSONata over the tool result (structuredContent, else parsed text JSON). Its output is the A2UI data model. */
  transform: string;
}

export interface Layout { x: number; y: number; w: number; h: number }

/** Where a record action's argument comes from, resolved server-side. */
export type ArgSource = { record: string } | { value: unknown } | { user: true };

export interface RecordAction {
  id: string;
  label: string;          // "Restart", "Roll back"
  connectionId: string;
  tool: string;           // real MCP write tool name
  recordKey: string;      // field identifying a record, e.g. "name"
  args: Record<string, ArgSource>;
  when?: { key: string; equals: string | number | boolean };
}

export interface Panel {
  id: string;
  title: string;
  binding: Binding;
  /** A2UI v0.9 component list for this panel's surface. One component has id "root". */
  components: Record<string, unknown>[];
  layout: Layout;
  refreshSec: number;     // health panels 5–10 s
  actions?: RecordAction[];
  addedBy?: string;       // "Claude Code" when an external agent added it
}

/**
 * A watcher is checked on every refresh of its panel's binding, with no model call.
 * `condition` is JSONata over the RAW tool result and returns an array of findings
 * [{resource, reason, detail?}]; empty/undefined = healthy.
 */
export interface Watcher {
  id: string;
  panelId: string;
  title: string;          // "Pods failing to start"
  condition: string;
  severity: 'warning' | 'critical';
}

export interface Receipt {
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  ms: number;
}

export interface Workspace {
  id: string;
  owner: User;
  title: string;
  version: number;
  panels: Panel[];
  watchers: Watcher[];
  members: User[];        // can view + approve (e.g. "judge")
  buildReceipt?: Receipt; // what the initial composition cost
}

export type Op =
  | { op: 'add_panel'; panel: Panel }
  | { op: 'remove_panel'; panelId: string }
  | { op: 'move_resize'; panelId: string; layout: Layout }
  | { op: 'replace_view'; panelId: string; components: Record<string, unknown>[]; title?: string }
  | { op: 'update_binding'; panelId: string; binding: Binding }
  | { op: 'set_actions'; panelId: string; actions: RecordAction[] }
  | { op: 'watch'; watcher: Watcher }
  | { op: 'unwatch'; watcherId: string }
  | { op: 'rename_workspace'; title: string };

export type IncidentStatus = 'open' | 'investigating' | 'awaiting-approval' | 'resolving' | 'resolved';

export interface Incident {
  id: string;
  number: number;         // #1, #2 per workspace
  workspaceId: string;
  watcherId: string;
  resource: string;       // "shop/checkout-worker"
  reason: string;         // "ImagePullBackOff"
  detail?: string;
  signature: string;      // `${watcherId}|${resource}|${reason}`
  status: IncidentStatus;
  openedAt: string;
  resolvedAt?: string;
  decisionId?: string;
  receipt: Receipt;       // model cost spent on this incident (0 on playbook replay)
}

export interface ProposedAction {
  connectionId: string;
  tool: string;
  args: Record<string, unknown>;
  label: string;          // "Roll back checkout-worker to v1"
  consequences: string[]; // plain-language "What will happen"
}

export type DecisionStatus = 'pending' | 'approved' | 'rejected' | 'executed' | 'failed';

export interface Decision {
  id: string;
  workspaceId: string;
  incidentId?: string;
  title: string;
  summary: string;        // one paragraph, plain language
  rationale: string;
  evidence: Panel[];      // live A2UI evidence panels (bindings refresh like normal panels)
  proposedAction: ProposedAction;
  dryRun?: { ok: boolean; lines: string[] };
  source: 'agent' | 'playbook' | 'authored' | 'person';
  playbookId?: string;
  status: DecisionStatus;
  createdAt: string;
  decidedBy?: User;
  decidedAt?: string;
  note?: string;
  result?: { ok: boolean; text: string; gateway?: string };
  receipt: Receipt;
  matchMs?: number;       // playbook replay: time to instantiate
}

export interface Playbook {
  id: string;
  workspaceId: string;
  title: string;
  match: { watcherId: string; resource: string; reason: string };
  evidenceTemplate: Panel[];
  actionTemplate: ProposedAction;
  rationale: string;
  origin: { incidentId: string; incidentNumber: number; savedBy: User; approvedBy?: User; at: string; receipt: Receipt };
  uses: number;
}

export type ActivityKind = 'model' | 'tool' | 'validate' | 'gateway' | 'refresh' | 'incident' | 'decision' | 'playbook' | 'info' | 'error';

export interface Activity {
  id: string;
  workspaceId: string;
  at: string;
  kind: ActivityKind;
  text: string;
  detail?: unknown;
}

export interface Stats {
  refreshes: number;      // panel refreshes since build (all with 0 model calls)
  modelCalls: number;     // total model calls for this workspace
  costUsd: number;
}

/** Server → browser WebSocket messages (`/ws?ws=<workspaceId>&as=<user>`). */
export type ServerMessage =
  | { type: 'workspace'; workspace: Workspace }
  | { type: 'panel-data'; panelId: string; data: unknown; at: string; error?: string }
  | { type: 'activity'; item: Activity }
  | { type: 'incident'; incident: Incident }
  | { type: 'decision'; decision: Decision }
  | { type: 'playbook'; playbook: Playbook }
  | { type: 'stats'; stats: Stats }
  | { type: 'compose'; state: 'started' | 'done' | 'failed'; summary?: string; receipt?: Receipt };
