import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import type { Construct } from 'constructs';
import { CAPACITY_PLAN, FREE_TIER, maxProvisioned, type CapacityPlan } from '../../src/capacity-plan';
import { BY_ASSIGNEE, TABLE_KEYS, TTL_ATTRIBUTE, type IndexSchema } from '../../src/schema';

function projection(index: IndexSchema): Pick<dynamodb.GlobalSecondaryIndexPropsV2, 'projectionType' | 'nonKeyAttributes'> {
  switch (index.projection.type) {
    case 'KEYS_ONLY':
      return { projectionType: dynamodb.ProjectionType.KEYS_ONLY };
    case 'ALL':
      return { projectionType: dynamodb.ProjectionType.ALL };
    case 'INCLUDE':
      return { projectionType: dynamodb.ProjectionType.INCLUDE, nonKeyAttributes: [...index.projection.attributes] };
  }
}

export interface TasksTableStackProps extends cdk.StackProps {
  /** Defaults to src/capacity-plan.ts. Tests pass their own to check the guard. */
  readonly plan?: CapacityPlan;
}

/**
 * One table and one GSI in provisioned mode, sized so the most it can ever provision
 * fits inside DynamoDB's always-free 25 RCU and 25 WCU.
 */
export class TasksTableStack extends cdk.Stack {
  readonly table: dynamodb.TableV2;

  constructor(scope: Construct, id: string, props: TasksTableStackProps = {}) {
    super(scope, id, props);
    const plan = props.plan ?? CAPACITY_PLAN;

    // Refuse to synthesize a plan that could ever bill for capacity.
    const most = maxProvisioned(plan);
    if (most.readUnits > FREE_TIER.readUnits || most.writeUnits > FREE_TIER.writeUnits) {
      throw new Error(`Capacity plan exceeds the free tier: ${most.readUnits} RCU / ${most.writeUnits} WCU (limit 25 / 25)`);
    }

    // Write capacity is pinned: min = max = this resource's share of the free 25 WCU.
    const writes = (w: { min: number; max: number }) =>
      dynamodb.Capacity.autoscaled({ minCapacity: w.min, maxCapacity: w.max, targetUtilizationPercent: plan.targetUtilizationPercent });

    this.table = new dynamodb.TableV2(this, 'Tasks', {
      partitionKey: { name: TABLE_KEYS.partitionKey, type: dynamodb.AttributeType.STRING },
      sortKey: { name: TABLE_KEYS.sortKey, type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.provisioned({
        readCapacity: dynamodb.Capacity.fixed(plan.table.read),
        writeCapacity: writes(plan.table.write),
      }),
      globalSecondaryIndexes: [
        {
          indexName: BY_ASSIGNEE.name,
          partitionKey: { name: BY_ASSIGNEE.partitionKey, type: dynamodb.AttributeType.STRING },
          sortKey: { name: BY_ASSIGNEE.sortKey, type: dynamodb.AttributeType.STRING },
          ...projection(BY_ASSIGNEE),
          readCapacity: dynamodb.Capacity.fixed(plan.byAssignee.read),
          writeCapacity: writes(plan.byAssignee.write),
        },
      ],
      // The free 25 GB of storage covers the Standard table class only.
      tableClass: dynamodb.TableClass.STANDARD,
      timeToLiveAttribute: TTL_ATTRIBUTE,
      // Point-in-time recovery has no free tier (USD 0.20 per GB-month in us-east-1).
      // It's off so the stack costs USD 0. Turn it on once the data is worth more than that.
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: false },
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });


    new cdk.CfnOutput(this, 'TableName', { value: this.table.tableName });
  }
}
