import { batchGetReadUnits, indexEntry, itemSize, queryReadUnits, readUnits, writeCost, writeUnits } from '../../src/capacity';
import { BY_ASSIGNEE, type IndexSchema } from '../../src/schema';

describe('item size', () => {
  test('counts attribute names and UTF-8 bytes of string values', () => {
    expect(itemSize({ pk: 'abc' })).toBe(2 + 3);
    // "é" is 2 bytes in UTF-8, so the name and value cost more than their length.
    expect(itemSize({ café: 'é' })).toBe(5 + 2);
  });

  test('counts about 1 byte per 2 significant digits for numbers, plus 1', () => {
    expect(itemSize({ n: 1 })).toBe(1 + 2);
    expect(itemSize({ n: 1234 })).toBe(1 + 3);
    expect(itemSize({ n: 1000 })).toBe(1 + 2); // trailing zeros are trimmed
    expect(itemSize({ expiresAt: 1763208000 })).toBe(9 + 5);
  });

  test('refuses attribute types it does not model instead of guessing', () => {
    expect(() => itemSize({ tags: ['a', 'b'] })).toThrow(/doesn't model/);
  });
});

describe('read units', () => {
  test('a read up to 4 KB costs 0.5 eventually consistent, 1 strongly consistent, 2 in a transaction', () => {
    expect(readUnits(4096, 'eventual')).toBe(0.5);
    expect(readUnits(4096, 'strong')).toBe(1);
    expect(readUnits(4096, 'transactional')).toBe(2);
  });

  test('one byte over 4 KB starts a second block', () => {
    expect(readUnits(4097, 'eventual')).toBe(1);
    expect(readUnits(4097, 'strong')).toBe(2);
  });

  test('a read of nothing still costs one block', () => {
    expect(readUnits(0, 'eventual')).toBe(0.5);
  });

  test('a query adds sizes up and rounds once; a batch get rounds every item', () => {
    const tenSmall = Array.from({ length: 10 }, (_, i) => ({ pk: 'p', sk: String(i), body: 'x'.repeat(480) }));
    expect(queryReadUnits(tenSmall, 'eventual')).toBe(1); // about 4.9 KB, 2 blocks
    expect(batchGetReadUnits(tenSmall, 'eventual')).toBe(5); // 10 blocks
  });
});

describe('write units', () => {
  test('1 KB blocks, doubled in a transaction', () => {
    expect(writeUnits(1024)).toBe(1);
    expect(writeUnits(1025)).toBe(2);
    expect(writeUnits(1025, true)).toBe(4);
    expect(writeUnits(10)).toBe(1);
  });
});

describe('write cost with a GSI', () => {
  const task = { pk: 'P', sk: 'TASK#1', title: 'T', status: 'OPEN', description: 'd'.repeat(600), gsi1pk: 'U#a', gsi1sk: 'DUE#1' };

  test('an item without the index keys costs the index nothing (sparse index)', () => {
    const { gsi1pk: _a, gsi1sk: _b, ...unassigned } = task;
    expect(writeCost(undefined, unassigned, [BY_ASSIGNEE])).toEqual({ table: 1, indexes: {} });
  });

  test('a new item in the index costs one index write', () => {
    expect(writeCost(undefined, task, [BY_ASSIGNEE])).toEqual({ table: 1, indexes: { byAssignee: 1 } });
  });

  test('changing an attribute the index does not project costs the index nothing', () => {
    expect(writeCost(task, { ...task, status: 'IN_PROGRESS' }, [BY_ASSIGNEE]).indexes).toEqual({});
  });

  test('changing a projected attribute costs one index write', () => {
    expect(writeCost(task, { ...task, title: 'New title' }, [BY_ASSIGNEE]).indexes).toEqual({ byAssignee: 1 });
  });

  test('changing an index key value costs two index writes: a delete and a put', () => {
    expect(writeCost(task, { ...task, gsi1pk: 'U#b' }, [BY_ASSIGNEE]).indexes).toEqual({ byAssignee: 2 });
  });

  test('removing the index keys costs one index write (the delete)', () => {
    const { gsi1pk: _a, gsi1sk: _b, ...done } = task;
    expect(writeCost(task, done, [BY_ASSIGNEE]).indexes).toEqual({ byAssignee: 1 });
  });

  test('the table pays for the bigger of the old and new item', () => {
    const big = { ...task, description: 'd'.repeat(2500) };
    expect(writeCost(big, task, [BY_ASSIGNEE]).table).toBe(3);
  });

  test('projecting ALL makes index writes as big as the item', () => {
    const all: IndexSchema = { ...BY_ASSIGNEE, projection: { type: 'ALL' } };
    const big = { ...task, description: 'd'.repeat(2500) };
    expect(writeCost(undefined, big, [all]).indexes).toEqual({ byAssignee: 3 });
    expect(writeCost(undefined, big, [BY_ASSIGNEE]).indexes).toEqual({ byAssignee: 1 });
    expect(itemSize(indexEntry(big, all)!)).toBeGreaterThan(2048);
  });
});
