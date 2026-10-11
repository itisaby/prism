import { chromium } from 'playwright';
const [,, url, outDir, list] = process.argv;
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
const errs=[]; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => m.type()==='error' && errs.push(m.text()));
for (const i of list.split(',')) { await p.goto(url + '?step=' + i); await p.waitForTimeout(8500); await p.screenshot({ path: `${outDir}/s${String(i).padStart(2,'0')}.png` }); }
console.log('errors:', JSON.stringify(errs.slice(0,10))); await b.close();
