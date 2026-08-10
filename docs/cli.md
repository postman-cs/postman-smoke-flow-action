# CLI Usage (Non-GitHub CI)

The npm package ships a `postman-smoke-flow` binary for GitLab CI, Bitbucket Pipelines, Azure DevOps, Jenkins, and local validation jobs.

```sh
npm install -g @postman-cse/onboarding-smoke-flow

postman-smoke-flow \
  --project-name core-payments \
  --workspace-id "$POSTMAN_WORKSPACE_ID" \
  --spec-id "$POSTMAN_SPEC_ID" \
  --smoke-collection-id "$POSTMAN_SMOKE_COLLECTION_ID" \
  --flow-path .postman-api-launchpad/flows/core-payments/flow.yaml \
  --spec-path api/openapi.yaml \
  --postman-region eu \
  --postman-access-token "$POSTMAN_ACCESS_TOKEN"
```

Under `flow-mode` auto (default), omitting `--flow-path` with `--spec-path` set
derives a smoke flow from the spec and needs no acknowledgment. The example
below is the genuine uncurated path (no `--spec-path`): a destructive
full-canonical refresh that requires `--acknowledge-no-flow-refresh` so a
missing or typoed flow path cannot silently select that path. The CLI still
refreshes the canonical Smoke collection from a spec-generated temporary
collection before applying auth:

```sh
postman-smoke-flow \
  --project-name core-payments \
  --workspace-id "$POSTMAN_WORKSPACE_ID" \
  --spec-id "$POSTMAN_SPEC_ID" \
  --smoke-collection-id "$POSTMAN_SMOKE_COLLECTION_ID" \
  --acknowledge-no-flow-refresh \
  --auth-config-json '{"enabled":true,"type":"oauth2","grantType":"client_credentials","tokenUrl":"{{auth_token_url}}","clientAuthentication":"body"}' \
  --postman-region eu \
  --postman-access-token "$POSTMAN_ACCESS_TOKEN"
```

For API key auth updates before a flow manifest exists, use the same uncurated
path as above (no `--spec-path`, pass `--acknowledge-no-flow-refresh`) and pass
an API key auth config. The CLI still refreshes the canonical Smoke collection
from a spec-generated temporary collection before applying auth. The real target
API key is supplied later when the Smoke collection runs:

```sh
postman-smoke-flow \
  --project-name core-payments \
  --workspace-id "$POSTMAN_WORKSPACE_ID" \
  --spec-id "$POSTMAN_SPEC_ID" \
  --smoke-collection-id "$POSTMAN_SMOKE_COLLECTION_ID" \
  --acknowledge-no-flow-refresh \
  --auth-config-json '{"enabled":true,"type":"apiKey","in":"header","name":"X-API-Key","variables":{"apiKey":"service_api_key"}}' \
  --postman-region eu \
  --postman-access-token "$POSTMAN_ACCESS_TOKEN"
```

When `flow-mode` auto with `--spec-path` derives zero flow steps (empty spec or
all operations excluded), the CLI fails with an error naming the cause; it does
not silently fall back to the uncurated refresh. Correct the spec or exclusions,
pass `--flow-path`, or set `--flow-mode off`.

Every action input is available as the same kebab-case CLI flag. The CLI writes the action outputs as JSON to stdout and writes logs to stderr, so other CI systems can capture IDs without GitHub Actions output files.

## Credentials and regions

Use POSTMAN_ACCESS_TOKEN for collection generation and updates. Mint it with postman-resolve-service-token-action in GitHub Actions, or with the same service-account token process used by the surrounding onboarding pipeline. POSTMAN_API_KEY is optional and is used only to re-mint an expired access token.

When service-account minting is unavailable, use the Postman CLI credential store created by `postman login` as the fallback source.

Use --postman-region us for https://api.getpostman.com and --postman-region eu for https://api.eu.postman.com. The default is us.

## Create safety and workflow concurrency

Temporary collection generation and folder/request creates do not blind-retry
statusless transport failures, HTTP 408/429, or 5xx responses. Instead the
client reconciles by run-owned name / pre-run snapshot (generation) or by
parent folder identity plus sibling item name (folder/request creates).
Terminal failed generation tasks are retried only after the failed attempt's
run-owned temporary collection is positively reconciled and deleted.
Cleanup deletes only temporary collection IDs positively owned by the current
process.

There is no upstream cross-process lease or idempotency key for canonical
collection mutation. When multiple GitHub Actions jobs can reshape the same
Smoke collection, serialize them with a concurrency group keyed by that
collection id (and ideally workspace id). Example:

```yaml
concurrency:
  group: smoke-flow-${{ vars.POSTMAN_WORKSPACE_ID }}-${{ vars.POSTMAN_SMOKE_COLLECTION_ID }}
  cancel-in-progress: false
```

This reduces overlapping in-place reconciles; it does not make the Postman API
itself transactional across processes.

Job-level `concurrency` is evaluated before job steps. It cannot reference a
collection ID produced by a bootstrap step in that same job. For a chained
bootstrap -> Smoke Flow pipeline, use a workflow input/variable known before the
job starts, or a fixed project-scoped group such as:

```yaml
concurrency:
  group: smoke-flow-core-payments
  cancel-in-progress: false
```

For one-off runs without a global install:

```sh
npx --package @postman-cse/onboarding-smoke-flow postman-smoke-flow \
  --project-name core-payments \
  --workspace-id "$POSTMAN_WORKSPACE_ID" \
  --spec-id "$POSTMAN_SPEC_ID" \
  --smoke-collection-id "$POSTMAN_SMOKE_COLLECTION_ID" \
  --flow-path .postman-api-launchpad/flows/core-payments/flow.yaml \
  --postman-region eu \
  --postman-access-token "$POSTMAN_ACCESS_TOKEN"
```
