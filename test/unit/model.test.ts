import { activityItem, checkId, taskIndexKeys, taskItem, toTask, ACTIVITY_RETENTION_SECONDS } from '../../src/model';
import * as f from '../../src/fixtures';

test('every key starts with the tenant', () => {
  const item = taskItem(f.newTask);
  expect(item.pk).toBe('TENANT#acme#PROJECT#website');
  expect(item.sk).toBe('TASK#task-new');
  expect(item.gsi1pk).toBe('TENANT#acme#USER#maria');
});

test('ids with a # are refused, so one tenant cannot write keys that look like another tenant', () => {
  expect(() => checkId('tenantId', 'acme#USER#x')).toThrow();
  expect(() => taskItem({ ...f.newTask, tenantId: 'a#b' })).toThrow(/tenantId/);
});

test('only open, assigned tasks get index keys', () => {
  expect(taskIndexKeys({ ...f.newTask, status: 'DONE' })).toEqual({});
  const { assignee: _unused, ...unassigned } = f.newTask;
  expect(taskIndexKeys(unassigned)).toEqual({});
  expect(taskIndexKeys(f.newTask)).toEqual({ gsi1pk: 'TENANT#acme#USER#maria', gsi1sk: 'DUE#2026-11-20#task-new' });
});

test('status is not part of the index keys, so starting a task leaves the index alone', () => {
  expect(taskIndexKeys({ ...f.newTask, status: 'IN_PROGRESS' })).toEqual(taskIndexKeys(f.newTask));
});

test('a task without a due date sorts last in the index', () => {
  const { due: _unused, ...noDue } = f.newTask;
  expect(taskIndexKeys(noDue).gsi1sk).toBe('DUE#9999-12-31#task-new');
});

test('a task survives the round trip to an item and back', () => {
  expect(toTask(taskItem(f.newTask))).toEqual(f.newTask);
});

test('activity expires 30 days after it happened, in epoch seconds', () => {
  const item = activityItem(f.newActivity);
  expect(item.expiresAt).toBe(Date.parse(f.NOW) / 1000 + ACTIVITY_RETENTION_SECONDS);
  expect(ACTIVITY_RETENTION_SECONDS).toBe(2_592_000);
});
