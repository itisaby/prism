// End-to-end check of the PRISM demo in a real browser (Playwright + local Chrome).
// Usage: node demo.mjs [--skip-agent]   (--skip-agent keeps the saved playbook and only runs the replay beat)
// Needs the stack running (scripts/dev.sh) and workspace ids in ../data/{k8s-ws,event-ws}.
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';

const WEB = process.env.PRISM_WEB ?? 'http://localhost:3000';
const API = 'http://localhost:7100/api';
const ROOT = new URL('..', import.meta.url).pathname;
const SHOTS = new URL('./screenshots/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });
const K8S = readFileSync(ROOT + 'data/k8s-ws', 'utf8').trim();
const EVENT = readFileSync(ROOT + 'data/event-ws', 'utf8').trim();
const skipAgent = process.argv.includes('--skip-agent');

const results = [];
const sh = cmd => execSync(cmd, { cwd: ROOT, stdio: 'pipe' }).toString().trim();
const api = async (path, user = 'arnab') => (await fetch(API + path, { headers: { 'x-prism-user': user } })).json();
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function step(name, fn) {
  const t0 = Date.now();
  try { const note = await fn(); results.push({ name, ok: true, ms: Date.now() - t0, note }); console.log(`✔ ${name}${note ? ` — ${note}` : ''}`); }
  catch (e) { results.push({ name, ok: false, ms: Date.now() - t0, note: e.message.split('\n')[0] }); console.log(`✘ ${name} — ${e.message.split('\n')[0]}`); }
}

function watch(page, label) {
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(`${label} console: ${m.text().slice(0, 200)}`); });
  page.on('pageerror', e => errors.push(`${label} pageerror: ${e.message.slice(0, 200)}`));
  page.on('requestfailed', r => { if (!r.url().includes('_next/webpack-hmr')) errors.push(`${label} requestfailed: ${r.url()} ${r.failure()?.errorText}`); });
  return errors;
}

async function hold(page, locator, ms = 1400) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await sleep(ms);
  await page.mouse.up();
}

async function waitFor(fn, timeoutMs, everyMs = 1500) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(everyMs); }
  throw new Error(`timed out after ${timeoutMs / 1000}s`);
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await desktop.addInitScript(() => localStorage.setItem('prism.user', 'arnab'));
const page = await desktop.newPage();
const errors = watch(page, 'desktop');

// ------------------------------------------------------------------ 1 landing
await step('Landing renders the pitch and prompt box', async () => {
  await page.goto(WEB + '/', { waitUntil: 'networkidle' });
  await page.getByText('The harness learns').first().waitFor({ timeout: 15000 });
  await page.getByRole('textbox', { name: 'Describe your workspace' }).waitFor();
  await page.getByText('Build my workspace').first().waitFor();
  await page.screenshot({ path: SHOTS + '01-landing.png' });
});

// ------------------------------------------------------------------ 2 cluster workspace, live, no model
await step('Cluster workspace renders live panels from Kubernetes', async () => {
  await page.goto(`${WEB}/w/${K8S}`, { waitUntil: 'domcontentloaded' });
  const w = (await api(`/workspaces/${K8S}`)).workspace;
  for (const p of w.panels) await page.getByText(p.title, { exact: false }).first().waitFor({ timeout: 20000 });
  await page.getByText('storefront').first().waitFor({ timeout: 20000 });
  await page.screenshot({ path: SHOTS + '02-cluster-workspace.png' });
  return `${w.panels.length} panels: ${w.panels.map(p => p.title).join(', ')}`;
});

await step('Panels keep refreshing with 0 model calls', async () => {
  const a = await api(`/workspaces/${K8S}`);
  await sleep(12000);
  const b = await api(`/workspaces/${K8S}`);
  if (b.stats.refreshes <= a.stats.refreshes) throw new Error(`refreshes did not increase (${a.stats.refreshes} → ${b.stats.refreshes})`);
  if (b.stats.modelCalls !== a.stats.modelCalls) throw new Error(`model calls changed during refresh (${a.stats.modelCalls} → ${b.stats.modelCalls})`);
  const chip = await page.getByText(/model call/i).first().textContent();
  return `refreshes ${a.stats.refreshes} → ${b.stats.refreshes}, model calls unchanged at ${b.stats.modelCalls}; chip: “${chip?.trim().slice(0, 90)}”`;
});

await step('Inspector shows the activity feed', async () => {
  await page.getByText('Inspector').first().click();
  await page.getByLabel('Close inspector').waitFor({ timeout: 5000 });
  await page.screenshot({ path: SHOTS + '03-inspector.png' });
  await page.getByLabel('Close inspector').click();
});

// ------------------------------------------------------------------ 3 event workspace + record action → decision
await step('Event workspace renders and Assign mentor creates a decision', async () => {
  sh('curl -fsS -X POST localhost:7101/admin/reset >/dev/null');
  const w = (await api(`/workspaces/${EVENT}`)).workspace;
  for (const p of w.panels) await fetch(`${API}/workspaces/${EVENT}/panels/${p.id}/refresh`, { method: 'POST', headers: { 'x-prism-user': 'arnab' } });
  await page.goto(`${WEB}/w/${EVENT}`, { waitUntil: 'domcontentloaded' });
  for (const p of w.panels) await page.getByText(p.title, { exact: false }).first().waitFor({ timeout: 20000 });
  await page.screenshot({ path: SHOTS + '04-event-workspace.png' });
  const btn = page.getByRole('button', { name: /assign/i }).first();
  await btn.waitFor({ timeout: 20000 });
  await btn.click();
  await page.waitForURL(/\/decide\//, { timeout: 20000 });
  await page.getByText('Hold to approve').first().waitFor({ timeout: 15000 });
  await page.screenshot({ path: SHOTS + '05-event-decision.png' });
  await hold(page, page.getByText('Hold to approve').first());
  const id = page.url().split('/decide/')[1].split('?')[0];
  const d = await waitFor(async () => { const r = (await api(`/decisions/${id}`)).decision; return ['executed', 'failed'].includes(r.status) && r; }, 30000);
  await page.screenshot({ path: SHOTS + '06-event-done.png' });
  if (d.status !== 'executed') throw new Error(`decision ${d.status}: ${d.result?.text}`);
  return `${d.title} → ${d.result.text}`;
});

// ------------------------------------------------------------------ 4 incident #1: agent investigates
if (!skipAgent) {
  await step('Break #1: watcher opens an incident and the agent sends a decision', async () => {
    sh('./scripts/reset.sh --all');
    await page.goto(`${WEB}/w/${K8S}`, { waitUntil: 'domcontentloaded' });
    await page.getByText('storefront').first().waitFor({ timeout: 20000 });
    sh('./scripts/break.sh');
    const t0 = Date.now();
    await page.getByText(/Incident #\d/).first().waitFor({ timeout: 45000 });
    await page.screenshot({ path: SHOTS + '07-incident-banner.png' });
    const opened = ((Date.now() - t0) / 1000).toFixed(1);
    const banner = page.locator('a.banner').first();
    await banner.waitFor({ timeout: 90000 });
    await page.screenshot({ path: SHOTS + '08-decision-waiting.png' });
    return `incident visible after ${opened}s; decision link after ${((Date.now() - t0) / 1000).toFixed(1)}s`;
  });

  await step('Decision surface shows evidence, dry run and exact request; hold to approve heals the cluster', async () => {
    await page.locator('a.banner').first().click();
    await page.waitForURL(/\/decide\//);
    await page.getByText('Hold to approve').first().waitFor({ timeout: 15000 });
    await page.getByText(/prism\/checkout:v1/).first().waitFor({ timeout: 15000 });
    await waitFor(async () => (await page.getByText('Loading…').count()) === 0, 15000, 500);
    await page.screenshot({ path: SHOTS + '09-decision-agent.png', fullPage: true });
    await hold(page, page.getByText('Hold to approve').first());
    const id = page.url().split('/decide/')[1].split('?')[0];
    const d = await waitFor(async () => { const r = (await api(`/decisions/${id}`)).decision; return ['executed', 'failed'].includes(r.status) && r; }, 40000);
    if (d.status !== 'executed') throw new Error(`decision ${d.status}: ${d.result?.text}`);
    await page.getByText('Save as playbook').first().waitFor({ timeout: 15000 });
    await page.screenshot({ path: SHOTS + '10-decision-executed.png', fullPage: true });
    return `${d.title} · ${d.receipt.modelCalls} model calls · $${d.receipt.costUsd.toFixed(3)} · ${d.result.gateway}`;
  });

  await step('Save as playbook, then the incident resolves', async () => {
    await page.getByText('Save as playbook').first().click();
    const pbs = await waitFor(async () => { const r = await api(`/workspaces/${K8S}`); return r.playbooks.length && r.playbooks; }, 15000, 1000);
    await waitFor(async () => (await api(`/workspaces/${K8S}`)).incidents.every(i => i.status === 'resolved'), 60000);
    await page.screenshot({ path: SHOTS + '11-playbook-saved.png', fullPage: true });
    return `playbook “${pbs[0].title}” matches ${pbs[0].match.resource} · ${pbs[0].match.reason}`;
  });
}

// ------------------------------------------------------------------ 5 incident #2: playbook replay on the judge's phone
const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await phone.addInitScript(() => localStorage.setItem('prism.user', 'judge'));
const mobile = await phone.newPage();
const mobileErrors = watch(mobile, 'phone');

await step('Judge joins on a phone', async () => {
  sh('./scripts/reset.sh');
  await mobile.goto(`${WEB}/j/${K8S}?as=judge`, { waitUntil: 'domcontentloaded' });
  await mobile.waitForTimeout(3000);
  await mobile.screenshot({ path: SHOTS + '12-phone-join.png' });
});

await step('Break #2: playbook replay reaches the phone with 0 model calls', async () => {
  sh('./scripts/break.sh');
  const t0 = Date.now();
  await mobile.getByText('Approval needed').first().waitFor({ timeout: 60000 });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  await mobile.screenshot({ path: SHOTS + '13-phone-approval-needed.png' });
  await mobile.getByText('Approval needed').first().click();
  await mobile.waitForURL(/\/decide\//, { timeout: 15000 });
  await mobile.getByText(/Matched in/).first().waitFor({ timeout: 15000 });
  await mobile.getByText(/0 model calls/).first().waitFor({ timeout: 5000 });
  await waitFor(async () => (await mobile.getByText('Loading…').count()) === 0, 15000, 500); // live evidence arrived
  await mobile.screenshot({ path: SHOTS + '14-phone-replay.png', fullPage: true });
  const id = mobile.url().split('/decide/')[1].split('?')[0];
  const d = (await api(`/decisions/${id}`, 'judge')).decision;
  return `on phone ${secs}s after the break · source ${d.source} · matched in ${d.matchMs} ms · ${d.receipt.modelCalls} model calls`;
});

await step('Judge holds to approve on the phone; gateway allows; cluster heals', async () => {
  const id = mobile.url().split('/decide/')[1].split('?')[0];
  await hold(mobile, mobile.getByText('Hold to approve').first());
  const d = await waitFor(async () => { const r = (await api(`/decisions/${id}`, 'judge')).decision; return ['executed', 'failed'].includes(r.status) && r; }, 40000);
  if (d.status !== 'executed') throw new Error(`decision ${d.status}: ${d.result?.text}`);
  await waitFor(async () => (await api(`/workspaces/${K8S}`)).incidents.every(i => i.status === 'resolved'), 60000);
  await mobile.screenshot({ path: SHOTS + '15-phone-done.png', fullPage: true });
  return `approved by ${d.decidedBy} · ${d.result.gateway}`;
});

// ------------------------------------------------------------------ 6 gateway blocks a forged write
await step('A forged write (no signed approval) is blocked at agentgateway', async () => {
  const out = sh('cd server && npx tsx scripts/gw-call.ts /k8s/mcp scale_deployment \'{"namespace":"shop","name":"storefront","replicas":0}\'');
  if (!/BLOCKED|Unknown tool/.test(out)) throw new Error(out);
  const replicas = sh("kubectl -n shop get deploy storefront -o jsonpath='{.spec.replicas}'");
  return `${out} · storefront replicas still ${replicas}`;
});

await browser.close();

const all = [...errors, ...mobileErrors].filter(e => !/favicon|Download the React DevTools/.test(e));
console.log(`\n${results.filter(r => r.ok).length}/${results.length} steps passed · screenshots in e2e/screenshots/`);
if (all.length) { console.log(`\nBrowser errors (${all.length}):`); for (const e of [...new Set(all)].slice(0, 20)) console.log(' - ' + e); }
process.exit(results.every(r => r.ok) ? 0 : 1);
