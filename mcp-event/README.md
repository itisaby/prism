# mcp-event: hackathon ops MCP server

The ops data for today's AI Engineer NYC hackathon: teams, mentors, help requests, check-ins, volunteer tasks, the judging queue and the schedule. It is a stateless MCP server (protocol 2026-07-28, with the 2025 stateless fallback) at `http://127.0.0.1:7101/mcp`.

- All data lives in memory. It is seeded the same way every time, relative to when the process started.
- A built-in simulation makes the floor feel live. Every 10 s it adds 1–2 check-ins. Now and then it adds a help request, closes a long mentor session or moves a team's project forward.
- Waiting times on open help requests grow in real time.
- At seed time exactly one request has been waiting about 7 minutes (#7 TrailMix, "RAG eval", tone `warn`), and Priya (RAG) is free to take it.

## Run

```bash
npm install
npx tsc -p .                       # typecheck
npx tsx src/index.ts               # PORT=7101 by default
nohup npx tsx src/index.ts > ../data/event.log 2>&1 &   # background
```

Environment:

| Variable | Effect |
|---|---|
| `PORT` | Listen port (default `7101`) |
| `MCP_TOKEN` | Optional. When set, `/mcp` and `/admin/*` require `Authorization: Bearer <token>`. When unset, there is no auth. |

## Endpoints

| Method | Path | What it does |
|---|---|---|
| ALL | `/mcp` | The MCP endpoint. A fresh `McpServer` is built per request via `createMcpHandler`. |
| GET | `/healthz` | `{ ok, checkedIn, openHelpRequests, seededAt }` |
| POST | `/admin/reset` | Reseeds all data |
| POST | `/admin/spike` | Adds 3 open help requests that all need **MCP**, aged 12, 11 and 8 min, so a PRISM watcher fires. Kenji (MCP) is busy and Diego (MCP) is free. |

## Tools

Every tool returns `structuredContent` and declares an `outputSchema`. Row fields named `tone` take the values `ok`, `warn` or `bad`.

**Read tools** (`readOnlyHint`):

| Tool | Returns |
|---|---|
| `event_overview` | `items` for a MetricRow: checked in vs 420 expected, open help requests, longest wait, teams demo-ready, mentors free, tasks unclaimed |
| `list_teams{track?}` | Teams with track, table, members, projectStatus and needsMentor |
| `list_help_requests{status?}` | Requests with `waitingMinutes` and `availableMentors`. Tone is `bad` when open over 10 min and `warn` when open over 5 min. |
| `list_mentors{available?}` | Mentors with skills, available/busy and their current request |
| `get_checkins` | `rows: {hour, count, cumulative}` for a TimeSeries |
| `list_tasks{status?}` | Volunteer tasks with owner and `version` |
| `list_judging{judge?}` | Judging slots from 15:00, toned by the team's project status |
| `get_schedule` | Agenda items marked past, now or upcoming |

**Write tools** (`destructiveHint`):

- Every write tool accepts `dryRun` and returns `{ ok, dryRun, changes[], summary }`.
- A failed write returns `isError` with a plain-language conflict message, and nothing is changed.

| Tool | Notes |
|---|---|
| `assign_mentor{requestId, mentorId, dryRun?}` | Fails if the mentor is busy (it names free mentors with the needed skill) or if the request is not open |
| `resolve_help_request{requestId, dryRun?}` | The mentor becomes available again |
| `claim_task{taskId, owner, expectedVersion?, dryRun?}` | Moves the task from todo to doing. Fails if someone else owns it or the version is stale. |
| `update_task_status{taskId, status, expectedVersion?, dryRun?}` | Setting `todo` also unassigns the task |
| `create_task{title, area, dryRun?}` | Adds a new unclaimed task |

## Probe

```bash
npx tsx scripts/probe.ts                                   # negotiated protocol + tool list
npx tsx scripts/probe.ts event_overview
npx tsx scripts/probe.ts assign_mentor '{"requestId":7,"mentorId":"priya","dryRun":true}'
```

Probe environment variables:

| Variable | Effect |
|---|---|
| `EVENT_MCP_URL` | Server URL to probe |
| `EVENT_MCP_TOKEN` | Optional bearer token |
| `COMPACT=1` | Print one-line JSON |
| `PROBE_LEGACY=1` | Use the 2025 handshake |
