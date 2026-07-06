# Smoke API Key Configuration

`auth-config-json` can inject API key auth into the Smoke collection. This is for the target API under test, not the Postman service-account `postman-api-key`.

API key auth can be used with or without `flow-path`:

- With `flow-path`, the action applies API key auth while curating the generated Smoke collection.
- Without `flow-path`, the action updates the existing Smoke collection in place without recreating or reordering requests.

The action writes only placeholders to the collection. Inject the real API key at collection run time.

## Header API Key

```yaml
with:
  auth-config-json: '{"enabled":true,"type":"apiKey","in":"header","name":"X-API-Key","variables":{"apiKey":"service_api_key"}}'
```

The Smoke requests receive Postman API Key auth equivalent to:

```json
{
  "type": "apikey",
  "apikey": [
    { "key": "key", "value": "X-API-Key", "type": "string" },
    { "key": "value", "value": "{{service_api_key}}", "type": "string" },
    { "key": "in", "value": "header", "type": "string" }
  ]
}
```

Any generated raw `X-API-Key` header is removed from each Smoke request to avoid duplicate credentials.

## Query API Key

```yaml
with:
  auth-config-json: '{"enabled":true,"type":"apiKey","in":"query","name":"api_key","variables":{"apiKey":"service_api_key"}}'
```

Any generated raw query parameter with the same name is removed from each Smoke request to avoid duplicate credentials.

## Injecting Runtime Values

Runtime values should be injected by the caller, for example:

```sh
postman collection run "$POSTMAN_SMOKE_COLLECTION_UID" \
  -e "$POSTMAN_ENVIRONMENT_UID" \
  --env-var "service_api_key=${SMOKE_API_KEY}"
```

Do not put the real API key value in `auth-config-json`. The `variables.apiKey` field is the Postman variable name that the collection should reference.
