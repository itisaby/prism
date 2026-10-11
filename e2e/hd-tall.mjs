import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
const ROOT = new URL('..', import.meta.url).pathname, OUT = new URL('./shots-hd/', import.meta.url).pathname;
const WEB = 'http://localhost:3001', API = 'http://localhost:7100/api', MAIN = 'ws-f35e1f6a', SHOP = 'ws-99ba1ee6';
const sh = c => execSync(c, { cwd: ROOT, stdio: 'pipe' }).toString().trim();
const api = async (p, o = {}) => (await fetch(API + p, { ...o, headers: { 'content-type': 'application/json', 'x-prism-user': 'arnab' } })).json();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(1500); } throw new Error('timeout'); };
const b = await chromium.launch({ channel: 'chrome' });
const ctx = await b.newContext({ viewport: { width: 1440, height: 2050 }, deviceScaleFactor: 2 });
await ctx.addInitScript(() => localStorage.setItem('prism.user', 'arnab'));
const p = await ctx.newPage();
const hideChat = () => p.addStyleTag({ content: '.chatbar, [class*="chat-bar"], [class*="chatbar"]{display:none !important}' });
await api('/admin/auto-investigate', { method: 'POST', body: JSON.stringify({ on: false }) });
try {
  await p.goto(`${WEB}/w/${MAIN}`); await sleep(9000); await hideChat(); await sleep(500);
  await p.screenshot({ path: OUT + 'A-main-cluster-full.jpg', type: 'jpeg', quality: 82 });
  sh('./scripts/break.sh');
  await p.goto(`${WEB}/w/${SHOP}`);
  await until(async () => (await api(`/workspaces/${SHOP}`)).incidents.find(i => i.status !== 'resolved'), 60000);
  await sleep(8000); await hideChat(); await sleep(500);
  await p.screenshot({ path: OUT + 'B-incident-full.jpg', type: 'jpeg', quality: 82 });
} finally {
  try { sh('./scripts/heal.sh'); } catch {}
  await sleep(15000); try { sh('./scripts/reset.sh'); } catch {}
  await api('/admin/auto-investigate', { method: 'POST', body: JSON.stringify({ on: true }) });
  await b.close();
}
console.log('done');
