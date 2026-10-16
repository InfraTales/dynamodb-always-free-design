/**
 * The designed workload: how often each access pattern runs at peak, and what one call
 * costs. The budget test multiplies the two and checks the result against the plan.
 *
 * `cost` is the design number. Two tests keep it honest: the unit tests recompute it
 * from item sizes with the calculator, and the DynamoDB Local tests measure it.
 */
import { CAPACITY_PLAN, FREE_TIER, maxProvisioned, type CapacityPlan } from './capacity-plan';
import type { AccessPatternName } from './task-store';

export interface Cost {
  /** Capacity units on the base table for one call. */
  readonly table: number;
  /** Capacity units on the byAssignee GSI for one call. */
  readonly byAssignee: number;
}

export interface AccessPattern {
  readonly name: AccessPatternName;
  /** A label, because one store method can be two patterns (status change vs. finish). */
  readonly label: string;
  readonly kind: 'read' | 'write';
  readonly perSecond: number;
  readonly cost: Cost;
}

/**
 * Peak traffic for a team tool with a few hundred people using it during the workday.
 * Change these to your own numbers and run `npm run budget`.
 */
export const WORKLOAD: readonly AccessPattern[] = [
  { name: 'getTask', label: 'open a task', kind: 'read', perSecond: 12, cost: { table: 0.5, byAssignee: 0 } },
  { name: 'listProjectTasks', label: 'list a project (30 tasks)', kind: 'read', perSecond: 2, cost: { table: 2.5, byAssignee: 0 } },
  { name: 'listMyOpenTasks', label: 'my open tasks (20)', kind: 'read', perSecond: 6, cost: { table: 0, byAssignee: 0.5 } },
  { name: 'listProjects', label: 'list projects (8)', kind: 'read', perSecond: 2, cost: { table: 0.5, byAssignee: 0 } },
  { name: 'listRecentActivity', label: 'recent activity (20)', kind: 'read', perSecond: 2, cost: { table: 0.5, byAssignee: 0 } },
  { name: 'createTask', label: 'create a task', kind: 'write', perSecond: 1, cost: { table: 1, byAssignee: 1 } },
  { name: 'setTaskStatus', label: 'start a task', kind: 'write', perSecond: 2, cost: { table: 1, byAssignee: 0 } },
  { name: 'setTaskStatus', label: 'finish a task', kind: 'write', perSecond: 1, cost: { table: 1, byAssignee: 1 } },
  { name: 'assignTask', label: 'reassign a task', kind: 'write', perSecond: 0.5, cost: { table: 1, byAssignee: 2 } },
  { name: 'recordActivity', label: 'record activity', kind: 'write', perSecond: 4.5, cost: { table: 1, byAssignee: 0 } },
  { name: 'createProject', label: 'create a project', kind: 'write', perSecond: 0.1, cost: { table: 1, byAssignee: 0 } },
];

export interface Demand {
  readonly tableRead: number;
  readonly tableWrite: number;
  readonly indexRead: number;
  readonly indexWrite: number;
}

/** Capacity units per second the workload needs at peak. */
export function demand(workload: readonly AccessPattern[] = WORKLOAD): Demand {
  const sum = (kind: 'read' | 'write', on: keyof Cost) =>
    workload.filter((p) => p.kind === kind).reduce((total, p) => total + p.perSecond * p.cost[on], 0);
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    tableRead: round(sum('read', 'table')),
    tableWrite: round(sum('write', 'table')),
    indexRead: round(sum('read', 'byAssignee')),
    indexWrite: round(sum('write', 'byAssignee')),
  };
}

export interface BudgetLine {
  readonly resource: string;
  readonly needed: number;
  readonly provisioned: number;
  readonly fits: boolean;
}

/** Each resource's peak demand against its provisioned capacity, plus the free-tier totals. */
export function budget(workload: readonly AccessPattern[] = WORKLOAD, plan: CapacityPlan = CAPACITY_PLAN): BudgetLine[] {
  const d = demand(workload);
  const total = maxProvisioned(plan);
  const line = (resource: string, needed: number, provisioned: number): BudgetLine => ({ resource, needed, provisioned, fits: needed <= provisioned });
  return [
    line('table reads (RCU)', d.tableRead, plan.table.read),
    line('table writes (WCU)', d.tableWrite, plan.table.write.max),
    line('byAssignee reads (RCU)', d.indexRead, plan.byAssignee.read),
    line('byAssignee writes (WCU)', d.indexWrite, plan.byAssignee.write.max),
    line('all reads vs free tier (RCU)', total.readUnits, FREE_TIER.readUnits),
    line('all writes vs free tier (WCU)', total.writeUnits, FREE_TIER.writeUnits),
  ];
}
