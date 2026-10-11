// Hi-res screenshots for the submission (2x desktop, 3x phone, JPEG to stay under 2 MB).
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
const ROOT = new URL('..', import.meta.url).pathname;
const OUT = new URL('./shots-hd/', import.meta.url).pathname;
const WEB = 'http://localhost:3001', API = 'http://localhost:7100/api';
const MAIN = 'ws-f35e1f6a', SHOP = 'ws-99ba1ee6', TEST = 'ws-1f6d76f4';
const sh = c => execSync(c, { cwd: ROOT, stdio: 'pipe' }).toString().trim();
const api = async (p, opts = {}) => (await fetch(API + p, { ...opts, headers: { 'content-type': 'application/json', 'x-prism-user': opts.user ?? 'arnab' } })).json();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms, every = 1500) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(every); } throw new Error('timeout'); };
const shot = (page, name, opts = {}) => page.screenshot({ path: OUT + name + '.jpg', type: 'jpeg', quality: 88, ...opts });
async function hold(page, loc) { await loc.scrollIntoViewIfNeeded(); const b = await loc.boundingBox(); await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.down(); await sleep(1400); await page.mouse.up(); }

const browser = await chromium.launch({ channel: 'chrome' });
const desk = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })).newPage();
await desk.addInitScript(() => localStorage.setItem('prism.user', 'arnab'));
const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
await phoneCtx.addInitScript(() => localStorage.setItem('prism.user', 'lead'));
const phone = await phoneCtx.newPage();

await api('/admin/auto-investigate', { method: 'POST', body: JSON.stringify({ on: false }) });
try {
  // 1 landing
  await desk.goto(WEB + '/', { waitUntil: 'networkidle' }); await sleep(1500); await shot(desk, '1-landing');
  // 2 Main Cluster, healthy, with Sentry + Nimble panels
  await desk.goto(`${WEB}/w/${MAIN}`); await sleep(7000); await shot(desk, '2-main-cluster');
  // 3 research report (Test workspace), cropped to the panel
  await desk.goto(`${WEB}/w/${TEST}`); await sleep(5000);
  const rs = desk.locator('.rs').first(); if (await rs.count()) await rs.screenshot({ path: OUT + '3-research.jpg', type: 'jpeg', quality: 88 });
  // 4 break → incident in Shop cluster → agent decision (manual investigate)
  sh('./scripts/reset.sh'); await sleep(2000);
  await desk.goto(`${WEB}/w/${SHOP}`); await sleep(4000);
  sh('./scripts/break.sh');
  const inc = await until(async () => (await api(`/workspaces/${SHOP}`)).incidents.find(i => i.status !== 'resolved'), 60000);
  await sleep(4000); await shot(desk, '4-incident');
  await api(`/incidents/${inc.id}/investigate`, { method: 'POST' });
  const d1 = await until(async () => (await api(`/workspaces/${SHOP}`)).decisions.find(d => d.status === 'pending' && d.source === 'agent'), 120000);
  await desk.goto(`${WEB}/decide/${d1.id}`); await sleep(5000); await shot(desk, '5-agent-decision');
  // approve on the phone, save playbook
  await phone.goto(`${WEB}/decide/${d1.id}?as=lead`); await sleep(4000);
  await hold(phone, phone.getByText('Hold to approve').first());
  await until(async () => (await api(`/decisions/${d1.id}`)).decision.status === 'executed', 40000);
  await api(`/decisions/${d1.id}/playbook`, { method: 'POST' });
  await until(async () => (await api(`/workspaces/${SHOP}`)).incidents.every(i => i.status === 'resolved'), 90000);
  // 6 second break → playbook replay on the phone
  sh('./scripts/reset.sh'); await sleep(2000);
  await phone.goto(`${WEB}/j/${SHOP}?as=lead`); await sleep(3000);
  sh('./scripts/break.sh');
  await phone.getByText('Approval needed').first().waitFor({ timeout: 60000 });
  await sleep(1500); await shot(phone, '6-phone-approval');
  const d2 = (await api(`/workspaces/${SHOP}`)).decisions.find(d => d.status === 'pending' && d.source === 'playbook');
  await phone.goto(`${WEB}/decide/${d2.id}?as=lead`); await sleep(4500); await shot(phone, '7-phone-replay');
  await desk.goto(`${WEB}/decide/${d2.id}`); await sleep(4500); await shot(desk, '8-replay-desktop');
  await hold(phone, phone.getByText('Hold to approve').first());
  await until(async () => (await api(`/decisions/${d2.id}`)).decision.status === 'executed', 40000);
  await sleep(4000); await shot(phone, '9-phone-done');
} finally {
  try { sh('./scripts/heal.sh'); } catch {}
  await sleep(20000);
  try { sh('./scripts/reset.sh'); } catch {}
  await api('/admin/auto-investigate', { method: 'POST', body: JSON.stringify({ on: true }) });
  await browser.close();
}
console.log('done');
