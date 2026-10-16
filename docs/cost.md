# Cost

Prices are for us-east-1, from the AWS Price List API offer file `AmazonDynamoDB/20260911124422`, checked on 2026-10-15.

## What the free tier covers

| Item | Free each month | Price after that |
|---|---|---|
| Provisioned write capacity | 25 WCU (18,600 WCU-hours) | $0.00065 per WCU-hour |
| Provisioned read capacity | 25 RCU (18,600 RCU-hours) | $0.00013 per RCU-hour |
| Storage, Standard table class | 25 GB | $0.25 per GB-month |
| DynamoDB Streams reads | 2.5 million | $0.0000002 per read request unit |

The allowance applies per Region and per payer account. It doesn't cover on-demand requests ($0.625 per million writes, $0.125 per million reads) or the Standard-IA table class.

At full use, the free capacity would cost $14.51 a month: 25 WCU x 744 hours x $0.00065 is $12.09, and 25 RCU x 744 hours x $0.00013 is $2.42.

## What can still bill

| Item | Why | Cost |
|---|---|---|
| CloudWatch alarms | AWS's auto scaling docs say it creates 4 alarms per scaled dimension. This stack scales two (table writes and GSI writes), so up to 8 | The CloudWatch free tier has 10 alarm metrics. After that, $0.10 per alarm metric per month |
| Point-in-time recovery | Off in this stack. No free tier | $0.20 per GB-month |
| Storage over 25 GB | Shared with every Standard table in the Region | $0.25 per GB-month |
| Capacity over 25 units | If you raise the plan, or other provisioned tables share the Region | About $0.47 per WCU and $0.09 per RCU for a 730-hour month |

We haven't deployed this stack, so the alarm count comes from the docs, not from a real account. Check CloudWatch after your first deploy.

## When on-demand is cheaper

On-demand has no free capacity, but it bills only for requests. The designed peak workload uses 16 read units and 12.1 write units per second. If that peak ran 8 hours a day for 22 workdays (633,600 seconds), on-demand would cost:

| | Request units | Cost |
|---|---|---|
| Reads | 10,137,600 | $1.27 |
| Writes | 7,666,560 | $4.79 |
| Total | | $6.06 a month |

The provisioned plan costs $0 for the same work. On-demand wins when traffic is spiky and the peaks pass 25 units, for example a nightly import of 100,000 items. Provisioned at 25 WCU, that import takes over an hour of throttled retries. On-demand finishes it at its own pace for $0.0625 a run.
