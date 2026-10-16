/**
 * The table's shape, in one place. The CDK stack, the capacity calculator and the
 * DynamoDB Local tests all read it, so they can't drift apart.
 */

export const TABLE_KEYS = { partitionKey: 'pk', sortKey: 'sk' } as const;

export interface IndexSchema {
  readonly name: string;
  readonly partitionKey: string;
  readonly sortKey: string;
  /** Non-key attributes copied into the index. Keys are always projected. */
  readonly projection: { readonly type: 'KEYS_ONLY' } | { readonly type: 'INCLUDE'; readonly attributes: readonly string[] } | { readonly type: 'ALL' };
}

/**
 * One GSI: "my open tasks". It's sparse: only assigned, unfinished tasks carry gsi1pk,
 * so finished tasks cost nothing to store or write in the index.
 *
 * The projection is the cost lever. Every byte projected here is written again on each
 * task write that touches the index, and read again on each "my tasks" query.
 */
export const BY_ASSIGNEE: IndexSchema = {
  name: 'byAssignee',
  partitionKey: 'gsi1pk',
  sortKey: 'gsi1sk',
  projection: { type: 'INCLUDE', attributes: ['title', 'due'] },
};

export const INDEXES: readonly IndexSchema[] = [BY_ASSIGNEE];

/** Activity items expire on their own. TTL deletes don't use write capacity. */
export const TTL_ATTRIBUTE = 'expiresAt';
