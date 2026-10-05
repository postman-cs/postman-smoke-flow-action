# Derived Smoke Flows

Under `flow-mode: auto` (the default), the action resolves one effective flow path — `flow-path` when set, else `postman/flow.yaml` — and keys mode selection on **file existence at that path**, not input presence. A manifest there runs curated; no manifest means the flow is derived deterministically from the OpenAPI document at `spec-path` and then persisted to that same path. The derived flow uses the exact same `FlowDefinition` shape as a curated manifest, so resolution, script injection, verification, and outputs are identical to the curated path.

## Mode selection

| `flow-mode` | manifest at effective path | Behavior |
| --- | --- | --- |
| `auto` (default) | exists, valid | Curated `flow.yaml` is applied (derivation never runs). |
| `auto` | exists, invalid | Hard error — a broken manifest is never silently derived over. |
| `auto` | absent, `spec-path` set | Flow is derived from the spec, applied, then persisted to the effective path (create-only; `persist-derived-flow: false` opts out). Zero-step derivation (no operations, or every operation excluded) is a hard error — no fallback to the uncurated refresh. |
| `auto` | absent, `spec-path` unset | Warning + uncurated refresh (legacy behavior). |
| `curated` | exists (`flow-path` required) | Curated `flow.yaml` is applied. |
| `curated` | unset | Error. |
| `off` | unset | Uncurated refresh, no warning. |
| `off` | set | Error. |

`fail-on-flow-warning: true` applies to derivation warnings exactly as it does to curated manifest validation warnings.

## Derivation rules (v1)

Derivation is a pure function of the spec bytes: same spec in, same flow out. No randomness, no clock, no network.

1. **Resource grouping.** Operations group by their collection path — the path with trailing `{param}` segments stripped (`/pets/{petId}` → `/pets`).
2. **Resource order.** Resources sort by (path depth, lexical path). Shallow resources run first.
3. **Lifecycle order inside a resource.** create (POST on collection path) → list (GET on collection path) → read (GET on item path) → update (PUT/PATCH on item path) → other operations (RPC-style POSTs, HEAD, etc.) → delete (DELETE). Ties break by (path, method) lexical order.
4. **ID extraction.** A create operation's 2xx JSON response schema is traversed (including `$ref` and `allOf`, up to two levels of object nesting) for properties ending in `id`/`Id`. A property becomes an `extract` with the jsonPath needed to reach it (`$.paymentId`, `$.data.userId`) only when some path parameter in the document can consume it — exact property name, or the resource-id convention (`{petId}` matches a producer property named `id`). Id-suffixed properties that no path parameter consumes are not published, because an extract exists only to feed a `prior_output` binding.
5. **ID binding.** Each path parameter of a later operation binds `source: prior_output` to the matching extract. Matching prefers the exact property name, then the resource-id convention (`{petId}` matches a producer property named `id` on the same resource). Producers are scoped per resource first, so `/cats/{catId}` and `/dogs/{dogId}` each bind to their own create even though both producers expose `id`.
6. **Unresolved parameters.** A required *path* parameter that no producer satisfies excludes its operation from the flow: the collection transform substitutes only `prior_output` bindings, so such a request would ship a literal `:param` segment and could only 404. Excluded operations are listed in `excludedOperationIds`, counted in `excludedUnresolvedPathParamCount`, and each carries a warning naming the parameter. Unresolved *query* parameters still degrade to `source: example` bindings, preserving the generated value. Both are counted in `unresolvedParameterCount`.
6a. **Required query parameters.** Path-item and operation `parameters` merge per OpenAPI override rules ((name, in) identity, operation wins). Each required query parameter binds `source: prior_output` when a producer publishes an exactly matching property, otherwise `source: example`, so the transform preserves the generated value instead of pruning the query entry. Optional query parameters stay unbound and are pruned, keeping smoke requests minimal.
7. **DELETE safety.** DELETE operations are derived but **excluded by default**. `flow-allow-delete: 'true'` includes a DELETE only when every one of its identifiers is proven to originate from a create step on the **same resource** in the same run (resource-scoped `prior_output` provenance). Cross-resource global id fallbacks bind reads and updates but never satisfy DELETE provenance. A DELETE without provenance is excluded even under the flag, with a warning. Curated manifests are exempt: whatever a human wrote is applied verbatim.
8. **Missing operationIds.** Operations without an `operationId` get a deterministic synthetic one (`get-items` for `GET /items`), which resolves against generated request names by the method-plus-path fallback when `spec-path` is provided (it always is, in derived mode).
9. **Zero-step derivation.** Derivation that yields zero flow steps — because the spec has no operations, or because every operation is excluded (for example, a DELETE-only spec under the default `flow-allow-delete: false`) — is a **hard error**. The action or CLI fails and does **not** fall back to the uncurated refresh. The error names the cause, includes any derivation warnings, and states the caller's options: fix the spec or exclusions, provide `flow-path`, or explicitly set `flow-mode: off`.

## Read-only scope (`flow-derive-scope: read-only`)

> **Interim.** This scope is planned for removal once the Postman CLI can filter a collection run by HTTP method. At that point the GET-only filter moves to run time and this input is retired as part of a broader smoke-flow cleanup. Code touch points carry the `TODO(read-only-scope-sunset)` tag.

The default scope (`full`) chains identifiers from create responses, which means a derived flow sends POST and PUT/PATCH requests whose payloads come from generated examples. Services with business-rule validation on writes, or whose read endpoints are the only safe smoke surface, can opt into `flow-derive-scope: read-only` instead:

1. **GET only.** Every non-GET operation is excluded before ordering. Excluded operations are listed in `excludedOperationIds` and counted in `excludedNonReadCount` (a read-only-only field, alongside `scope: read-only`); no warning is raised per operation, because the exclusion was requested. `flow-allow-delete` has no effect under this scope.
2. **List-sourced identifiers.** A list operation (GET on a collection path) publishes the identifier of its first item for each path parameter its resource owns: `GET /pets` -> `$.data[0].id` -> `GET /pets/{petId}`. The list response must be an object envelope: a conventional array key wins (`data`, `items`, `results`, `content`, `records`, `values`), otherwise exactly one array-of-object property must exist. `$ref` and `allOf` are resolved on both the envelope and the item schema.
3. **Identifier matching.** The item property is chosen by exact parameter name first, then the existing resource-id convention, then the surrogate keys `id`, `guid`, `uuid`. Surrogates apply only to identifier-shaped parameters (names ending in `id`, `guid`, or `uuid`), so `{slug}` binds only to a `slug` property.
4. **Owner-scoped producers only.** A list publishes only for parameters owned by its own resource (`/accounts/{accountId}/orders` consumes `/accounts`' list). There is no cross-resource fallback, so one resource's list never feeds another resource's parameter.
5. **Unchanged rules.** Required query parameters keep `source: example` bindings, path parameters with no producer still exclude their operation, ordering and determinism rules are identical, and the persisted manifest is a normal curated `flow.yaml`.

Not covered in v1: top-level array list responses (the injected resolver only accepts `$.`-rooted paths). Their get-by-id reads have no producer and are excluded with the usual unresolved-path-parameter warning; curate them by hand or return an envelope.

List endpoints with required query parameters are **kept**, not excluded: those parameters bind `source: example` (rule 6a), so the generated value is preserved. If that example does not return records in your environment, the chained read has no identifier at run time; curate those steps by hand.

The default (`full`) scope is unchanged byte for byte, including the derivation trace and the `flow-apply-summary-json` `derivation` payload: `scope` and `excludedNonReadCount` appear only under `read-only`.

## Determinism guarantees

- Path/property iteration uses sorted key order wherever ordering is not defined by the rules above.
- `$ref` resolution is depth-capped, so circular schemas terminate.
- The derivation trace (resource count, step count, binding/extract counts, exclusions, unresolved parameters) is logged on every derived run **and embedded in `flow-apply-summary-json` as the `derivation` object alongside `flowSource: "derived"`**, including `excludedOperationIds`.

## Request resolution tiers

Flow steps resolve to generated requests through tiers, strongest first:

1. Exact or case-insensitive **name** match against the generated request name.
2. **Method + path** match from the spec (always available in derived mode).
3. **Description substring** match — weak, because a short operationId can appear inside an unrelated request's description. This tier only applies when no strong tier matched anywhere in the collection, and it emits a warning naming the resolved request.

## Curation seed export

Derived runs persist the applied flow as a curated `flow.yaml` manifest at the effective flow path (`flow-path`, or `postman/flow.yaml` when omitted) and report that path on the `derived-flow-path` output. The write happens only after the apply succeeds, is create-only (an existing manifest is never overwritten), and can be disabled with `persist-derived-flow: false`. Commit the file to promote the derived flow into curated mode; the next run finds it at the same path and takes the curated branch automatically.

## What derivation does not do (v1)

- It does not execute or reorder DELETEs without the explicit input flag.
- Under `flow-derive-scope: read-only`, it does not send any POST, PUT, PATCH, or DELETE.
- It does not emit extracts from top-level array responses (item identity is ambiguous), nor from array-valued response properties; OpenAPI 3.1 nullable unions such as `type: ['array','null']` are resolved to their non-null member before that exclusion applies.
- It does not infer request body payloads — generated examples are preserved.
- It does not mutate baseline or contract collections, exactly like curated mode.
