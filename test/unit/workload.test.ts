import { CAPACITY_PLAN, FREE_TIER, maxProvisioned } from '../../src/capacity-plan';
import { budget, demand, WORKLOAD, type AccessPattern } from '../../src/workload';
import { predictedCosts } from '../support/predictions';

test('every design cost in the workload matches the calculator, worked out from the fixture items', () => {
  const predicted = predictedCosts();
  for (const p of WORKLOAD) {
    expect({ label: p.label, cost: predicted[p.label] }).toEqual({ label: p.label, cost: p.cost });
  }
  expect(Object.keys(predicted).sort()).toEqual(WORKLOAD.map((p) => p.label).sort());
});

test('the designed peak workload needs these capacity units per second', () => {
  expect(demand()).toEqual({ tableRead: 13, tableWrite: 9.1, indexRead: 3, indexWrite: 3 });
});

test('capacity budget: the workload fits the plan, and the plan fits the free tier', () => {
  const lines = budget();
  expect(lines.filter((l) => !l.fits)).toEqual([]);
  expect(maxProvisioned()).toEqual({ readUnits: 25, writeUnits: 25 });
  expect(maxProvisioned().readUnits).toBeLessThanOrEqual(FREE_TIER.readUnits);
  expect(maxProvisioned().writeUnits).toBeLessThanOrEqual(FREE_TIER.writeUnits);
});

test('write auto scaling is pinned: min equals max for the table and the index', () => {
  for (const r of [CAPACITY_PLAN.table, CAPACITY_PLAN.byAssignee]) expect(r.write.min).toBe(r.write.max);
});

test('the budget catches a design change that no longer fits', () => {
  // Strongly consistent "open a task" doubles its cost: 12/s x 1 RCU on its own.
  const strong: AccessPattern[] = WORKLOAD.map((p) => (p.label === 'open a task' ? { ...p, cost: { table: 1, byAssignee: 0 } } : p));
  expect(budget(strong).find((l) => l.resource === 'table reads (RCU)')).toMatchObject({ needed: 19, provisioned: 18, fits: false });
});
