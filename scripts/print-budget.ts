/**
 * Prints the capacity budget for the workload in src/workload.ts.
 * Change the rates there to your own and run: npm run budget
 */
import { budget, demand, WORKLOAD } from '../src/workload';

console.log('Access pattern                 per second   table   GSI');
for (const p of WORKLOAD) {
  console.log(`${p.label.padEnd(30)} ${String(p.perSecond).padStart(10)}   ${String(p.cost.table).padStart(5)}   ${String(p.cost.byAssignee).padStart(3)}  (${p.kind})`);
}
console.log('\nPeak demand (capacity units per second):', demand());
console.log('\nBudget:');
let ok = true;
for (const l of budget()) {
  ok &&= l.fits;
  console.log(`${l.fits ? 'ok  ' : 'OVER'} ${l.resource.padEnd(30)} needs ${String(l.needed).padStart(5)} of ${l.provisioned}`);
}
process.exitCode = ok ? 0 : 1;
