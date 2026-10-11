// Approval tokens: ES256 JWT bound to the approver, the tool and the exact arguments, checked by agentgateway CEL.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { exportJWK, generateKeyPair, importJWK, SignJWT, type JWK } from 'jose';
import { config } from './config.ts';

const PRIVATE = path.join(config.keysDir, 'approval-private.jwk.json');
export const APPROVAL = { issuer: 'prism', audience: 'agentgateway', ttlSeconds: 30 } as const;
let key: { key: CryptoKey | Uint8Array; kid: string } | undefined;

export async function initApprovalKeys() {
  if (!existsSync(PRIVATE)) {
    const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
    const kid = `prism-${Date.now().toString(36)}`;
    mkdirSync(path.dirname(PRIVATE), { recursive: true });
    writeFileSync(PRIVATE, JSON.stringify({ ...(await exportJWK(privateKey)), kid, alg: 'ES256' }), { mode: 0o600 });
    mkdirSync(path.dirname(config.jwksPath), { recursive: true });
    writeFileSync(config.jwksPath, JSON.stringify({ keys: [{ ...(await exportJWK(publicKey)), kid, alg: 'ES256', use: 'sig' }] }, null, 2));
  }
  const jwk = JSON.parse(readFileSync(PRIVATE, 'utf8')) as JWK & { kid: string };
  key = { key: await importJWK(jwk, 'ES256'), kid: jwk.kid };
}

/**
 * `argsBody` is the exact JSON fragment the MCP client puts on the wire for these arguments,
 * so the gateway can require `string(request.body).contains(jwt.argsBody)`.
 */
export async function signApproval(input: { user: string; decisionId: string; tool: string; args: Record<string, unknown> }) {
  if (!key) await initApprovalKeys();
  return new SignJWT({ tool: input.tool, argsBody: `"arguments":${JSON.stringify(input.args)}` })
    .setProtectedHeader({ alg: 'ES256', kid: key!.kid })
    .setIssuer(APPROVAL.issuer).setAudience(APPROVAL.audience).setSubject(input.user).setJti(input.decisionId)
    .setIssuedAt().setExpirationTime(`${APPROVAL.ttlSeconds}s`)
    .sign(key!.key);
}
