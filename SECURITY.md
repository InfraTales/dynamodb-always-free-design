# Security policy

## Reporting a problem

Please don't report security problems in public GitHub issues. Use GitHub's private vulnerability reporting on this repository (Security tab, then "Report a vulnerability").

It helps to include the file and line or the commit, the steps to reproduce, and what an attacker could do with it.

## How this design protects tenants

- Every key starts with the tenant ID, so one tenant's query can't read another tenant's items.
- The model accepts only letters, digits, `_` and `-` in IDs, so a `#` can't sneak in to forge a key.
- Creates are conditional, so a create never overwrites an existing project or task.
- The table has deletion protection and a retain policy, so a stack delete keeps the data.

The repo has no API or Lambda function. If you add one, take the tenant ID from the caller's verified identity, never from the request body.
