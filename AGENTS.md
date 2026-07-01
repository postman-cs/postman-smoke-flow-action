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
npm run verify:dist  # CI/hook gate: rebuild + git diff (dev runs build)
```

## Key Behaviors

- **Access-token gateway reshape**: All collection operations run through the Postman gateway under `postman-access-token` (required) via `PostmanGatewaySmokeClient` — generate the temporary collection from the spec (`specification` service), read it with `GET /v3/collections/:cid/export`, full-replace reconcile the canonical collection (delete every item, recreate the curated leaves with v3 IR fields, patch per-item `/scripts`, patch collection-level name/auth/variables via `PATCH /v3/collections/:cid`), then delete the temporary collection. `postman-api-key` is optional and feeds `AccessTokenProvider` only to re-mint an expired access token; it never drives a collection mutation. A run without `postman-access-token` fails fast in `createSmokeClient`.
- **Flow apply**: Loads the curated `flow.yaml`, resolves each step against the generated Smoke collection, and rewrites the canonical collection so request order, chaining, and variables match the flow.
- **OAuth2 (optional)**: When configured, seeds collection variables and a pre-request script that mints a `client_credentials` bearer token, then applies that token as per-request bearer auth so the smoke run authenticates before exercising endpoints.
- **Idempotent reshape**: Operates on the existing canonical Smoke collection by id and transforms it in place.

## Gotchas

- `main.cjs` is the Action entry (not `index.cjs` as in sibling actions); the CLI is `cli.cjs`. Wire pre-write logic into both.
- The flow is applied to the collection bootstrap generated; this action assumes that collection already exists (it does not generate one).
