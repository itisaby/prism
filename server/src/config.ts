import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const envFile = path.join(ROOT, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const dataDir = path.join(ROOT, 'data');
mkdirSync(dataDir, { recursive: true });

const num = (v: string | undefined, d: number) => (v && !Number.isNaN(Number(v)) ? Number(v) : d);

export const config = {
  port: num(process.env.PORT, 7100),
  dbPath: process.env.PRISM_DB ?? path.join(dataDir, 'prism.db'),
  model: process.env.PRISM_MODEL || 'claude-opus-5-5',
  effort: (process.env.PRISM_EFFORT || 'medium') as 'low' | 'medium' | 'high',
  hasAnthropicKey: !!process.env.ANTHROPIC_API_KEY || !!process.env.PRISM_LLM_GATEWAY_URL,
  llmGatewayUrl: process.env.PRISM_LLM_GATEWAY_URL || undefined,
  gatewayUrl: process.env.PRISM_GATEWAY_URL?.replace(/\/$/, '') || undefined,
  allowLocalMcp: process.env.PRISM_ALLOW_LOCAL_MCP === '1',
  secret: process.env.PRISM_SECRET ?? '',
  k8sMcpUrl: process.env.K8S_MCP_URL || 'http://localhost:7300/mcp',
  k8sToken: process.env.K8S_MCP_TOKEN || '',
  eventMcpUrl: process.env.EVENT_MCP_URL || 'http://localhost:7101/mcp',
  eventToken: process.env.EVENT_MCP_TOKEN || '',
  githubToken: process.env.GITHUB_TOKEN || '',
  stripeKey: process.env.STRIPE_SECRET_KEY || '',
  stripeViaGateway: process.env.STRIPE_VIA_GATEWAY === '1',
  nimbleKey: process.env.NIMBLE_API_KEY || '',
  // USD per million tokens (estimate; override if pricing differs).
  price: {
    input: num(process.env.PRISM_PRICE_INPUT, 5),
    output: num(process.env.PRISM_PRICE_OUTPUT, 25),
    cacheRead: num(process.env.PRISM_PRICE_CACHE_READ, 0.5),
    cacheWrite: num(process.env.PRISM_PRICE_CACHE_WRITE, 6.25),
  },
  keysDir: path.join(ROOT, 'server', 'keys'),
  jwksPath: path.join(ROOT, 'infra', 'gateway', 'approval-jwks.json'),
};
