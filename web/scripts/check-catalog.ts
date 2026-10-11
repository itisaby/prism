// Smoke test for the headless validator: `npx tsx scripts/check-catalog.ts` (from web/).
import { validateSurface } from '../src/catalog/validate.ts';

let failed = 0;
function expect(label: string, ok: boolean, detail: unknown) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) { failed++; console.log('      ', detail); }
}

const good = [
  { id: 'root', component: 'Column', children: ['m', 't'] },
  { id: 'm', component: 'MetricRow', items: { path: '/metrics' } },
  { id: 't', component: 'DataTable', title: 'Problem pods', rows: { path: '/pods' }, columns: [{ key: 'name', label: 'Pod' }], toneKey: 'tone',
    recordActions: [{ id: 'rollback', label: 'Roll back' }] },
];
const data = { metrics: [{ label: 'Pods', value: 12, tone: 'ok' }], pods: [{ name: 'checkout-worker-1', tone: 'bad' }] };

const r1 = validateSurface(good, data);
expect('accepts a good surface', r1.length === 0, r1);

const r2 = validateSurface([{ id: 'root', component: 'Iframe', src: 'https://evil' }], {});
expect('rejects an unknown component', r2.some(p => /Iframe/.test(p)), r2);

const r3 = validateSurface([{ id: 'root', component: 'TimeSeries', data: { path: '/rows' }, x: 't', series: [], script: 'x' }], { rows: [] });
expect('rejects bad props', r3.length > 0, r3);

const r4 = validateSurface([{ id: 'root', component: 'StatusList', items: { path: '/deployments' } }], { items: [] });
expect('rejects a dangling binding (lists top-level keys)', r4.some(p => p.includes('/deployments') && p.includes('items')), r4);

console.log(failed ? `${failed} check(s) failed` : 'all catalog checks passed');
process.exit(failed ? 1 : 0);
