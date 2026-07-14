# postman-smoke-flow-action

Reshapes generated Postman Smoke collection to match curated `flow.yaml`, with optional OAuth2 token acquisition. Runs as standalone step that consumes bootstrap's `smoke-collection-id` output. Dual entry: GitHub Action (`dist/main.cjs`) and CLI (`dist/cli.cjs`, bin `postman-smoke-flow`).

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
    postman-gateway-smoke-client.ts # Live client: generate/read/reshape/delete via the access-token gateway
    postman-smoke-client.ts      # Legacy PMAK client; imported for its method types only (Pick<...>), never instantiated
    collection-transform.ts      # Reorder/reshape requests, seed OAuth vars + per-request bearer auth
    scripts.ts                   # Injected pre-request/test scripts (chaining, OAuth2 token mint)
    credential-identity.ts       # iapub session-identity preflight + memoized consumerType for telemetry
  lib/
    cli-args.ts                  # CLI flag parsing
    errors.ts, error-advice.ts   # Typed errors + user-facing remediation hints
    logging.ts                   # Reporter (stderr logs, stdout JSON in CLI mode)
    paths.ts                     # Path resolution helpers
    postman/
      gateway-client.ts          # AccessTokenGatewayClient: /ws/proxy envelope transport
      token-provider.ts          # AccessTokenProvider: holds the access token, re-mints from PMAK on 401
tests/
```

## Commands

```bash
npm ci && npm test && npm run typecheck && npm run build
npm run verify:dist:assert  # read-only dist contract (CI after one build)
npm run verify:dist         # rebuild + git diff + assert (hooks/release)
```

## Key Behaviors

- **Gateway reshape**: `postman-access-token` required. Temp gets unique run name. Create sends once. Ambiguous result uses read-back. Canonical must belong to workspace. Item listing is flat; parent `items` stubs define direct children. Adoption needs parent plus name. Duplicates fail. Cleanup deletes owned temp only. `postman-api-key` only refreshes token.
- **Flow apply**: Loads curated `flow.yaml`, resolves each step against generated Smoke collection, and rewrites canonical collection so request order, chaining, and variables match flow.
- **OAuth2 (optional)**: When configured, seeds collection variables and pre-request script that mints a `client_credentials` bearer token, then applies that token as per-request bearer auth so smoke run authenticates before exercising endpoints.
- **Idempotent reshape**: Canonical changes in place. API has no cross-process lease. Workflow must use `concurrency` key from canonical collection id.

## Gotchas

- `main.cjs` is Action entry (not `index.cjs` as in sibling actions); the CLI is `cli.cjs`. Wire pre-write logic into both.
- flow is applied to collection bootstrap generated; this action assumes that collection already exists (it does not generate one).

## CI

`.github/workflows/ci.yml` runs one build before its single `gate` job fans out
lint, test, typecheck, read-only verify:dist:assert, commitlint, and actionlint on one
runner. Building before fan-out prevents pack tests from racing dist rebuild.
Every gate prints its result under a `::group::` block even when another fails.

See workspace `../../docs/CI.md` for shared rationale.
Never log, commit, or embed access tokens, PMAKs, or other secrets; mask output via `createSecretMasker()`.
