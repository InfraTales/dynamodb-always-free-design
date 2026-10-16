import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { AwsSolutionsChecks } from 'cdk-nag';
import { CAPACITY_PLAN } from '../../src/capacity-plan';
import { BY_ASSIGNEE } from '../../src/schema';
import { TasksTableStack } from '../../infra/lib/tasks-table-stack';

const env = { account: '123456789012', region: 'us-east-1' };
const template = Template.fromStack(new TasksTableStack(new cdk.App(), 'Test', { env }));
const tables = Object.values<any>(template.findResources('AWS::DynamoDB::GlobalTable'));
const table = tables[0].Properties;
const replica = table.Replicas[0];

/** The most read or write capacity a throughput setting can ever provision. */
function most(settings: any, kind: 'Read' | 'Write'): number {
  if (!settings) throw new Error(`no ${kind} capacity setting: on-demand or missing`);
  const fixed = settings[`${kind}CapacityUnits`];
  if (typeof fixed === 'number') return fixed;
  const scaled = settings[`${kind}CapacityAutoScalingSettings`];
  if (typeof scaled?.MaxCapacity === 'number') return scaled.MaxCapacity;
  throw new Error(`can't read ${kind} capacity from ${JSON.stringify(settings)}`);
}

test('the stack has exactly one table, one GSI and nothing else that bills', () => {
  expect(tables).toHaveLength(1);
  template.resourceCountIs('AWS::DynamoDB::Table', 0);
  expect(table.GlobalSecondaryIndexes).toHaveLength(1);
  expect(table.Replicas).toHaveLength(1);
  const types = Object.values<any>(template.toJSON().Resources).map((r) => r.Type).filter((t) => t !== 'AWS::CDK::Metadata');
  expect(types).toEqual(['AWS::DynamoDB::GlobalTable']);
});

test('provisioned mode, Standard table class: the two things the free tier needs', () => {
  expect(table.BillingMode).toBe('PROVISIONED');
  expect(replica.TableClass).toBe('STANDARD');
});

test('total read capacity across table and GSI is at most 25 RCU', () => {
  const tableReads = most(replica.ReadProvisionedThroughputSettings, 'Read');
  const indexReads = replica.GlobalSecondaryIndexes.map((g: any) => most(g.ReadProvisionedThroughputSettings, 'Read'));
  expect(indexReads).toHaveLength(1);
  expect(tableReads + indexReads.reduce((a: number, b: number) => a + b, 0)).toBeLessThanOrEqual(25);
});

test('total write capacity across table and GSI is at most 25 WCU, counting auto scaling at its max', () => {
  const tableWrites = most(table.WriteProvisionedThroughputSettings, 'Write');
  const indexWrites = table.GlobalSecondaryIndexes.map((g: any) => most(g.WriteProvisionedThroughputSettings, 'Write'));
  expect(indexWrites).toHaveLength(1);
  expect(tableWrites + indexWrites.reduce((a: number, b: number) => a + b, 0)).toBeLessThanOrEqual(25);
});

test('write auto scaling is pinned (min = max), so it never scales down and never above the plan', () => {
  for (const s of [table.WriteProvisionedThroughputSettings, table.GlobalSecondaryIndexes[0].WriteProvisionedThroughputSettings]) {
    const a = s.WriteCapacityAutoScalingSettings;
    expect(a.MinCapacity).toBe(a.MaxCapacity);
  }
  expect(table.WriteProvisionedThroughputSettings.WriteCapacityAutoScalingSettings.MaxCapacity).toBe(CAPACITY_PLAN.table.write.max);
});

test('reads are fixed, not auto scaled, so they add no CloudWatch alarms', () => {
  expect(replica.ReadProvisionedThroughputSettings).toEqual({ ReadCapacityUnits: CAPACITY_PLAN.table.read });
  expect(replica.GlobalSecondaryIndexes[0].ReadProvisionedThroughputSettings).toEqual({ ReadCapacityUnits: CAPACITY_PLAN.byAssignee.read });
});

test('the GSI projects only the attributes "my open tasks" shows', () => {
  const gsi = table.GlobalSecondaryIndexes[0];
  expect(gsi.IndexName).toBe(BY_ASSIGNEE.name);
  expect(gsi.Projection).toEqual({ ProjectionType: 'INCLUDE', NonKeyAttributes: ['title', 'due'] });
});

test('TTL is on for expiresAt, deletion protection is on, and the table survives a stack delete', () => {
  expect(table.TimeToLiveSpecification).toEqual({ AttributeName: 'expiresAt', Enabled: true });
  expect(replica.DeletionProtectionEnabled).toBe(true);
  template.hasResource('AWS::DynamoDB::GlobalTable', { DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' });
});

test('point-in-time recovery is off on purpose, because it has no free tier', () => {
  expect(replica.PointInTimeRecoverySpecification).toEqual({ PointInTimeRecoveryEnabled: false });
});

test('the stack refuses a plan that could provision more than the free tier', () => {
  const plan = { ...CAPACITY_PLAN, byAssignee: { ...CAPACITY_PLAN.byAssignee, write: { min: 8, max: 9 } } };
  expect(() => new TasksTableStack(new cdk.App(), 'Over', { env, plan })).toThrow(/exceeds the free tier: 25 RCU \/ 26 WCU/);
});

describe('cdk-nag', () => {
  function nagReport(addExtra?: (stack: cdk.Stack) => void) {
    const app = new cdk.App();
    const stack = new TasksTableStack(app, 'Nag', { env });
    addExtra?.(stack);
    cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
    try {
      app.synth();
      return 'passed';
    } catch (e) {
      return String(e);
    }
  }

  test('the stack passes the AWS Solutions pack with no acknowledgements', () => {
    expect(nagReport()).toBe('passed');
  });

  test('the pack is really running: an unencrypted-in-transit bucket fails synth', () => {
    expect(nagReport((stack) => new s3.Bucket(stack, 'Bad'))).toMatch(/AwsSolutions-S10/);
  });
});
