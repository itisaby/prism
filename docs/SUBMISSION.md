# MLH submission — AI Engineer NYC 2026

Draft project: "PRISM — the harness learns, the model rests" (filled via DevRelay: pitch, description, 24 technologies,
AI tools, public repo, live demo, 6 screenshots). Missing: demo video (required by MLH to submit).
Prize category answers are sent when the project enters each category, which MLH allows only after submission.

## Best Overall — why is your project a fit?
Agents can now use any tool through MCP, but when they need a human they send a paragraph, and every repeat costs the same model calls again. PRISM is an agent harness that compiles what agents figure out into things that keep running without the model. One sentence builds a live A2UI workspace over your MCP servers. Watchers open incidents, and an event-driven agent investigates, then sends a person a decision surface (live evidence, one proposed fix, a real dry run) instead of a paragraph. Approval is signed and enforced at agentgateway before any write. If you correct the agent, it resumes and learns your fix. The next identical incident replays in ~25 ms with zero model calls: $0.35 the first time, $0.00 after. It's live across six sources (Kubernetes, GitHub, Stripe, Sentry, Nimble and an event DB), approvable from a phone, and tested end to end with Playwright.

## Best Use of Sentry (and Raffle) — why is your project a fit?
Sentry is how we see what PRISM's agents actually do, and we used all four tools. AI Agent Monitoring: every agent run is traced as invoke_agent → chat claude-opus-5-5 → execute_tool with tokens; playbook replays show zero LLM spans, our core claim (the model rests) visible in Sentry. Error monitoring & tracing: the SDK caught a real crash in our agent harness, and agentgateway's traces reach Sentry via an OpenTelemetry Collector; logs and metrics (prism.panel.refresh vs prism.model.calls) show refreshes climbing while model calls stay flat. Sentry MCP: connected to our coding agent to triage, fix and resolve that crash, and it's also a PRISM data source (issues with a human-approved Resolve). Seer: found the root cause (unvalidated tool input from the model), which led us to add schema validation for every agent tool call.

## Best Use of Nimble — why is your project a fit?
Nimble is PRISM's live-web source, through Nimble's hosted MCP, and it covers all three things Nimble asks for. Search the live web: PRISM's agents call Nimble Search while building workspaces and investigating incidents, so their answers use current information. Turn websites into data: one sentence turns a page into a live panel. For example, githubstatus.com becomes a component-status table through Nimble Extract and a JSONata transform, with a watcher that opens an incident if anything degrades, and it refreshes with zero model calls. Give your AI more context: Nimble Web Search Agents run deep research that PRISM tracks and renders as a live panel: progress, then a cited report with per-claim confidence and primary/secondary sources (13 claims, 13 sources in our demo). The investigate agent can attach that research as live evidence on the decision a person approves, and our cluster workspace uses it for CVE research on running images.

## Skipped
Gemini API, Tiger Data, Snowflake — not used by PRISM.
