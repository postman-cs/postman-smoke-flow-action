# postman-smoke-flow-action

Public customer preview GitHub Action that applies a curated `flow.yaml` to the canonical Postman Smoke collection produced by bootstrap.

## Purpose

This action is designed to be chained directly after `postman-bootstrap-action` and before `postman-repo-sync-action`.

It:

- reads `flow.yaml`
- generates a temporary Smoke collection from the current spec
- reshapes that generated collection to match the curated flow
- injects prerequest and test scripts from bindings and extracts
- optionally adds Smoke-only OAuth2 client-credentials token acquisition
- updates the canonical Smoke collection in place
- deletes the temporary collection

## Usage

```yaml
jobs:
  onboarding:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - id: bootstrap
        uses: postman-cs/postman-bootstrap-action@v0
        with:
          project-name: core-payments
          spec-url: https://example.com/openapi.yaml
          postman-api-key: ${{ secrets.POSTMAN_API_KEY }}

      - id: smoke_flow
        uses: postman-cs/postman-smoke-flow-action@v0
        with:
          project-name: core-payments
          workspace-id: ${{ steps.bootstrap.outputs.workspace-id }}
          spec-id: ${{ steps.bootstrap.outputs.spec-id }}
          smoke-collection-id: ${{ steps.bootstrap.outputs.smoke-collection-id }}
          flow-path: .postman-api-launchpad/flows/core-payments/flow.yaml
          postman-api-key: ${{ secrets.POSTMAN_API_KEY }}

      - id: repo_sync
        uses: postman-cs/postman-repo-sync-action@v0
        with:
          project-name: core-payments
          workspace-id: ${{ steps.bootstrap.outputs.workspace-id }}
          baseline-collection-id: ${{ steps.bootstrap.outputs.baseline-collection-id }}
          smoke-collection-id: ${{ steps.smoke_flow.outputs.smoke-collection-id }}
          contract-collection-id: ${{ steps.bootstrap.outputs.contract-collection-id }}
          environments-json: '["prod"]'
          env-runtime-urls-json: '{"prod":"https://api.example.com"}'
          postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
```

## CLI Usage (Non-GitHub CI)

The npm package also ships a `postman-smoke-flow` binary for GitLab CI, Bitbucket Pipelines, Azure DevOps, Jenkins, and local validation jobs.

```sh
npm install -g @postman-cse/onboarding-smoke-flow

postman-smoke-flow \
  --project-name core-payments \
  --workspace-id "$POSTMAN_WORKSPACE_ID" \
  --spec-id "$POSTMAN_SPEC_ID" \
  --smoke-collection-id "$POSTMAN_SMOKE_COLLECTION_ID" \
  --flow-path .postman-api-launchpad/flows/core-payments/flow.yaml \
  --spec-path api/openapi.yaml \
  --postman-api-key "$POSTMAN_API_KEY"
```

Every action input is available as the same kebab-case CLI flag. The CLI writes the action outputs as JSON to stdout and writes logs to stderr, so other CI systems can capture IDs without GitHub Actions output files.

For one-off runs without a global install:

```sh
npx --package @postman-cse/onboarding-smoke-flow postman-smoke-flow \
  --project-name core-payments \
  --workspace-id "$POSTMAN_WORKSPACE_ID" \
  --spec-id "$POSTMAN_SPEC_ID" \
  --smoke-collection-id "$POSTMAN_SMOKE_COLLECTION_ID" \
  --flow-path .postman-api-launchpad/flows/core-payments/flow.yaml \
  --postman-api-key "$POSTMAN_API_KEY"
```

## Inputs

| Input | Default | Notes |
| --- | --- | --- |
| `project-name` | | Service name used for temporary collection naming. |
| `workspace-id` | | Postman workspace ID from bootstrap. |
| `spec-id` | | Postman spec ID from bootstrap. |
| `smoke-collection-id` | | Canonical Smoke collection ID to refresh in place. |
| `flow-path` | | Repo-root-relative path to the curated `flow.yaml`. |
| `postman-api-key` | | Required Postman API key. |
| `auth-config-json` | | Optional Smoke-only OAuth2 client-credentials config. If omitted or disabled, behavior is unchanged. |
| `secrets-resolver-enabled` | `true` | Include the legacy AWS Secrets Manager resolver request before Smoke steps. Set to `false` to opt out. |
| `spec-path` | | Optional local spec path for validation/debugging. |
| `collection-sync-mode` | `refresh` | Refresh is the supported v1 mode. |
| `postman-access-token` | | Reserved for future internal integrations. |
| `fail-on-flow-warning` | `false` | Fail the action on warnings. |
| `keep-temp-collection-on-failure` | `false` | Keep the temp collection for debugging. |
| `temp-collection-prefix` | `[Smoke][Temp]` | Prefix for generated temporary Smoke collections. |

## Outputs

| Output | Notes |
| --- | --- |
| `smoke-collection-id` | Canonical Smoke collection ID after apply. |
| `flow-apply-status` | `success`, `failed`, or `skipped`. |
| `flow-apply-summary-json` | JSON summary of resolved steps, bindings, extracts, assertions, and warnings. |
| `temporary-smoke-collection-id` | Temp collection used during refresh. |
| `flow-step-count` | Number of flow steps. |
| `resolved-operation-count` | Number of resolved requests. |
| `applied-binding-count` | Number of bindings applied. |
| `applied-extract-count` | Number of extracts applied. |
| `assertion-count` | Number of generated assertions. |

## Flow expectations

V1 expects a single smoke flow manifest shaped like:

```yaml
spec:
  fileName: openapi.yaml
  title: Payments API
  version: 1.0.0
flows:
  - name: Payments API happy path
    type: smoke
    steps:
      - stepKey: create-payment-1
        operationId: createPayment
        bindings: []
        extract:
          - variable: createPayment.paymentId
            jsonPath: $.paymentId
      - stepKey: get-payment-by-id-2
        operationId: getPaymentById
        bindings:
          - fieldKey: paymentId
            source: prior_output
            sourceStepKey: create-payment-1
            variable: createPayment.paymentId
        extract: []
```

## Optional Smoke OAuth

`auth-config-json` enables collection-level token acquisition for protected Smoke collections. V1 supports `oauth2` with the `client_credentials` grant and `clientAuthentication: body`.

The generated collection:

- adds a collection-level pre-request script
- caches `access_token` and `access_token_expires_at` with `pm.variables.set()`
- applies `Authorization: Bearer {{access_token}}` to Smoke requests
- does not write runtime tokens or client secrets back to Postman environments

Example:

```yaml
with:
  auth-config-json: '{"enabled":true,"type":"oauth2","grantType":"client_credentials","tokenUrl":"{{auth_token_url}}","clientAuthentication":"body","variables":{"tokenUrl":"auth_token_url","scope":"auth_scope","clientId":"auth_client_id","clientSecret":"auth_client_secret","accessToken":"access_token","expiresAt":"access_token_expires_at"}}'
```

Runtime values should be injected by the caller, for example:

```sh
postman collection run "$POSTMAN_SMOKE_COLLECTION_UID" \
  -e "$POSTMAN_ENVIRONMENT_UID" \
  --env-var "auth_token_url=https://login.example.com/oauth2/token" \
  --env-var "auth_scope=api://service/.default" \
  --env-var "auth_client_id=${AUTH_CLIENT_ID}" \
  --env-var "auth_client_secret=${AUTH_CLIENT_SECRET}"
```

## Notes

- The action first tries to resolve each flow step by matching the generated request name or description to the step `operationId`.
- If `spec-path` is provided, it can also fall back to matching by request method plus normalized path shape from the OpenAPI document.
- In v1, one `flow.yaml` maps to one curated Smoke collection journey.
- This action intentionally does not mutate baseline or contract collections.
- OAuth support is optional and Smoke-only; contract collection auth is intentionally deferred.

## Local development

```sh
npm ci
npm run lint
npm test
npm run typecheck
npm run build
npm run check:dist
```

`npm run build` produces the committed `dist/main.cjs` action bundle used by `action.yml` and `dist/cli.cjs` for the portable CLI.

## Customer Preview Release Strategy

- Publish immutable `v0.x.y` tags for releases.
- Keep the rolling `v0` tag aligned to the latest customer preview release.
- Run CI before tagging so lint, tests, typecheck, bundle integrity, and actionlint all pass.
