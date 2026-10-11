# PRISM — the harness learns, the model rests

**When an agent needs a human, it shouldn't send a paragraph. It should send an interface. And the second time, it shouldn't need the model at all.**

PRISM is an agent harness for MCP. It compiles what agents figure out into things that keep running without the model:

| Artifact | What it is | Model calls when it runs |
|---|---|---|
| **Panels** | A2UI v0.9 surfaces + bindings `{server, tool, args, JSONata}` refreshed straight from MCP tools | 0 |
| **Watchers** | JSONata conditions checked on every refresh; open incidents | 0 |
| **Decision surfaces** | What an agent sends a person: live evidence, one proposed write with exact args, a Kubernetes dry run, Approve | 0 to show; the agent wrote it once |
| **Playbooks** | A decision a person approved and chose to keep; replays on the same incident | 0 |
| **Approval-bound writes** | ES256 token over tool + exact arguments, verified by agentgateway CEL before the write reaches the server | 0 |

The model runs only when something genuinely new happens: composing a workspace from one sentence, or investigating an incident no playbook covers. The investigate agent is event-driven: woken by an incident, it runs a bounded tool loop and ends its turn by proposing a decision. While the decision waits there is no process and no tokens — just a row.

## Architecture
```
 people (desktop, phone via tunnel)          agents (Claude Code via PRISM MCP — stretch)
            │  Next.js + A2UI renderer (web/ :3000)
            ▼
 PRISM server (server/ :7100) ── composer + investigator (claude-opus-5-5, effort medium)
   runtime: bindings → MCP → JSONata → A2UI data model → WS      watchers → incidents → playbook | agent → decision
            │  MCP SDK v2, stateless 2026-07-28
            ▼
 agentgateway v1.6.0 (:7200) — reads allow-listed; writes need a signed approval (CEL)
            ▼
 Kubernetes MCP server (mcp-k8s/, in-cluster, RBAC: writes only in ns shop)
```

## Run
```bash
cp .env.example .env            # add ANTHROPIC_API_KEY; PRISM_SECRET: openssl rand -hex 32
infra/k8s/setup.sh              # minikube profile "prism", demo apps, k8s MCP server, writes K8S_MCP_TOKEN
(cd server && npm i) && (cd web && npm i)
scripts/dev.sh                  # port-forward, agentgateway, API, web
open http://localhost:3000
```
Demo controls: `scripts/break.sh` (bad image on checkout-worker), `scripts/heal.sh`, `scripts/reset.sh [--all]`.

## Security model
- Connection tokens are sealed at rest (AES-256-GCM) and never sent to the browser or logs. User-added MCP URLs must be https and public (SSRF guard) unless `PRISM_ALLOW_LOCAL_MCP=1`.
- Tool descriptions and results are untrusted data. Panels can only bind read tools; transforms and watcher conditions are JSONata (no code execution); the A2UI catalog is strict.
- No write runs without a per-person approval signed over the tool and exact arguments; the gateway verifies it. PRISM re-runs the dry run right before executing and enforces single use (the gateway can't enforce `jti` within the 30 s token window).
- Kubernetes RBAC is the last line: the MCP server's ServiceAccount can only patch deployments in `shop`.

## Production path (not built today)
MCP OAuth instead of bearer tokens, real auth (WorkOS/Clerk), Postgres, emitting workspaces as MCP Apps, personal views over shared data (copy-on-write A2UI surfaces fed by one shared fetch).
