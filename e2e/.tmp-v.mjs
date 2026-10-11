import { chromium } from 'playwright';
const [,, url, out] = process.argv;
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
const errs=[]; p.on('pageerror', e => errs.push(e.message));
await p.goto(url); await p.waitForTimeout(500);
// speak each step's script (in chunks, like interim results) and record where the deck lands
const steps = await p.evaluate(() => STEPS.map(s => s.say));
const log = [];
for (let i = 0; i < steps.length; i++) {
  const words = steps[i].split(' '); let acc = '';
  for (let w = 0; w < words.length; w += 3) { acc += ' ' + words.slice(w, w + 3).join(' '); await p.evaluate(t => { match(t); }, acc); await p.waitForTimeout(250); }
  await p.waitForTimeout(1300);
  const st = await p.evaluate(() => ({ cur, pts: [...document.querySelectorAll('#pts li.on')].length, total: STEPS[cur].pts.length }));
  log.push(`said #${i + 1} → on #${st.cur + 1}  points ${st.pts}/${st.total}`);
}
console.log(log.join('\n')); console.log('errors', errs);
const pp = await b.newPage({ viewport: { width: 1100, height: 760 } }); await pp.goto(url + '?presenter&step=10'); await pp.waitForTimeout(800); await pp.screenshot({ path: out });
await b.close();
