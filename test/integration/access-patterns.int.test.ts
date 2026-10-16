/**
 * Runs every access pattern against DynamoDB Local and measures what it costs with
 * ReturnConsumedCapacity: INDEXES. Each measurement must match both the design number
 * in src/workload.ts and the calculator's answer from item sizes.
 *
 * DynamoDB Local is an emulator. It ignores provisioned throughput and never throttles,
 * but it does report consumed capacity. These tests check that its numbers agree with
 * the documented rules (as coded in src/capacity.ts) for every pattern this app uses.
 */
import { GetItemCommand, QueryCommand, ScanCommand } from '@aws-sdk/client-dynamodb';
import { PutCommand, TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { queryReadUnits } from '../../src/capacity';
import * as f from '../../src/fixtures';
import { activityItem, projectItem, taskItem, taskKey } from '../../src/model';
import { ConflictError, TaskStore, type MeasuredCapacity } from '../../src/task-store';
import { budget, WORKLOAD, type AccessPattern, type Cost } from '../../src/workload';
import { BY_ASSIGNEE } from '../../src/schema';
import { predictedCosts, subject } from '../support/predictions';
import { createLocalTable, deleteLocalTable, localClients, seed } from '../support/local-table';

let client: DynamoDBClient;
let doc: DynamoDBDocumentClient;
let tableName: string;
let store: TaskStore;
let measured: MeasuredCapacity[];

const asCost = (m: MeasuredCapacity | undefined): Cost => ({ table: m?.table ?? NaN, byAssignee: m?.indexes[BY_ASSIGNEE.name] ?? 0 });
const last = () => asCost(measured.at(-1));

beforeAll(() => {
  ({ client, doc } = localClients());
});

beforeEach(async () => {
  tableName = await createLocalTable(client);
  await seed(doc, tableName, [...f.projects.map(projectItem), ...f.tasks.map(taskItem), ...f.activity.map(activityItem)]);
  measured = [];
  store = new TaskStore({ client: doc, tableName, onCapacity: (_pattern, used) => measured.push(used) });
});

afterEach(async () => {
  await deleteLocalTable(client, tableName);
});

/** Runs one workload entry the way the app would, and returns what it cost. */
const run: Record<string, () => Promise<unknown>> = {
  'open a task': () => store.getTask(f.TENANT, f.PROJECT, subject.taskId),
  'list a project (30 tasks)': () => store.listProjectTasks(f.TENANT, f.PROJECT),
  'my open tasks (20)': () => store.listMyOpenTasks(f.TENANT, f.USER),
  'list projects (8)': () => store.listProjects(f.TENANT),
  'recent activity (20)': () => store.listRecentActivity(f.TENANT, f.PROJECT, f.NOW),
  'create a task': () => store.createTask(f.newTask),
  'start a task': () => store.setTaskStatus(f.TENANT, f.PROJECT, subject.taskId, 'IN_PROGRESS', f.NOW),
  'finish a task': () => store.setTaskStatus(f.TENANT, f.PROJECT, subject.taskId, 'DONE', f.NOW),
  'reassign a task': () => store.assignTask(f.TENANT, f.PROJECT, subject.taskId, f.OTHER_USER, subject.due, f.NOW),
  'record activity': () => store.recordActivity(f.newActivity),
  'create a project': () => store.createProject(f.newProject),
};

describe('measured capacity per access pattern', () => {
  const predicted = predictedCosts();

  test.each(WORKLOAD.map((p) => [p.label, p] as const))('%s', async (label, pattern) => {
    await run[label]!();
    expect(measured).toHaveLength(1);
    const cost = last();
    expect(cost).toEqual(pattern.cost); // the design number
    expect(cost).toEqual(predicted[label]); // the calculator, from item sizes
  });
});

test('capacity budget: the workload priced with measured costs fits inside 25 RCU and 25 WCU', async () => {
  const priced: AccessPattern[] = [];
  for (const p of WORKLOAD) {
    // Each pattern runs on a fresh copy of the data, so earlier writes can't change it.
    await deleteLocalTable(client, tableName);
    tableName = await createLocalTable(client);
    await seed(doc, tableName, [...f.projects.map(projectItem), ...f.tasks.map(taskItem), ...f.activity.map(activityItem)]);
    store = new TaskStore({ client: doc, tableName, onCapacity: (_n, used) => measured.push(used) });
    await run[p.label]!();
    priced.push({ ...p, cost: last() });
  }
  const lines = budget(priced);
  expect(lines.filter((l) => !l.fits)).toEqual([]);
  const totals = lines.filter((l) => l.resource.includes('free tier'));
  expect(totals.map((l) => l.provisioned)).toEqual([25, 25]);
});

describe('what the measurements teach', () => {
  test('a strongly consistent read of the same task costs twice as much', async () => {
    const strong = await client.send(new GetItemCommand({
      TableName: tableName,
      Key: { pk: { S: taskKey(f.TENANT, f.PROJECT, subject.taskId).pk }, sk: { S: `TASK#${subject.taskId}` } },
      ConsistentRead: true,
      ReturnConsumedCapacity: 'TOTAL',
    }));
    expect(strong.ConsumedCapacity?.CapacityUnits).toBe(1);
  });

  test('a filter expression does not reduce the cost: reading 20 activity items and keeping none still costs 0.5', async () => {
    const thirtyOneDaysLater = new Date(Date.parse(f.NOW) + 31 * 86_400_000).toISOString();
    const items = await store.listRecentActivity(f.TENANT, f.PROJECT, thirtyOneDaysLater);
    expect(items).toEqual([]);
    expect(last().table).toBe(0.5);
  });

  test('a Scan pays for every item in the table, not only the ones you wanted', async () => {
    const out = await client.send(new ScanCommand({
      TableName: tableName,
      FilterExpression: 'gsi1pk = :u',
      ExpressionAttributeValues: { ':u': { S: `TENANT#${f.TENANT}#USER#${f.USER}` } },
      ReturnConsumedCapacity: 'TOTAL',
    }));
    expect(out.Count).toBe(20);
    // All 58 items (about 22 KB) are read: 6 blocks of 4 KB at 0.5 each.
    // The GSI query for the same 20 tasks costs 0.5.
    const everything = [...f.projects.map(projectItem), ...f.tasks.map(taskItem), ...f.activity.map(activityItem)];
    expect(out.ConsumedCapacity?.CapacityUnits).toBe(queryReadUnits(everything, 'eventual'));
    expect(out.ConsumedCapacity?.CapacityUnits).toBe(3);
  });

  test('a query on the GSI never touches the base table', async () => {
    const out = await client.send(new QueryCommand({
      TableName: tableName,
      IndexName: BY_ASSIGNEE.name,
      KeyConditionExpression: 'gsi1pk = :u',
      ExpressionAttributeValues: { ':u': { S: `TENANT#${f.TENANT}#USER#${f.USER}` } },
      ReturnConsumedCapacity: 'INDEXES',
    }));
    expect(out.ConsumedCapacity?.Table?.CapacityUnits ?? 0).toBe(0);
    expect(out.ConsumedCapacity?.GlobalSecondaryIndexes?.[BY_ASSIGNEE.name]?.CapacityUnits).toBe(0.5);
  });

  test('writing the activity item in a transaction doubles its cost', async () => {
    const out = await doc.send(new TransactWriteCommand({
      TransactItems: [{ Put: { TableName: tableName, Item: activityItem(f.newActivity) } }],
      ReturnConsumedCapacity: 'INDEXES',
    }));
    expect(out.ConsumedCapacity?.[0]?.CapacityUnits).toBe(2);
  });

  test('starting a task twice costs the index nothing, because status is not in the index', async () => {
    await store.setTaskStatus(f.TENANT, f.PROJECT, subject.taskId, 'IN_PROGRESS', f.NOW);
    await store.setTaskStatus(f.TENANT, f.PROJECT, subject.taskId, 'OPEN', f.NOW);
    expect(measured.map(asCost)).toEqual([{ table: 1, byAssignee: 0 }, { table: 1, byAssignee: 0 }]);
  });

  test('a bigger description crosses into a second 1 KB write block', async () => {
    const out = await doc.send(new PutCommand({
      TableName: tableName,
      Item: taskItem({ ...f.newTask, description: 'x'.repeat(1000) }),
      ReturnConsumedCapacity: 'INDEXES',
    }));
    expect(out.ConsumedCapacity?.Table?.CapacityUnits).toBe(2);
    expect(out.ConsumedCapacity?.GlobalSecondaryIndexes?.[BY_ASSIGNEE.name]?.CapacityUnits).toBe(1);
  });
});

describe('the data layer behaves correctly', () => {
  test('another tenant sees none of these projects or tasks', async () => {
    expect(await store.listProjects('globex')).toEqual([]);
    expect(await store.listProjectTasks('globex', f.PROJECT)).toEqual([]);
    expect(await store.listMyOpenTasks('globex', f.USER)).toEqual([]);
  });

  test('creating a task or project twice is a conflict, not an overwrite', async () => {
    await expect(store.createTask({ ...f.newTask, taskId: subject.taskId })).rejects.toBeInstanceOf(ConflictError);
    await expect(store.createProject({ ...f.newProject, projectId: f.PROJECT })).rejects.toBeInstanceOf(ConflictError);
  });

  test('my open tasks come back by due date, and only the attributes the index projects', async () => {
    const mine = await store.listMyOpenTasks(f.TENANT, f.USER);
    expect(mine).toHaveLength(20);
    const dues = mine.map((t) => t.due);
    expect(dues).toEqual([...dues].sort());
    expect(Object.keys(mine[0]!).sort()).toEqual(['due', 'projectId', 'taskId', 'title']);
  });

  test('finishing a task removes it from my open tasks; starting one keeps it', async () => {
    const other = f.tasks[1]!;
    await store.setTaskStatus(f.TENANT, f.PROJECT, subject.taskId, 'DONE', f.NOW);
    await store.setTaskStatus(f.TENANT, f.PROJECT, other.taskId, 'IN_PROGRESS', f.NOW);
    const ids = (await store.listMyOpenTasks(f.TENANT, f.USER)).map((t) => t.taskId);
    expect(ids).not.toContain(subject.taskId);
    expect(ids).toContain(other.taskId);
    expect((await store.getTask(f.TENANT, f.PROJECT, subject.taskId))?.status).toBe('DONE');
  });

  test('a finished task cannot change status or be reassigned', async () => {
    await store.setTaskStatus(f.TENANT, f.PROJECT, subject.taskId, 'DONE', f.NOW);
    await expect(store.setTaskStatus(f.TENANT, f.PROJECT, subject.taskId, 'OPEN', f.NOW)).rejects.toBeInstanceOf(ConflictError);
    await expect(store.assignTask(f.TENANT, f.PROJECT, subject.taskId, f.OTHER_USER, undefined, f.NOW)).rejects.toBeInstanceOf(ConflictError);
  });

  test('reassigning moves the task to the new person', async () => {
    await store.assignTask(f.TENANT, f.PROJECT, subject.taskId, f.OTHER_USER, subject.due, f.NOW);
    expect((await store.listMyOpenTasks(f.TENANT, f.OTHER_USER)).map((t) => t.taskId)).toEqual([subject.taskId]);
    expect((await store.listMyOpenTasks(f.TENANT, f.USER)).map((t) => t.taskId)).not.toContain(subject.taskId);
  });

  test('recent activity is newest first and hides items past their expiry', async () => {
    const recent = await store.listRecentActivity(f.TENANT, f.PROJECT, f.NOW);
    expect(recent).toHaveLength(20);
    expect(String(recent[0]!.sk) > String(recent[19]!.sk)).toBe(true);
  });

  test('a missing task comes back undefined, and still costs a read', async () => {
    expect(await store.getTask(f.TENANT, f.PROJECT, 'nope')).toBeUndefined();
    expect(last().table).toBe(0.5);
  });
});
