// Loaded with `tsx --import ./src/instrument.ts` so Sentry can instrument the Anthropic SDK before it is imported.
// Sentry AI Agent Monitoring then shows every model call; playbook replays show up with zero LLM spans.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Sentry from '@sentry/node';

const envFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT || 'hackathon',
    // Keep agent runs, approvals and playbook replays (and everything inside them); drop the
    // every-few-seconds panel refresh traffic, which would bury them.
    tracesSampler: ({ name, parentSampled }) => {
      if (parentSampled !== undefined) return parentSampled;
      return /^(invoke_agent|approve decision|replay playbook)/.test(name) ? 1 : 0;
    },
    integrations: [Sentry.anthropicAIIntegration({ recordInputs: true, recordOutputs: true })],
    // Expected client errors (bad ids, not the owner, stale versions, validation) are answered with 4xx; they aren't bugs.
    beforeSend(event, hint) {
      const name = (hint?.originalException as Error | undefined)?.constructor?.name;
      return name && ['BadRequest', 'Forbidden', 'Conflict', 'Invalid'].includes(name) ? null : event;
    },
  });
  console.log('Sentry on (AI agent monitoring + errors)');
}
