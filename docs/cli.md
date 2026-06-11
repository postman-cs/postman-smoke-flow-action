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
  --postman-api-key "$POSTMAN_API_KEY"
```

For OAuth-only updates before a flow manifest exists, omit `--flow-path`:

```sh
postman-smoke-flow \
  --project-name core-payments \
  --workspace-id "$POSTMAN_WORKSPACE_ID" \
  --spec-id "$POSTMAN_SPEC_ID" \
  --smoke-collection-id "$POSTMAN_SMOKE_COLLECTION_ID" \
  --auth-config-json '{"enabled":true,"type":"oauth2","grantType":"client_credentials","tokenUrl":"{{auth_token_url}}","clientAuthentication":"body"}' \
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
