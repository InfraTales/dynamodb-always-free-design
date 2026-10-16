/**
 * Representative data for the capacity budget. Item sizes drive every number in the
 * budget, so the sizes here should look like your real data, not like test stubs.
 *
 * The DynamoDB Local tests load exactly these items, then measure each access pattern.
 */
import type { Activity, Project, Task } from './model';

export const NOW = '2026-10-15T12:00:00.000Z';
export const TENANT = 'acme';
export const PROJECT = 'website';
export const USER = 'maria';
export const OTHER_USER = 'sam';

/** A typical task description: about 400 characters of plain text. */
const DESCRIPTION =
  'Move the pricing page to the new layout. Keep the plan table, the FAQ and the ' +
  'contact form. Check the page on phones, because most visitors come from mobile. ' +
  'The design file has the final copy and the image sizes. Ask Sam before changing ' +
  'any prices. Link the old URL to the new one so search engines follow it. Done ' +
  'means: reviewed by one other person, live on staging, and the checklist ticked.';

export const projects: Project[] = Array.from({ length: 8 }, (_, i) => ({
  tenantId: TENANT,
  projectId: i === 0 ? PROJECT : `project-${i}`,
  name: i === 0 ? 'Company website' : `Project number ${i}`,
  createdAt: '2026-01-05T09:00:00.000Z',
}));

/** One busy project: 30 tasks, 20 of them open and assigned to USER. */
export const tasks: Task[] = Array.from({ length: 30 }, (_, i) => {
  const n = String(i + 1).padStart(3, '0');
  const open = i < 20;
  return {
    tenantId: TENANT,
    projectId: PROJECT,
    taskId: `task-${n}`,
    title: `Update section ${n} of the website`,
    description: DESCRIPTION,
    status: open ? 'OPEN' : 'DONE',
    assignee: USER,
    due: `2026-11-${String((i % 28) + 1).padStart(2, '0')}`,
    createdAt: '2026-10-01T09:00:00.000Z',
    updatedAt: '2026-10-01T09:00:00.000Z',
  };
});

/** The last 20 events in the project. */
export const activity: Activity[] = Array.from({ length: 20 }, (_, i) => ({
  tenantId: TENANT,
  projectId: PROJECT,
  activityId: `evt-${String(i + 1).padStart(3, '0')}`,
  at: new Date(Date.parse('2026-10-15T11:00:00.000Z') + i * 60_000).toISOString(),
  actor: USER,
  action: 'task.status_changed',
  taskId: `task-${String(i + 1).padStart(3, '0')}`,
}));

/** A new task as the app writes it: open, assigned, with a normal description. */
export const newTask: Task = {
  tenantId: TENANT,
  projectId: PROJECT,
  taskId: 'task-new',
  title: 'Write the launch announcement',
  description: DESCRIPTION,
  status: 'OPEN',
  assignee: USER,
  due: '2026-11-20',
  createdAt: NOW,
  updatedAt: NOW,
};

export const newActivity: Activity = {
  tenantId: TENANT,
  projectId: PROJECT,
  activityId: 'evt-new',
  at: NOW,
  actor: USER,
  action: 'task.created',
  taskId: 'task-new',
};

export const newProject: Project = {
  tenantId: TENANT,
  projectId: 'mobile-app',
  name: 'Mobile app',
  createdAt: NOW,
};
