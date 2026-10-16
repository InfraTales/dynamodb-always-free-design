/**
 * How the always-free capacity is split between the table and its one GSI.
 *
 * The free tier gives 25 write capacity units (WCU) and 25 read capacity units (RCU)
 * of provisioned capacity per Region, per payer account. The 25 is shared by every
 * provisioned table and GSI you have in that Region, so the sums below must stay at
 * or under 25. If another provisioned table already lives in the Region, shrink these.
 */
export const FREE_TIER = { readUnits: 25, writeUnits: 25 } as const;

export interface WriteScaling {
  readonly min: number;
  /** Auto scaling never goes above this, so this is what you could be billed for. */
  readonly max: number;
}

export interface ResourcePlan {
  /** Fixed read capacity. Fixed means no auto scaling alarms. */
  readonly read: number;
  /**
   * CDK's TableV2 only accepts auto scaled write capacity. We pin min to max: inside
   * the free tier, scaling down saves nothing, and it shrinks the unused capacity
   * that DynamoDB keeps as burst capacity.
   */
  readonly write: WriteScaling;
}

export interface CapacityPlan {
  readonly table: ResourcePlan;
  readonly byAssignee: ResourcePlan;
  readonly targetUtilizationPercent: number;
}

export const CAPACITY_PLAN: CapacityPlan = {
  table: { read: 18, write: { min: 17, max: 17 } },
  byAssignee: { read: 7, write: { min: 8, max: 8 } },
  targetUtilizationPercent: 70,
};

/** The most capacity this plan can ever provision, which is what the bill depends on. */
export function maxProvisioned(plan: CapacityPlan = CAPACITY_PLAN) {
  return {
    readUnits: plan.table.read + plan.byAssignee.read,
    writeUnits: plan.table.write.max + plan.byAssignee.write.max,
  };
}
