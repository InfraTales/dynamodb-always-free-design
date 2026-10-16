/**
 * The data layer: every access pattern the task tracker has, one method each.
 *
 * Every call asks DynamoDB for ConsumedCapacity (INDEXES), which costs nothing extra,
 * and hands it to `onCapacity`. In production you'd log it or turn it into a metric.
 * The tests use it to measure what each access pattern really costs.
 */
import type { ConsumedCapacity } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { BY_ASSIGNEE, TTL_ATTRIBUTE } from './schema';
import {
  activityItem,
  assigneePartition,
  checkId,
  projectItem,
  projectPartition,
  taskIndexKeys,
  taskItem,
  taskKey,
  toOpenTaskSummary,
  toProject,
  toTask,
  type Activity,
  type OpenTaskSummary,
  type Project,
  type Task,
  type TaskStatus,
} from './model';
import type { Item } from './capacity';

/** Capacity one call used, split by table and index. */
export interface MeasuredCapacity {
  readonly table: number;
  readonly indexes: Record<string, number>;
}

export type AccessPatternName =
  | 'createProject'
  | 'listProjects'
  | 'createTask'
  | 'getTask'
  | 'listProjectTasks'
  | 'listMyOpenTasks'
  | 'setTaskStatus'
  | 'assignTask'
  | 'recordActivity'
  | 'listRecentActivity';

export type CapacityListener = (pattern: AccessPatternName, used: MeasuredCapacity) => void;

export interface TaskStoreOptions {
  readonly client: DynamoDBDocumentClient;
  readonly tableName: string;
  readonly onCapacity?: CapacityListener;
}

export class ConflictError extends Error {}

/** Page sizes are part of the capacity budget. A bigger page reads more 4 KB blocks. */
export const PAGE_SIZE = { projectTasks: 50, myOpenTasks: 20, recentActivity: 20, projects: 50 } as const;

function summarize(consumed: ConsumedCapacity | undefined): MeasuredCapacity {
  const indexes: Record<string, number> = {};
  for (const [name, c] of Object.entries(consumed?.GlobalSecondaryIndexes ?? {})) {
    if (c.CapacityUnits) indexes[name] = c.CapacityUnits;
  }
  // GetItem reports only the total. For the rest, Table holds the base table's share.
  const table = consumed?.Table?.CapacityUnits ?? consumed?.CapacityUnits ?? 0;
  return { table, indexes };
}

const isConditionFailure = (e: unknown) => e instanceof Error && e.name === 'ConditionalCheckFailedException';

export class TaskStore {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;
  private readonly onCapacity: CapacityListener;

  constructor(options: TaskStoreOptions) {
    this.client = options.client;
    this.tableName = options.tableName;
    this.onCapacity = options.onCapacity ?? (() => undefined);
  }

  private report(pattern: AccessPatternName, consumed: ConsumedCapacity | undefined) {
    this.onCapacity(pattern, summarize(consumed));
  }

  async createProject(project: Project): Promise<void> {
    try {
      const out = await this.client.send(new PutCommand({
        TableName: this.tableName,
        Item: projectItem(project),
        ConditionExpression: 'attribute_not_exists(pk)',
        ReturnConsumedCapacity: 'INDEXES',
      }));
      this.report('createProject', out.ConsumedCapacity);
    } catch (e) {
      if (isConditionFailure(e)) throw new ConflictError(`project ${project.projectId} exists`);
      throw e;
    }
  }

  async listProjects(tenantId: string): Promise<Project[]> {
    const out = await this.client.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': `TENANT#${checkId('tenantId', tenantId)}`, ':prefix': 'PROJECT#' },
      Limit: PAGE_SIZE.projects,
      ReturnConsumedCapacity: 'INDEXES',
    }));
    this.report('listProjects', out.ConsumedCapacity);
    return (out.Items ?? []).map(toProject);
  }

  async createTask(task: Task): Promise<void> {
    try {
      const out = await this.client.send(new PutCommand({
        TableName: this.tableName,
        Item: taskItem(task),
        ConditionExpression: 'attribute_not_exists(pk)',
        ReturnConsumedCapacity: 'INDEXES',
      }));
      this.report('createTask', out.ConsumedCapacity);
    } catch (e) {
      if (isConditionFailure(e)) throw new ConflictError(`task ${task.taskId} exists`);
      throw e;
    }
  }

  /** Eventually consistent: half the price of a strongly consistent read. */
  async getTask(tenantId: string, projectId: string, taskId: string): Promise<Task | undefined> {
    const out = await this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: taskKey(tenantId, projectId, taskId),
      ReturnConsumedCapacity: 'INDEXES',
    }));
    this.report('getTask', out.ConsumedCapacity);
    return out.Item ? toTask(out.Item as Item) : undefined;
  }

  async listProjectTasks(tenantId: string, projectId: string): Promise<Task[]> {
    const out = await this.client.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': projectPartition(tenantId, projectId), ':prefix': 'TASK#' },
      Limit: PAGE_SIZE.projectTasks,
      ReturnConsumedCapacity: 'INDEXES',
    }));
    this.report('listProjectTasks', out.ConsumedCapacity);
    return (out.Items ?? []).map((i) => toTask(i as Item));
  }

  /** The one GSI query. GSIs only offer eventually consistent reads. */
  async listMyOpenTasks(tenantId: string, userId: string): Promise<OpenTaskSummary[]> {
    const out = await this.client.send(new QueryCommand({
      TableName: this.tableName,
      IndexName: BY_ASSIGNEE.name,
      KeyConditionExpression: 'gsi1pk = :pk',
      ExpressionAttributeValues: { ':pk': assigneePartition(tenantId, userId) },
      Limit: PAGE_SIZE.myOpenTasks,
      ReturnConsumedCapacity: 'INDEXES',
    }));
    this.report('listMyOpenTasks', out.ConsumedCapacity);
    return (out.Items ?? []).map((i) => toOpenTaskSummary(i as Item));
  }

  /**
   * OPEN <-> IN_PROGRESS touches only the table. DONE also removes the task from the
   * index (one index write). A finished task can't change status again.
   */
  async setTaskStatus(tenantId: string, projectId: string, taskId: string, status: TaskStatus, now: string): Promise<void> {
    const done = status === 'DONE';
    try {
      const out = await this.client.send(new UpdateCommand({
        TableName: this.tableName,
        Key: taskKey(tenantId, projectId, taskId),
        UpdateExpression: `SET #status = :status, updatedAt = :now${done ? ' REMOVE gsi1pk, gsi1sk' : ''}`,
        ConditionExpression: 'attribute_exists(pk) AND #status <> :done',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':status': status, ':now': now, ':done': 'DONE' },
        ReturnConsumedCapacity: 'INDEXES',
      }));
      this.report('setTaskStatus', out.ConsumedCapacity);
    } catch (e) {
      if (isConditionFailure(e)) throw new ConflictError(`task ${taskId} is missing or already done`);
      throw e;
    }
  }

  /**
   * Sets the assignee and the due date together, because both are part of the index key.
   * Pass undefined to clear the due date. Changing either key value costs two index
   * writes (a delete and a put).
   */
  async assignTask(tenantId: string, projectId: string, taskId: string, assignee: string, due: string | undefined, now: string): Promise<void> {
    const keys = taskIndexKeys({ tenantId, taskId, status: 'OPEN', assignee, due });
    try {
      const out = await this.client.send(new UpdateCommand({
        TableName: this.tableName,
        Key: taskKey(tenantId, projectId, taskId),
        UpdateExpression: `SET assignee = :assignee, gsi1pk = :gpk, gsi1sk = :gsk, updatedAt = :now${due ? ', due = :due' : ' REMOVE due'}`,
        ConditionExpression: 'attribute_exists(pk) AND #status <> :done',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':assignee': checkId('assignee', assignee),
          ':gpk': keys.gsi1pk,
          ':gsk': keys.gsi1sk,
          ':now': now,
          ':done': 'DONE',
          ...(due ? { ':due': due } : {}),
        },
        ReturnConsumedCapacity: 'INDEXES',
      }));
      this.report('assignTask', out.ConsumedCapacity);
    } catch (e) {
      if (isConditionFailure(e)) throw new ConflictError(`task ${taskId} is missing or already done`);
      throw e;
    }
  }

  /** Activity items carry expiresAt, so they delete themselves after 30 days. */
  async recordActivity(activity: Activity): Promise<void> {
    const out = await this.client.send(new PutCommand({
      TableName: this.tableName,
      Item: activityItem(activity),
      ReturnConsumedCapacity: 'INDEXES',
    }));
    this.report('recordActivity', out.ConsumedCapacity);
  }

  /**
   * TTL deletes expired items within a few days, not on the second, so the filter hides
   * the ones still waiting. Filtered items are still read and still cost capacity.
   */
  async listRecentActivity(tenantId: string, projectId: string, now: string): Promise<Item[]> {
    const out = await this.client.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      FilterExpression: '#ttl > :nowSeconds',
      ExpressionAttributeNames: { '#ttl': TTL_ATTRIBUTE },
      ExpressionAttributeValues: {
        ':pk': projectPartition(tenantId, projectId),
        ':prefix': 'ACTIVITY#',
        ':nowSeconds': Math.floor(Date.parse(now) / 1000),
      },
      ScanIndexForward: false,
      Limit: PAGE_SIZE.recentActivity,
      ReturnConsumedCapacity: 'INDEXES',
    }));
    this.report('listRecentActivity', out.ConsumedCapacity);
    return (out.Items ?? []) as Item[];
  }
}
