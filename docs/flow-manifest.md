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

- The action resolves each flow step through match tiers, strongest first: exact or case-insensitive generated request **name**, then request **method plus normalized path** from the OpenAPI document (when `spec-path` is provided), then a **description substring** — a weak signal used only when no strong tier matched anywhere in the collection, and always accompanied by a warning naming the resolved request. Weak-tier warnings pass through `fail-on-flow-warning` before any canonical mutation.
- In v1, one `flow.yaml` maps to one curated Smoke collection journey.
- Under `flow-mode: auto` (the default), the action resolves one effective path: explicit `flow-path`, or `postman/flow.yaml` when omitted. A valid manifest at that path is curated; an invalid manifest is a hard error and is never derived over. When the path is absent and `spec-path` is set, the action derives a deterministic smoke flow from `spec-path` (see [derived-flow.md](derived-flow.md)); a zero-step derivation (no operations, or every operation excluded) is also a hard error rather than an uncurated fallback. After a successful derived apply, it creates the manifest at that same path unless `persist-derived-flow: false`, so the next run is curated.
- `flow-mode: curated` requires an explicit, existing `flow-path`; it does not use the default path. `flow-mode: off` does not read or write a manifest and refreshes without flow curation.
- This action intentionally does not mutate baseline or contract collections.
- Runtime auth support is optional and Smoke-only; contract collection auth is intentionally deferred.

## What flow mode does

When a valid manifest exists at the effective path in auto mode, or at the explicit `flow-path` in curated mode, the action:

- reads `flow.yaml`
- generates a temporary Smoke collection from the current spec
- reshapes that generated collection to match the curated flow
- injects prerequest and test scripts from bindings and extracts
- optionally adds Smoke-only runtime auth, such as OAuth2 client credentials or API key auth
- updates the canonical Smoke collection in place
- deletes the temporary collection

In auto mode, when no manifest exists at the effective path and `spec-path` is set, the action instead **derives** a flow from the OpenAPI document and applies it through this same pipeline ([derived-flow.md](derived-flow.md)). If derivation yields zero steps, the action fails rather than falling back to the uncurated refresh; otherwise it create-only persists the derived manifest at that path unless `persist-derived-flow: false`, and the next run is curated. Only in auto mode with no manifest and no `spec-path` does it fall back to the uncurated refresh. `flow-mode: off` always follows that uncurated path without reading or writing the manifest: it still generates a temporary Smoke collection from the spec and refreshes the canonical Smoke collection from that generated collection. If `auth-config-json` is enabled, it injects Smoke-only runtime auth without adding flow scripts, bindings, extracts, or curated ordering.
