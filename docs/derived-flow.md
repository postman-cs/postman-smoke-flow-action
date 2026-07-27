# Derived Smoke Flows

Under `flow-mode: auto` (the default), when no curated `flow.yaml` is provided via `flow-path`, the action derives a smoke flow deterministically from the OpenAPI document at `spec-path`. The derived flow uses the exact same `FlowDefinition` shape as a curated manifest, so resolution, script injection, verification, and outputs are identical to the curated path.

## Mode selection

| `flow-mode` | `flow-path` | Behavior |
| --- | --- | --- |
| `auto` (default) | set | Curated `flow.yaml` is applied (derivation never runs). |
| `auto` | unset, `spec-path` set | Flow is derived from the spec. |
| `auto` | unset, `spec-path` unset | Warning + uncurated refresh (legacy behavior). |
| `curated` | set | Curated `flow.yaml` is applied. |
| `curated` | unset | Error. |
| `off` | unset | Uncurated refresh, no warning. |
| `off` | set | Error. |

`fail-on-flow-warning: true` applies to derivation warnings exactly as it does to curated manifest validation warnings.

## Derivation rules (v1)

Derivation is a pure function of the spec bytes: same spec in, same flow out. No randomness, no clock, no network.

1. **Resource grouping.** Operations group by their collection path — the path with trailing `{param}` segments stripped (`/pets/{petId}` → `/pets`).
2. **Resource order.** Resources sort by (path depth, lexical path). Shallow resources run first.
3. **Lifecycle order inside a resource.** create (POST on collection path) → list (GET on collection path) → read (GET on item path) → update (PUT/PATCH on item path) → other operations (RPC-style POSTs, HEAD, etc.) → delete (DELETE). Ties break by (path, method) lexical order.
4. **ID extraction.** A create operation's 2xx JSON response schema is traversed (including `$ref` and `allOf`, up to two levels of object nesting) for properties ending in `id`/`Id`. Each becomes an `extract` with the jsonPath needed to reach it (`$.paymentId`, `$.data.userId`).
5. **ID binding.** Each path parameter of a later operation binds `source: prior_output` to the matching extract. Matching prefers the exact property name, then the resource-id convention (`{petId}` matches a producer property named `id` on the same resource). Producers are scoped per resource first, so `/cats/{catId}` and `/dogs/{dogId}` each bind to their own create even though both producers expose `id`.
6. **Unresolved parameters.** Parameters no producer satisfies degrade to `source: example` bindings, preserving the generated request example value, and are counted in the derivation trace.
7. **DELETE safety.** DELETE operations are derived but **excluded by default**. `flow-allow-delete: 'true'` includes a DELETE only when every one of its identifiers is proven to originate from a create step on the **same resource** in the same run (resource-scoped `prior_output` provenance). Cross-resource global id fallbacks bind reads and updates but never satisfy DELETE provenance. A DELETE without provenance is excluded even under the flag, with a warning. Curated manifests are exempt: whatever a human wrote is applied verbatim.
8. **Missing operationIds.** Operations without an `operationId` get a deterministic synthetic one (`get-items` for `GET /items`), which resolves against generated request names by the method-plus-path fallback when `spec-path` is provided (it always is, in derived mode).
9. **Degradation.** A spec with no operations, or one whose every operation is excluded, produces no flow; the action logs a warning and falls back to the uncurated refresh.

## Determinism guarantees

- Path/property iteration uses sorted key order wherever ordering is not defined by the rules above.
- `$ref` resolution is depth-capped, so circular schemas terminate.
- The derivation trace (resource count, step count, binding/extract counts, exclusions, unresolved parameters) is logged on every derived run.

## What derivation does not do (v1)

- It does not execute or reorder DELETEs without the explicit input flag.
- It does not emit extracts from top-level array responses (item identity is ambiguous).
- It does not infer request body payloads — generated examples are preserved.
- It does not mutate baseline or contract collections, exactly like curated mode.
