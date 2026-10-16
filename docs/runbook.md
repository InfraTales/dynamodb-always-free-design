# Runbook

## DynamoDB throttles requests

In provisioned mode, a request over the table's or GSI's capacity fails with `ProvisionedThroughputExceededException`. The AWS SDK retries it on its own, so users first see slower responses, then errors.

1. In CloudWatch, compare `ConsumedWriteCapacityUnits` with `ProvisionedWriteCapacityUnits` (and the read pair) for the table and for `byAssignee`.
2. If the GSI is the one over its writes, DynamoDB throttles table writes too. It holds back writes to the table when an index can't keep up.
3. Find the access pattern. `TaskStore` reports `ConsumedCapacity` for every call through `onCapacity`. Log it with the pattern name and look for the biggest total.
4. Rerun `npm run budget` with the real rates. If the workload no longer fits, you have three options: make the pattern cheaper (smaller items, fewer projected attributes, eventually consistent reads), move capacity between the table and the GSI, or accept a bill by raising the plan.

## Moving between capacity modes

You can switch a table from on-demand to provisioned at any time. You can go from provisioned to on-demand up to four times in a rolling 24-hour window. Change the `billing` property in the stack and deploy. For on-demand, set `maxReadRequestUnits` and `maxWriteRequestUnits` to put a ceiling on cost.

## Decreasing capacity

DynamoDB allows 4 decreases at the start of each UTC day, plus 1 more each hour, up to 27 a day. Increases have no such limit.
