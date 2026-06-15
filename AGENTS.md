# postman-smoke-flow-action

Reshapes the generated Postman Smoke collection to match a curated `flow.yaml`, with optional OAuth2 token acquisition. Runs as a standalone step that consumes bootstrap's `smoke-collection-id` output. Dual entry: GitHub Action (`dist/main.cjs`) and CLI (`dist/cli.cjs`, bin `postman-smoke-flow`).

## Structure

```
src/
  index.ts                       # GitHub Action entry: reads inputs, applies flow, sets outputs
  cli.ts                         # CLI adapter for non-GitHub CI
  main.ts                        # Core orchestration: load flow.yaml -> transform -> write collection
  contracts.ts                   # Input/output type definitions
  types.ts                       # Shared flow + collection types
  flow/
    parser.ts                    # Parse curated flow.yaml
    resolver.ts                  # Resolve flow steps against the generated Smoke collection
    validator.ts                 # Validate flow shape and references
  postman/
    postman-smoke-client.ts      # Postman API client (collection fetch/update)
    collection-transform.ts      # Reorder/reshape requests to match the flow
    scripts.ts                   # Injected pre-request/test scripts (chaining, OAuth2)
  lib/
    cli-args.ts                  # CLI flag parsing
    errors.ts, error-advice.ts   # Typed errors + user-facing remediation hints
    logging.ts                   # Reporter (stderr logs, stdout JSON in CLI mode)
    paths.ts                     # Path resolution helpers
tests/
```

## Commands

```bash
npm ci && npm test && npm run typecheck && npm run build
npm run check:dist   # build + git diff --exit-code (CI integrity)
```

## Key Behaviors

- **Flow apply**: Loads the curated `flow.yaml`, resolves each step against the live Smoke collection, and rewrites the collection so request order, chaining, and variables match the flow.
- **OAuth2 (optional)**: When configured, injects token-acquisition scripts so the smoke run authenticates before exercising endpoints.
- **Idempotent reshape**: Operates on the existing canonical Smoke collection by id; it transforms in place rather than creating a parallel collection.

## Gotchas

- `main.cjs` is the Action entry (not `index.cjs` as in sibling actions); the CLI is `cli.cjs`. Wire pre-write logic into both.
- The flow is applied to the collection bootstrap generated; this action assumes that collection already exists (it does not generate one).
