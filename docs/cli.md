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
  --postman-region eu \
  --postman-api-key "$POSTMAN_API_KEY"
```

Every action input is available as the same kebab-case CLI flag. The CLI writes the action outputs as JSON to stdout and writes logs to stderr, so other CI systems can capture IDs without GitHub Actions output files.

## Credentials and regions

Use POSTMAN_API_KEY for collection generation and updates. When the surrounding onboarding pipeline needs a service-account access token and team ID, run postman-resolve-service-token-action before bootstrap or the composite action.

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
  --postman-api-key "$POSTMAN_API_KEY"
```
