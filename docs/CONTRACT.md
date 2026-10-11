# PRISM internal contract (server ↔ web ↔ k8s MCP)

Types: `shared/types.ts`. Ports: web `:3000` (Next), API/WS `:7100` (Hono), k8s MCP `:7300` (port-forward), agentgateway `:7200`.

## Identity
Every request carries `x-prism-user: <user>` (the web app sends it; `?as=<user>` also accepted for the phone link). Demo users: `arnab` (owner), `judge` (member/approver). No passwords today.

## REST (`/api`, JSON)
| Method | Path | Body → Result |
|---|---|---|
| GET | `/api/me` | → `{ user }` |
| GET | `/api/connections` | → `ConnectionView[]` |
| POST | `/api/connections` | `{ name, url, token? }` → `ConnectionView` (connects, lists tools; 400 with `{error}` on failure) |
| DELETE | `/api/connections/:id` | → `{ ok }` |
| GET | `/api/workspaces` | → `{ id, title, owner }[]` (owned + member) |
| POST | `/api/workspaces` | `{ title? }` → `Workspace` |
| GET | `/api/workspaces/:id` | → `{ workspace, incidents, decisions, playbooks, stats }` |
| POST | `/api/workspaces/:id/compose` | `{ prompt }` → `{ summary, receipt, workspace }` (progress streams as `activity` WS messages) |
| POST | `/api/workspaces/:id/ops` | `{ baseVersion, ops: Op[] }` → `Workspace` (409 on stale version) |
| POST | `/api/workspaces/:id/members` | `{ user }` → `Workspace` |
| POST | `/api/workspaces/:id/panels/:pid/refresh` | → `{ data, at }` |
| POST | `/api/workspaces/:id/panels/:pid/actions` | `{ actionId, record }` → `Decision` (source `person`, pending) |
| POST | `/api/incidents/:id/investigate` | → `Decision` (manual trigger; normally automatic) |
| GET | `/api/decisions/:id` | → `{ decision, incident?, playbook? }` |
| POST | `/api/decisions/:id/approve` | → `Decision` (executes through the gateway with a signed approval) |
| POST | `/api/decisions/:id/reject` | `{ note? }` → `Decision` |
| POST | `/api/decisions/:id/playbook` | → `Playbook` (save as playbook; explicit) |
| POST | `/api/admin/reset` | `{ keepPlaybooks: boolean }` → `{ ok }` (clears incidents/decisions/stats) |

## WebSocket
`ws://localhost:7100/ws?ws=<workspaceId>&as=<user>` → `ServerMessage` (see types). On connect the server sends `workspace`, latest `panel-data` for each panel, open incidents, pending decisions, playbooks and `stats`.

## A2UI
- Catalog id `https://prism.dev/catalogs/prism/v0.1.json`. Components: basic catalog + `TimeSeries`, `MetricRow`, `DataTable`, `CardList`, `StatusList`.
- Panel surface = `createSurface` + `updateComponents(panel.components)` once; every `panel-data` becomes `updateDataModel { path: "/", value: data }`. The browser builds these messages; the server validates surfaces headlessly with the same catalog (`web/src/catalog/apis.ts`).
- Record actions: a component with `recordActions` dispatches A2UI action `{ name: "record-action", context: { actionId, record } }` → web POSTs `/panels/:pid/actions`.

## Catalog component props (zod `.strict()`; `DynamicValue` = literal or `{ "path": "/x" }`)
- `MetricRow { items: DynamicValue /* [{label, value, hint?, tone?: "ok"|"warn"|"bad"}] */, weight? }`
- `TimeSeries { title?, data: DynamicValue, x: string, series: [{key, label?}] (min 1), kind?: "line"|"bar"|"stacked-bar", weight? }`
- `DataTable { title?, rows: DynamicValue, columns: [{key, label}] (min 1), toneKey?: string, recordActions?, weight? }`
- `CardList { title?, items: DynamicValue, titleKey, subtitleKey?, badgeKey?, toneKey?, recordActions?, weight? }`
- `StatusList { title?, items: DynamicValue /* [{name, status, detail?, tone?}] */, recordActions?, weight? }`
- `tone` values: `ok` (green), `warn` (amber), `bad` (red). `toneKey` names the row field holding a tone.
- `recordActions` is injected by PRISM from `panel.actions` (`[{id,label,when?}]`), never written by the agent.

## k8s MCP server (`mcp-k8s`, stateless 2026-07-28, bearer `K8S_MCP_TOKEN`)
Read tools return `structuredContent` (and JSON text): `cluster_overview`, `list_deployments{namespace?}`, `list_pods{namespace?, problemsOnly?}`, `list_events{namespace?, type?, limit?}`, `get_pod_logs{namespace, pod, previous?, tailLines?}`, `get_usage{namespace?}`, `describe_deployment{namespace, name}` (image, revision history).
Write tools (`destructiveHint`, RBAC: only ns `shop`): `restart_deployment{namespace,name,dryRun?}`, `scale_deployment{namespace,name,replicas,dryRun?}`, `set_image{namespace,name,container?,image,dryRun?}`, `rollback_deployment{namespace,name,toRevision?,dryRun?}`.
