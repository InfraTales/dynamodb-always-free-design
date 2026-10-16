/**
 * What the calculator says each workload entry costs, worked out from the fixture items.
 * Keyed by the workload label. The unit tests compare these with the design numbers in
 * src/workload.ts, and the DynamoDB Local tests compare them with measured capacity.
 */
import { indexEntry, queryReadUnits, readUnits, itemSize, writeCost, type Item } from '../../src/capacity';
import * as f from '../../src/fixtures';
import { activityItem, projectItem, taskItem } from '../../src/model';
import { PAGE_SIZE } from '../../src/task-store';
import { BY_ASSIGNEE, INDEXES } from '../../src/schema';
import type { Cost } from '../../src/workload';

const read = (table: number, byAssignee = 0): Cost => ({ table, byAssignee });
const write = (before: Item | undefined, after: Item | undefined): Cost => {
  const c = writeCost(before, after, INDEXES);
  return { table: c.table, byAssignee: c.indexes[BY_ASSIGNEE.name] ?? 0 };
};

/** The task every single-task scenario works on: open and assigned to USER. */
export const subject = f.tasks[0]!;

/** The first page of USER's open tasks, in index order (by due date). */
export function myOpenTaskEntries(): Item[] {
  return f.tasks
    .map(taskItem)
    .map((i) => indexEntry(i, BY_ASSIGNEE))
    .filter((e): e is Item => e !== undefined)
    .sort((a, b) => String(a.gsi1sk).localeCompare(String(b.gsi1sk)))
    .slice(0, PAGE_SIZE.myOpenTasks);
}

export function predictedCosts(): Record<string, Cost> {
  const before = taskItem(subject);
  return {
    'open a task': read(readUnits(itemSize(before), 'eventual')),
    'list a project (30 tasks)': read(queryReadUnits(f.tasks.map(taskItem), 'eventual')),
    'my open tasks (20)': read(0, queryReadUnits(myOpenTaskEntries(), 'eventual')),
    'list projects (8)': read(queryReadUnits(f.projects.map(projectItem), 'eventual')),
    'recent activity (20)': read(queryReadUnits(f.activity.map(activityItem), 'eventual')),
    'create a task': write(undefined, taskItem(f.newTask)),
    'start a task': write(before, taskItem({ ...subject, status: 'IN_PROGRESS', updatedAt: f.NOW })),
    'finish a task': write(before, taskItem({ ...subject, status: 'DONE', updatedAt: f.NOW })),
    'reassign a task': write(before, taskItem({ ...subject, assignee: f.OTHER_USER, updatedAt: f.NOW })),
    'record activity': write(undefined, activityItem(f.newActivity)),
    'create a project': write(undefined, projectItem(f.newProject)),
  };
}
