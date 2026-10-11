# PRISM Kubernetes source (minikube `prism`)

An MCP server running inside the cluster (`mcp-k8s/`, ns `prism-system`), stateless MCP 2026-07-28 (2025 clients also work), bearer `K8S_MCP_TOKEN`.

## Setup
```bash
infra/k8s/setup.sh                                          # idempotent
nohup infra/k8s/forward.sh > data/forward.log 2>&1 &        # http://127.0.0.1:7300/mcp
cd mcp-k8s && npx tsx scripts/probe.ts                      # list tools (token read from .env)
npx tsx scripts/probe.ts list_pods '{"problemsOnly":true}'  # call a tool
```
`setup.sh` starts the minikube profile (with metrics-server) if needed, builds `prism/checkout:v1` and `prism/k8s-mcp:dev` into minikube, applies `apps.yaml` + `mcp.yaml`, and syncs the secret `prism-system/k8s-mcp-token` from `K8S_MCP_TOKEN` in `.env` (it generates and saves a token if the line is empty; the token is never printed). Running it also resets `checkout-worker` to `v1`.

`forward.sh` checks `/healthz` through the tunnel every 5 s and reconnects. `kubectl port-forward` stays pinned to a pod that no longer exists after a rollout.

PRISM server: connect `http://127.0.0.1:7300/mcp` with the token, and run with `PRISM_ALLOW_LOCAL_MCP=1`.

Rebuild after code changes: `minikube -p prism image build -t prism/k8s-mcp:dev mcp-k8s && kubectl --context prism -n prism-system rollout restart deploy/k8s-mcp` (or rerun `setup.sh`).

## Break / heal
- `scripts/break.sh` sets `shop/checkout-worker` to `prism/checkout:v2-bad`, a tag that doesn't exist. The new pod shows `ImagePullBackOff` in about 3 s. The two old v1 pods keep running (`maxUnavailable: 0`), and the deployment reports `Degraded`.
- `scripts/heal.sh` sets the image back to `prism/checkout:v1` and waits for the rollout.

## Workloads
- `shop`: storefront and cart-api (podinfo, 2 each), redis, checkout-worker (2, busybox script that logs orders), load-gen (curl loop).
- `payments`: ledger.

## RBAC
- ClusterRole `prism-k8s-mcp-read`: read access to namespaces, nodes, pods, logs, events, services, endpoints(lices), deployments, replicasets and metrics.
- Role `prism-k8s-mcp-operate`, in `shop` only: patch/update deployments, patch `deployments/scale`.
- A write anywhere else returns `Kubernetes RBAC denied this: PRISM may not patch deployments/scale in namespace payments. Nothing was changed.`

## Tools
All tools return `structuredContent` with an `outputSchema`. Rows are flat and carry `tone` (`ok`, `warn` or `bad`). System namespaces are hidden unless you pass `includeSystem` or name the namespace.

| Tool | Args | Returns |
|---|---|---|
| `cluster_overview` | `includeSystem?` | counts, `degradedDeployments`, `problemPods`, CPU/mem, `items` (MetricRow-ready) |
| `list_deployments` | `namespace?, includeSystem?` | `deployments[] {namespace,name,ready,desired,available,image,revision,status: Healthy/Degraded/Progressing}` |
| `list_pods` | `namespace?, includeSystem?, problemsOnly?` | `pods[] {namespace,name,app,phase,ready:"1/1",restarts,reason,rawReason,image,node,age}` |
| `list_events` | `namespace?, includeSystem?, type?, limit?` | `events[] {time:"HH:MM:SS",type,reason,object,message,count}` newest first |
| `get_pod_logs` | `namespace, pod, container?, previous?, tailLines?` | `lines[]`; `pod` may be a deployment name; pods that never started give `note` |
| `get_usage` | `namespace?, includeSystem?` | `apps[]`, `pods[]`, `nodes[]` (with %), `totals` |
| `get_usage_history` | `namespace?, includeSystem?, minutes?` | `rows[] {time, <app>: millicores}` + `series[]` (15 s samples, 1 h, in memory) |
| `describe_deployment` | `namespace, name` | image, revision, conditions, `revisions[] {revision,image,replicaSet,current}`, `previousRevision/Image`, pods, events |
| `set_image` | `namespace, name, container?, image, dryRun?` | `{ok, dryRun, changes[], summary}` |
| `rollback_deployment` | `namespace, name, toRevision?, dryRun?` | same, e.g. `image prism/checkout:v2-bad → prism/checkout:v1`, `revision 4 → 5` |
| `restart_deployment` | `namespace, name, dryRun?` | same |
| `scale_deployment` | `namespace, name, replicas (0–10), dryRun?` | same, e.g. `replicas 2 → 3` |

`dryRun` sends `?dryRun=All`: the API server validates the change, including RBAC, and nothing is persisted. Pod `reason` is kept stable: `ErrImagePull` is reported as `ImagePullBackOff`, and `Error` after restarts as `CrashLoopBackOff`. The kubelet's raw value is in `rawReason`.
