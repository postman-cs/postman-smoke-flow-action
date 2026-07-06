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

For OAuth updates before a flow manifest exists, omit `--flow-path`. The CLI still refreshes the canonical Smoke collection from a spec-generated temporary collection before applying auth:

```sh
postman-smoke-flow \
  --project-name core-payments \
  --workspace-id "$POSTMAN_WORKSPACE_ID" \
  --spec-id "$POSTMAN_SPEC_ID" \
  --smoke-collection-id "$POSTMAN_SMOKE_COLLECTION_ID" \
  --auth-config-json '{"enabled":true,"type":"oauth2","grantType":"client_credentials","tokenUrl":"{{auth_token_url}}","clientAuthentication":"body"}' \
  --postman-region eu \
  --postman-access-token "$POSTMAN_ACCESS_TOKEN"
```

For API key auth updates before a flow manifest exists, omit `--flow-path` and pass an API key auth config. The CLI still refreshes the canonical Smoke collection from a spec-generated temporary collection before applying auth. The real target API key is supplied later when the Smoke collection runs:

```sh
postman-smoke-flow \
  --project-name core-payments \
  --workspace-id "$POSTMAN_WORKSPACE_ID" \
  --spec-id "$POSTMAN_SPEC_ID" \
  --smoke-collection-id "$POSTMAN_SMOKE_COLLECTION_ID" \
  --auth-config-json '{"enabled":true,"type":"apiKey","in":"header","name":"X-API-Key","variables":{"apiKey":"service_api_key"}}' \
  --postman-region eu \
  --postman-access-token "$POSTMAN_ACCESS_TOKEN"
```

Every action input is available as the same kebab-case CLI flag. The CLI writes the action outputs as JSON to stdout and writes logs to stderr, so other CI systems can capture IDs without GitHub Actions output files.

## Credentials and regions

Use POSTMAN_ACCESS_TOKEN for collection generation and updates. Mint it with postman-resolve-service-token-action in GitHub Actions, or with the same service-account token process used by the surrounding onboarding pipeline. POSTMAN_API_KEY is optional and is used only to re-mint an expired access token.

When service-account minting is unavailable, use the Postman CLI credential store created by `postman login` as the fallback source.

Use --postman-region us for https://api.getpostman.com and --postman-region eu for https://api.eu.postman.com. The default is us.

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
