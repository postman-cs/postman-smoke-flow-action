# Mixed runtime authentication

Use `auth-plan-path` when one generated Smoke collection contains operations with different authentication requirements. The plan maps every active OpenAPI `operationId` to an OAuth2, API key, or explicit `noauth` profile.

```yaml
version: 1
profiles:
  payments-entra:
    type: oauth2
    grantType: client_credentials
    clientAuthentication: body
    tokenUrl: "{{ENTRA_ID_URL}}"
    scope: "{{PAYMENTS_CLIENT_ID}}/.default"
    variables:
      clientId: APIM_CLIENT_ID
      clientSecret: APIM_CLIENT_SECRET
      accessToken: PAYMENTS_TOKEN
      expiresAt: PAYMENTS_TOKEN_EXPIRES_AT
  reports-key:
    type: apiKey
    in: header
    name: X-API-Key
    variables:
      apiKey: REPORTS_APIKEY
  health-public:
    type: noauth
targets:
  - operationId: createPayment
    profile: payments-entra
  - operationId: getReport
    profile: reports-key
  - operationId: getHealth
    profile: health-public
```

The collection root is set to `noauth`. Each request receives its assigned auth. OAuth token acquisition runs in that request's pre-request script and caches the token in `pm.variables` only for the current run. A new run starts without a cached token. Token values are never written to the plan or collection artifact.

All active requests must have exactly one target. Curated flows may select only a subset of valid targets. `auth-plan-path` and the legacy single-auth `auth-config-json` input cannot be used together.

Run from any supported CI system with the CLI:

```bash
postman-smoke-flow \
  --project-name mixed-api \
  --workspace-id "$POSTMAN_WORKSPACE_ID" \
  --spec-id "$POSTMAN_SPEC_ID" \
  --smoke-collection-id "$POSTMAN_SMOKE_COLLECTION_ID" \
  --spec-path generated/mixed.openapi.yaml \
  --flow-mode off \
  --auth-plan-path generated/mixed-auth.yaml \
  --postman-access-token "$POSTMAN_ACCESS_TOKEN" \
  --acknowledge-no-flow-refresh
```
