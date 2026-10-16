/**
 * Item shapes and key builders for a small multi-tenant task tracker.
 *
 * Every key starts with the tenant, so one tenant's query can never return another
 * tenant's items. The layout:
 *
 * | Item     | pk                          | sk                            | gsi1pk / gsi1sk                         |
 * |----------|-----------------------------|-------------------------------|-----------------------------------------|
 * | Project  | TENANT#t                    | PROJECT#p                     | -                                       |
 * | Task     | TENANT#t#PROJECT#p          | TASK#id                       | TENANT#t#USER#u / DUE#date#id (open and assigned only) |
 * | Activity | TENANT#t#PROJECT#p          | ACTIVITY#iso-time#id          | -                                       |
 */
import type { Item } from './capacity';

export type TaskStatus = 'OPEN' | 'IN_PROGRESS' | 'DONE';

export interface Project {
  readonly tenantId: string;
  readonly projectId: string;
  readonly name: string;
  readonly createdAt: string;
}

export interface Task {
  readonly tenantId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly title: string;
  readonly description: string;
  readonly status: TaskStatus;
  readonly assignee?: string;
  /** YYYY-MM-DD */
  readonly due?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Activity {
  readonly tenantId: string;
  readonly projectId: string;
  readonly activityId: string;
  readonly at: string;
  readonly actor: string;
  readonly action: string;
  readonly taskId?: string;
}

/** Activity is kept for 30 days, then TTL deletes it at no write cost. */
export const ACTIVITY_RETENTION_SECONDS = 30 * 24 * 60 * 60;

/** Sorts after any real date, so tasks with no due date list last. */
const NO_DUE_DATE = '9999-12-31';

const ID = /^[A-Za-z0-9_-]{1,64}$/;
export function checkId(kind: string, value: string): string {
  if (!ID.test(value)) throw new Error(`${kind} must be 1-64 characters of A-Z, a-z, 0-9, _ or -`);
  return value;
}

export const projectKey = (tenantId: string, projectId: string) => ({
  pk: `TENANT#${checkId('tenantId', tenantId)}`,
  sk: `PROJECT#${checkId('projectId', projectId)}`,
});

export const projectPartition = (tenantId: string, projectId: string) =>
  `TENANT#${checkId('tenantId', tenantId)}#PROJECT#${checkId('projectId', projectId)}`;

export const taskKey = (tenantId: string, projectId: string, taskId: string) => ({
  pk: projectPartition(tenantId, projectId),
  sk: `TASK#${checkId('taskId', taskId)}`,
});

export const assigneePartition = (tenantId: string, userId: string) =>
  `TENANT#${checkId('tenantId', tenantId)}#USER#${checkId('userId', userId)}`;

/**
 * Index keys for a task. Status is deliberately not part of them: moving a task from
 * OPEN to IN_PROGRESS then changes nothing in the index and costs no index writes.
 */
export function taskIndexKeys(task: Pick<Task, 'tenantId' | 'taskId' | 'status' | 'assignee' | 'due'>) {
  if (!task.assignee || task.status === 'DONE') return {};
  return {
    gsi1pk: assigneePartition(task.tenantId, task.assignee),
    gsi1sk: `DUE#${task.due ?? NO_DUE_DATE}#${task.taskId}`,
  };
}

export function projectItem(p: Project): Item {
  return { ...projectKey(p.tenantId, p.projectId), name: p.name, createdAt: p.createdAt };
}

export function taskItem(t: Task): Item {
  return {
    ...taskKey(t.tenantId, t.projectId, t.taskId),
    ...taskIndexKeys(t),
    title: t.title,
    description: t.description,
    status: t.status,
    ...(t.assignee ? { assignee: t.assignee } : {}),
    ...(t.due ? { due: t.due } : {}),
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

export function activityItem(a: Activity): Item {
  return {
    pk: projectPartition(a.tenantId, a.projectId),
    sk: `ACTIVITY#${a.at}#${checkId('activityId', a.activityId)}`,
    actor: a.actor,
    action: a.action,
    ...(a.taskId ? { taskId: a.taskId } : {}),
    expiresAt: Math.floor(Date.parse(a.at) / 1000) + ACTIVITY_RETENTION_SECONDS,
  };
}

const after = (s: string, prefix: string) => s.slice(s.indexOf(prefix) + prefix.length);

export function toProject(item: Item): Project {
  return {
    tenantId: after(String(item.pk), 'TENANT#'),
    projectId: after(String(item.sk), 'PROJECT#'),
    name: String(item.name),
    createdAt: String(item.createdAt),
  };
}

export function toTask(item: Item): Task {
  const [tenantId = '', projectId = ''] = String(item.pk).replace('TENANT#', '').split('#PROJECT#');
  return {
    tenantId,
    projectId,
    taskId: after(String(item.sk), 'TASK#'),
    title: String(item.title),
    description: String(item.description ?? ''),
    status: item.status as TaskStatus,
    ...(item.assignee ? { assignee: String(item.assignee) } : {}),
    ...(item.due ? { due: String(item.due) } : {}),
    createdAt: String(item.createdAt),
    updatedAt: String(item.updatedAt),
  };
}

/** What "my open tasks" returns: only the attributes the index projects. */
export interface OpenTaskSummary {
  readonly projectId: string;
  readonly taskId: string;
  readonly title: string;
  readonly due?: string;
}

export function toOpenTaskSummary(item: Item): OpenTaskSummary {
  const projectId = String(item.pk).split('#PROJECT#')[1] ?? '';
  return {
    projectId,
    taskId: after(String(item.sk), 'TASK#'),
    title: String(item.title),
    ...(item.due ? { due: String(item.due) } : {}),
  };
}
