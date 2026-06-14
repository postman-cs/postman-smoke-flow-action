# flow.yaml Manifest Format

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

## Run order

Run this action after postman-bootstrap-action has created or refreshed the workspace, spec, and canonical Smoke collection. Run it before postman-repo-sync-action when the repo should receive the curated Smoke collection artifacts.

## Resolution behavior

- The action first tries to resolve each flow step by matching the generated request name or description to the step `operationId`.
- If `spec-path` is provided, it can also fall back to matching by request method plus normalized path shape from the OpenAPI document.
- In v1, one `flow.yaml` maps to one curated Smoke collection journey.
- If `flow-path` is omitted, the action does not generate a temporary collection, apply flow scripts, or reorder existing Smoke requests.
- If `flow-path` is provided but the file is missing, the action fails because the caller explicitly requested flow mode.
- This action intentionally does not mutate baseline or contract collections.
- OAuth support is optional and Smoke-only; contract collection auth is intentionally deferred.

## What flow mode does

When `flow-path` is provided, the action:

- reads `flow.yaml`
- generates a temporary Smoke collection from the current spec
- reshapes that generated collection to match the curated flow
- injects prerequest and test scripts from bindings and extracts
- optionally adds Smoke-only OAuth2 client-credentials token acquisition
- updates the canonical Smoke collection in place
- deletes the temporary collection

When `flow-path` is omitted and `auth-config-json` is enabled, it fetches the existing canonical Smoke collection and injects Smoke-only OAuth without recreating or reordering the collection.
