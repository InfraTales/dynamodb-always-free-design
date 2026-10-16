# Design

This file explains the key layout, the one GSI, and the capacity math behind each access pattern.

## Key layout

One table holds three item types. Every key starts with the tenant ID, so a query for one tenant can't return another tenant's items. The model checks IDs against `[A-Za-z0-9_-]`, which keeps a `#` out of them, so a caller can't forge a key that points into another tenant.

| Item | pk | sk | Size |
|---|---|---|---|
| Project | `TENANT#t` | `PROJECT#p` | about 80 bytes |
| Task | `TENANT#t#PROJECT#p` | `TASK#id` | about 650 bytes |
| Activity | `TENANT#t#PROJECT#p` | `ACTIVITY#time#id` | about 135 bytes |

Tasks and activity share a partition, so one project's tasks and its recent events are each one `Query`.

## The GSI: my open tasks

`byAssignee` has `gsi1pk = TENANT#t#USER#u` and `gsi1sk = DUE#date#id`. Three choices keep it cheap:

1. **It's sparse.** Only open, assigned tasks carry `gsi1pk`. Finished tasks leave the index, so they cost nothing to store or write there.
2. **Status is not in the key.** Moving a task from OPEN to IN_PROGRESS changes nothing in the index, so it costs 0 index writes. With status in the sort key, the same change would cost 2 (a delete and a put).
3. **It projects only `title` and `due`.** An index entry is about 150 bytes instead of 650. Twenty of them fit in one 4 KB read block, so "my open tasks" costs 0.5 RCU. With `ALL`, the same query costs 2 RCU.

Reassigning a task changes `gsi1pk`, which costs 2 index writes. That's the price of the access pattern, and it's fine at the planned rate of one every two seconds.

## Capacity math

The calculator in `src/capacity.ts` follows the DynamoDB Developer Guide:

- A read costs per 4 KB block: 0.5 units for a default read, 1 with `ConsistentRead: true`, and 2 in a transaction.
- A write costs one unit per 1 KB block, and 2 in a transaction.
- A `Query` adds up the size of every item it reads, then rounds up once. A filter expression doesn't lower the cost.
- A `Scan` reads, and pays for, every item in the table.
- `BatchGetItem` rounds each item up on its own.
- An update pays for the larger of the old and new item.
- Each GSI pays its own write capacity for every table write that changes its entry, sized by the index entry.

The DynamoDB Local tests compare the calculator with the `ConsumedCapacity` that Local reports. They agreed on all 11 patterns. Local is an emulator, though, so it ignores provisioned throughput and never throttles a request.

## TTL

Activity items carry `expiresAt`, 30 days after the event, in epoch seconds. DynamoDB deletes expired items within a few days, without using write capacity. Until then, expired items still come back from queries and still cost reads, so `listRecentActivity` filters them out.

## Auto scaling

CDK's `TableV2` doesn't accept fixed write capacity, only auto scaled. We pin the minimum to the maximum, so write capacity never moves. Scaling down inside the free tier saves nothing, and it leaves less unused capacity for DynamoDB to keep as burst capacity. We set read capacity as a fixed number, so it adds no auto scaling alarms.
