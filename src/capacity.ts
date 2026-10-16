/**
 * Capacity math from item sizes, following the rules in the DynamoDB Developer Guide:
 * reads in 4 KB blocks, writes in 1 KB blocks, and GSI writes sized by the index entry.
 *
 * It exists for two reasons. You can plan a budget before you have traffic, and the
 * DynamoDB Local tests compare its answers with the ConsumedCapacity that Local reports.
 */
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { marshall, type NativeAttributeValue } from '@aws-sdk/util-dynamodb';
import { TABLE_KEYS, type IndexSchema } from './schema';

export type Item = Record<string, NativeAttributeValue>;
export type Consistency = 'eventual' | 'strong' | 'transactional';

const READ_BLOCK = 4096;
const WRITE_BLOCK = 1024;
const READ_UNITS_PER_BLOCK: Record<Consistency, number> = { eventual: 0.5, strong: 1, transactional: 2 };

const utf8 = (s: string): number => Buffer.byteLength(s, 'utf8');

/** A number costs about 1 byte per 2 significant digits, plus 1 byte. */
function numberSize(n: string): number {
  const digits = n.replace(/^[-+]/, '').replace(/[eE].*$/, '').replace('.', '').replace(/^0+/, '').replace(/0+$/, '');
  return Math.ceil(Math.max(digits.length, 1) / 2) + 1;
}

function valueSize(v: AttributeValue): number {
  if (v.S !== undefined) return utf8(v.S);
  if (v.N !== undefined) return numberSize(v.N);
  if (v.B !== undefined) return v.B.byteLength;
  if (v.BOOL !== undefined || v.NULL !== undefined) return 1;
  // Lists, maps and sets have their own overhead rules. This app doesn't store them,
  // so we refuse rather than guess.
  throw new Error(`itemSize doesn't model ${Object.keys(v).join(',')} attributes`);
}

/** Item size in bytes: every attribute name plus its value. */
export function itemSize(item: Item): number {
  const attrs = marshall(item, { removeUndefinedValues: true });
  let size = 0;
  for (const [name, value] of Object.entries(attrs)) size += utf8(name) + valueSize(value);
  return size;
}

/** Read units for one GetItem, or for one Query/Scan page given the total bytes it evaluated. */
export function readUnits(bytes: number, consistency: Consistency): number {
  const blocks = Math.max(1, Math.ceil(bytes / READ_BLOCK));
  return blocks * READ_UNITS_PER_BLOCK[consistency];
}

/** A Query adds up every item it evaluates (filters don't help), then rounds up once. */
export function queryReadUnits(items: readonly Item[], consistency: Exclude<Consistency, 'transactional'>): number {
  return readUnits(items.reduce((sum, item) => sum + itemSize(item), 0), consistency);
}

/** BatchGetItem rounds each item up on its own, so ten small items cost ten reads. */
export function batchGetReadUnits(items: readonly Item[], consistency: Exclude<Consistency, 'transactional'>): number {
  return items.reduce((sum, item) => sum + readUnits(itemSize(item), consistency), 0);
}

export function writeUnits(bytes: number, transactional = false): number {
  return Math.max(1, Math.ceil(bytes / WRITE_BLOCK)) * (transactional ? 2 : 1);
}

/** The copy of an item that lives in the index, or undefined if the item isn't in it (sparse). */
export function indexEntry(item: Item | undefined, index: IndexSchema): Item | undefined {
  if (!item || item[index.partitionKey] === undefined || item[index.sortKey] === undefined) return undefined;
  if (index.projection.type === 'ALL') return { ...item };
  const keep = new Set<string>([TABLE_KEYS.partitionKey, TABLE_KEYS.sortKey, index.partitionKey, index.sortKey]);
  if (index.projection.type === 'INCLUDE') index.projection.attributes.forEach((a) => keep.add(a));
  return Object.fromEntries(Object.entries(item).filter(([k]) => keep.has(k)));
}

const sameKeys = (a: Item, b: Item, index: IndexSchema) =>
  a[index.partitionKey] === b[index.partitionKey] && a[index.sortKey] === b[index.sortKey];

const sameEntry = (a: Item, b: Item) => JSON.stringify(marshall(a)) === JSON.stringify(marshall(b));

export interface WriteCost {
  readonly table: number;
  readonly indexes: Record<string, number>;
}

/**
 * Write units for one single-item write (PutItem, UpdateItem or DeleteItem).
 * Pass the item as it was before (undefined for a new item) and after (undefined for a delete).
 *
 * The table pays for the larger of the two versions. Each index pays:
 * - nothing if the item isn't in it before or after, or its entry didn't change
 * - one write when the entry appears, disappears, or changes in place
 * - two writes (a delete and a put) when an index key value changes
 */
export function writeCost(before: Item | undefined, after: Item | undefined, indexes: readonly IndexSchema[]): WriteCost {
  const table = writeUnits(Math.max(before ? itemSize(before) : 0, after ? itemSize(after) : 0));
  const perIndex: Record<string, number> = {};
  for (const index of indexes) {
    const old = indexEntry(before, index);
    const next = indexEntry(after, index);
    let units = 0;
    if (old && next) {
      if (!sameKeys(old, next, index)) units = writeUnits(itemSize(old)) + writeUnits(itemSize(next));
      else if (!sameEntry(old, next)) units = writeUnits(Math.max(itemSize(old), itemSize(next)));
    } else if (old) {
      units = writeUnits(itemSize(old));
    } else if (next) {
      units = writeUnits(itemSize(next));
    }
    if (units > 0) perIndex[index.name] = units;
  }
  return { table, indexes: perIndex };
}
