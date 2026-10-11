// Connection credentials are sealed at rest with AES-256-GCM keyed from PRISM_SECRET.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config } from './config.ts';

const key = () => {
  if (config.secret.length < 16) throw new Error('PRISM_SECRET must be set (openssl rand -hex 32)');
  return createHash('sha256').update(config.secret).digest();
};

export function seal(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), body].map(b => b.toString('base64url')).join('.');
}

export function open(sealed: string): string {
  const [iv, tag, body] = sealed.split('.').map(s => Buffer.from(s, 'base64url'));
  const d = createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]).toString('utf8');
}
