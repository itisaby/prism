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
    tracesSampleRate: 1.0,
    integrations: [Sentry.anthropicAIIntegration({ recordInputs: true, recordOutputs: true })],
  });
  console.log('Sentry on (AI agent monitoring + errors)');
}
