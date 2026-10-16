# Contributing

Thanks for helping. This repo shows how to keep a DynamoDB design inside the always-free tier, so every change has to keep the capacity numbers true.

## Setup

You need Node.js 24 and npm. Docker is only needed for the integration tests.

```bash
npm ci
npm run check
docker run -d --rm -p 8013:8000 amazon/dynamodb-local:3.3.2
AWS_ENDPOINT_URL_DYNAMODB=http://localhost:8013 npm run test:int
```

## Layout

| Path | What's there |
|---|---|
| `src/schema.ts` | Table keys, the GSI and its projection. The stack and the tests both read it |
| `src/capacity-plan.ts` | How the 25 RCU and 25 WCU are split |
| `src/capacity.ts` | The capacity calculator |
| `src/workload.ts` | Peak rate and cost of each access pattern, and the budget |
| `src/task-store.ts` | The data layer, one method per access pattern |
| `infra/` | The CDK stack |
| `test/unit`, `test/infra` | Tests that run with `npm test` |
| `test/integration` | Every access pattern against DynamoDB Local |

## What a change needs

- **A new or changed access pattern** needs a row in `src/workload.ts`, a prediction in `test/support/predictions.ts`, and a runner in the integration test. The measured cost must match both.
- **A change to the plan** must keep the totals at or under 25. The stack and the tests refuse anything bigger.
- **A test that fails without the change.** For a bug, write the failing test first.

## Mutation checks

Each of these was broken once on purpose, and a test failed each time:

| Break | Caught by |
|---|---|
| `getTask` made strongly consistent | Integration only: measured 1 RCU instead of 0.5, and the budget |
| GSI projection set to `ALL` | Unit, template and integration tests |
| GSI write max raised in the plan | Stack guard, unit and template tests |
| Write max raised in the stack only | Template tests |
| Status added to the GSI sort key | Unit and integration tests |
| Finishing a task leaves it in the GSI | Integration tests |
| TTL filter removed from recent activity | Integration tests |
| Create condition removed | Integration tests |
| Calculator rounds a query per item | Unit and integration tests |

## Pull requests

Branch from `main`, keep each pull request to one change, and explain why in the description. CI must pass before merge.

Found a security problem? Don't open a public issue. [SECURITY.md](SECURITY.md) says where to send it.
