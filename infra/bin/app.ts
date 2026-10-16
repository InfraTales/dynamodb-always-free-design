#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { TasksTableStack } from '../lib/tasks-table-stack';

const app = new cdk.App();

// The free tier is per Region. Deploy where your other provisioned tables aren't,
// or shrink src/capacity-plan.ts so the Region's total stays at 25 RCU and 25 WCU.
new TasksTableStack(app, 'DynamoDbAlwaysFree', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1' },
});

// Fail synth on any AWS Solutions finding that isn't acknowledged with a reason.
cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
