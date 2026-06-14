# Smoke OAuth Configuration

`auth-config-json` enables collection-level token acquisition for protected Smoke collections. V1 supports `oauth2` with the `client_credentials` grant and `clientAuthentication: body`. This can be used with or without `flow-path`.

## Authentication matrix

| Credential | Purpose | Recommended source |
| --- | --- | --- |
| postman-api-key | Generates the temporary Smoke collection and updates the canonical Smoke collection. | GitHub Actions secret or CI secret. |
| postman-access-token | Compatibility-only input from broader onboarding pipelines. Smoke Flow masks it, logs a deprecation warning, and does not use it for collection updates. | Omit in standalone Smoke Flow jobs. Use postman-resolve-service-token-action only for the broader pipeline steps that need a service-account access token and team ID. |
| OAuth client credentials | Used by the Smoke collection at collection run time. | CI secrets or runtime variables passed to the collection runner. |

The Smoke collection:

- adds a collection-level pre-request script
- caches `access_token` and `access_token_expires_at` with `pm.variables.set()`
- applies `Authorization: Bearer {{access_token}}` to Smoke requests
- does not write runtime tokens or client secrets back to Postman environments

## Full configuration example

```yaml
with:
  auth-config-json: '{"enabled":true,"type":"oauth2","grantType":"client_credentials","tokenUrl":"{{auth_token_url}}","clientAuthentication":"body","variables":{"tokenUrl":"auth_token_url","scope":"auth_scope","clientId":"auth_client_id","clientSecret":"auth_client_secret","accessToken":"access_token","expiresAt":"access_token_expires_at"}}'
```

## Injecting runtime values

Runtime values should be injected by the caller, for example:

```sh
postman collection run "$POSTMAN_SMOKE_COLLECTION_UID" \
  -e "$POSTMAN_ENVIRONMENT_UID" \
  --env-var "auth_token_url=https://login.example.com/oauth2/token" \
  --env-var "auth_scope=api://service/.default" \
  --env-var "auth_client_id=${AUTH_CLIENT_ID}" \
  --env-var "auth_client_secret=${AUTH_CLIENT_SECRET}"
```
