# agentregistry (discovery layer)

PRISM's catalog of MCP servers runs on [agentregistry](https://github.com/agentregistry-dev/agentregistry) v0.4.0. The "Add MCP" dialog lists the catalog through `GET /api/registry?q=` (see `server/src/registry.ts`).

```bash
infra/registry/setup.sh          # install arctl, start the registry, apply servers.yaml, smoke test (safe to re-run)
infra/registry/setup.sh status   # health check and catalog list
infra/registry/setup.sh stop     # stop the containers (data is kept)
```

- UI: http://localhost:12121. API docs: http://localhost:12121/docs
- MCP Registry v0.1 API (what PRISM reads): http://localhost:12121/v0.1/servers (`?search=` matches the name only)
- CLI: `infra/registry/bin/arctl get mcps` (gitignored and pinned; setup.sh downloads it and checks its sha256)
- Server: `AGENT_REGISTRY_URL` (default `http://localhost:12121`). `searchRegistry(q)` has a 3 s timeout and returns `[]` on any error, so the dialog's tab hides itself.

## Catalog
`servers.yaml` holds `ar.dev/v1alpha1` `MCPServer` resources. Re-running `arctl apply` updates them in place. Key tool names go in the `prism.dev/tools` annotation. The v0.1 API leaves annotations out, so `registry.ts` reads them separately from `/v0/mcpservers`, server-side, and keeps only that annotation.

**Never put credentials in remote `headers`.** The v0.1 API returns them verbatim. Auth is added by PRISM and agentgateway.

## Containers
setup.sh reuses `agentregistry-server` and `agent-registry-postgres` (API on 127.0.0.1:12121, compat API on). If they don't exist, it creates `prism-ar-server` and `prism-ar-postgres` instead. It never deletes containers, images or volumes.

If the registry is unhealthy after a reboot (the server started before Postgres), run `docker restart agentregistry-server`. setup.sh tries this once on its own.
