# Postman Onboarding: Smoke Flow

[![CI](https://github.com/postman-cs/postman-smoke-flow-action/actions/workflows/ci.yml/badge.svg)](https://github.com/postman-cs/postman-smoke-flow-action/actions/workflows/ci.yml) [![Release](https://img.shields.io/github/v/release/postman-cs/postman-smoke-flow-action?sort=semver)](https://github.com/postman-cs/postman-smoke-flow-action/releases) [![npm](https://img.shields.io/npm/v/%40postman-cse%2Fonboarding-smoke-flow)](https://www.npmjs.com/package/@postman-cse/onboarding-smoke-flow) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Reshapes the generated Postman Smoke collection into an ordered smoke journey using one effective flow path — explicit `flow-path`, or `postman/flow.yaml` when omitted. Under `flow-mode: auto`, a valid manifest at that path is curated; an absent manifest is derived deterministically from the OpenAPI spec at `spec-path` and can be persisted there for the next curated run — with optional runtime auth injection for [OAuth2](https://learning.postman.com/docs/use/send-requests/authorization/oauth-20/) and API keys.

Part of the [Postman API Onboarding suite](https://github.com/postman-cs/postman-api-onboarding-action); the composite action's README has the full [action-picker table](https://github.com/postman-cs/postman-api-onboarding-action#which-action-should-i-use).

- [Usage](#usage)
- [Examples](#examples)
- [Inputs](#inputs) / [Outputs](#outputs)
- [How it works](#how-it-works)
- [Credentials and regions](#credentials-and-regions)

## Usage

```yaml
jobs:
  smoke-flow:
    runs-on: ubuntu-latest
    # The Postman API has no cross-process lease for collection edits.
    concurrency:
      group: postman-smoke-flow-${{ vars.POSTMAN_SMOKE_COLLECTION_ID }}
      cancel-in-progress: false
    steps:
      - uses: actions/checkout@v5

      - id: postman_token
        uses: postman-cs/postman-resolve-service-token-action@v2
        with:
          postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
          postman-region: us

      - uses: postman-cs/postman-smoke-flow-action@v2
        with:
          project-name: core-payments
          workspace-id: ${{ vars.POSTMAN_WORKSPACE_ID }}
          spec-id: ${{ vars.POSTMAN_SPEC_ID }}
          smoke-collection-id: ${{ vars.POSTMAN_SMOKE_COLLECTION_ID }}
          flow-path: .postman-api-launchpad/flows/core-payments/flow.yaml
          spec-path: api/openapi.yaml
          postman-access-token: ${{ steps.postman_token.outputs.token }}
          postman-region: us
```

`postman-access-token` is the required credential: the Smoke collection reshape runs entirely through the Postman gateway under that token. Mint it with [`postman-resolve-service-token-action`](https://github.com/postman-cs/postman-resolve-service-token-action), as shown above. `postman-api-key` is optional and only re-mints the access token if it expires mid-run; it never drives the reshape.

The workspace, spec, and Smoke collection IDs normally come straight from a `postman-bootstrap-action` step in the same job (see the chained pipeline example below).
For EU data residency, set `postman-region: eu` on bootstrap, Smoke Flow, and repo sync so every step calls the same Postman region.

## Examples

### Chained bootstrap -> smoke-flow -> repo-sync pipeline

This action is designed to run directly after `postman-bootstrap-action` and before `postman-repo-sync-action`:

```yaml
jobs:
  onboarding:
    runs-on: ubuntu-latest
    # This fixed project key is available before steps run. Do not use a
    # same-job bootstrap step output in job-level concurrency.
    concurrency:
      group: postman-onboarding-core-payments
      cancel-in-progress: false
    steps:
      - uses: actions/checkout@v5

      - id: postman_token
        uses: postman-cs/postman-resolve-service-token-action@v2
        with:
          postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
          postman-region: us

      - id: bootstrap
        uses: postman-cs/postman-bootstrap-action@v2
        with:
          project-name: core-payments
          spec-url: https://raw.githubusercontent.com/postman-cs/postman-smoke-flow-action/main/examples/core-payments-openapi.yaml
          postman-region: us
          postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
          postman-access-token: ${{ steps.postman_token.outputs.token }}

      - id: smoke_flow
        uses: postman-cs/postman-smoke-flow-action@v2
        with:
          project-name: core-payments
          workspace-id: ${{ steps.bootstrap.outputs.workspace-id }}
          spec-id: ${{ steps.bootstrap.outputs.spec-id }}
          smoke-collection-id: ${{ steps.bootstrap.outputs.smoke-collection-id }}
          flow-path: .postman-api-launchpad/flows/core-payments/flow.yaml
          postman-access-token: ${{ steps.postman_token.outputs.token }}
          postman-region: us

      - id: repo_sync
        uses: postman-cs/postman-repo-sync-action@v2
        with:
          project-name: core-payments
          workspace-id: ${{ steps.bootstrap.outputs.workspace-id }}
          baseline-collection-id: ${{ steps.bootstrap.outputs.baseline-collection-id }}
          smoke-collection-id: ${{ steps.smoke_flow.outputs.smoke-collection-id }}
          contract-collection-id: ${{ steps.bootstrap.outputs.contract-collection-id }}
          environments-json: '["prod"]'
          env-runtime-urls-json: '{"prod":"https://api.example.com"}'
          postman-region: us
          postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
          postman-access-token: ${{ steps.postman_token.outputs.token }}
          team-id: ${{ steps.postman_token.outputs.team-id }}
```

### Derive a flow automatically (default)

Under `flow-mode: auto` (the default), the action resolves one effective flow path: explicit `flow-path`, or `postman/flow.yaml` when omitted. A valid manifest already at that path is curated; an invalid manifest is a hard error and is never derived over. When the path is absent and `spec-path` is set, the action derives a deterministic smoke flow from the OpenAPI document: operations are grouped per resource, ordered create -> list -> read -> update, and chained by matching create-response ID properties to later path parameters (`POST /payments` returns `paymentId`; `GET /payments/{paymentId}` binds it). DELETE operations are excluded unless `flow-allow-delete: 'true'` is set and the deleted ID is proven to come from the same run's create step. If the spec has no operations or every operation is excluded, derivation fails with a hard error rather than falling back to the uncurated refresh. After a successful derived apply, the action creates `flow.yaml` at the same effective path unless `persist-derived-flow: false`; run 2 then finds it and converges to curated mode. The full rule set is in [docs/derived-flow.md](docs/derived-flow.md). `flow-mode: off` restores the plain uncurated refresh.

### Apply a curated flow.yaml

When a valid manifest exists at the effective flow path, the action generates a temporary Smoke collection from the current spec, reshapes it to match the curated flow, injects [pre-request](https://learning.postman.com/docs/tests-and-scripts/write-scripts/pre-request-scripts/) and [test scripts](https://learning.postman.com/docs/tests-and-scripts/write-scripts/test-scripts/) from bindings and extracts, updates the canonical Smoke collection in place, and deletes the temporary collection. `flow-mode: curated` specifically requires an explicit, existing `flow-path`; in auto mode, `postman/flow.yaml` is also curated when `flow-path` is omitted. The manifest format is documented in [docs/flow-manifest.md](docs/flow-manifest.md). The exact pre-request and test scripts injected per step are documented in [docs/generated-tests.md](docs/generated-tests.md), with a committed example manifest at [examples/flow.yaml](examples/flow.yaml).

```yaml
- uses: postman-cs/postman-smoke-flow-action@v2
  with:
    project-name: core-payments
    workspace-id: ${{ steps.bootstrap.outputs.workspace-id }}
    spec-id: ${{ steps.bootstrap.outputs.spec-id }}
    smoke-collection-id: ${{ steps.bootstrap.outputs.smoke-collection-id }}
    postman-region: us
    flow-path: .postman-api-launchpad/flows/core-payments/flow.yaml
    spec-path: api/openapi.yaml
    postman-access-token: ${{ steps.postman_token.outputs.token }}
```

### OAuth update without flow-path

To add Smoke-only [OAuth2](https://learning.postman.com/docs/use/send-requests/authorization/oauth-20/) client-credentials token acquisition before a manifest exists at the effective path, enable OAuth in the onboarding config that wraps this action. Under `flow-mode: auto` with `spec-path` set the workflow derives a smoke flow from the spec and applies OAuth on top of the derived curation; set `flow-mode: off` (or omit `spec-path`) for the plain uncurated refresh that applies OAuth without flow scripts, bindings, extracts, or curated ordering. Full configuration options are in [docs/smoke-oauth.md](docs/smoke-oauth.md).

```yaml
smoke:
  apiKey:
    enabled: false
  oauth:
    enabled: true
    tokenUrl: "https://auth.example.com/oauth/token"
    scope: "read write"
    clientIdSecret: OAUTH_CLIENT_ID
    clientSecretSecret: OAUTH_CLIENT_SECRET
```

### API key update without flow-path

To add Smoke-only API key auth before a manifest exists at the effective path, enable API key auth in the onboarding config that wraps this action. Under `flow-mode: auto` with `spec-path` set the workflow derives a smoke flow from the spec and applies API key auth on top of the derived curation; set `flow-mode: off` (or omit `spec-path`) for the plain uncurated refresh that applies API key auth without flow scripts, bindings, extracts, or curated ordering. The action writes a placeholder variable only; inject the real API key when the Smoke collection runs. Full configuration options are in [docs/smoke-api-key.md](docs/smoke-api-key.md).

```yaml
smoke:
  apiKey:
    enabled: true
    in: header
    name: X-API-Key
    variableName: service_api_key
    valueSecret: TARGET_API_KEY
  oauth:
    enabled: false
```

### Debug the transformed collection with debug-dump-path

Set `debug-dump-path` to write the transformed collection JSON to disk before the update call, then upload it as a workflow artifact for inspection:

```yaml
- uses: postman-cs/postman-smoke-flow-action@v2
  with:
    project-name: core-payments
    workspace-id: ${{ steps.bootstrap.outputs.workspace-id }}
    spec-id: ${{ steps.bootstrap.outputs.spec-id }}
    smoke-collection-id: ${{ steps.bootstrap.outputs.smoke-collection-id }}
    postman-region: us
    flow-path: .postman-api-launchpad/flows/core-payments/flow.yaml
    debug-dump-path: smoke-collection-debug.json
    keep-temp-collection-on-failure: "true"
    postman-access-token: ${{ steps.postman_token.outputs.token }}

- if: always()
  uses: actions/upload-artifact@v4
  with:
    name: smoke-collection-debug
    path: smoke-collection-debug.json
```

### Run from non-GitHub CI with the CLI

The npm package ships a `postman-smoke-flow` binary that accepts every action input as the same kebab-case flag and prints the action outputs as JSON to stdout:

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

See [docs/cli.md](docs/cli.md) for GitLab CI, Bitbucket Pipelines, Azure DevOps, and Jenkins patterns.

## Inputs

<!-- inputs-table:start -->
| Name | Description | Required | Default |
| --- | --- | --- | --- |
| `project-name` | Service project name used for temporary smoke collection naming. | yes |  |
| `workspace-id` | Postman workspace ID produced by bootstrap. | yes |  |
| `spec-id` | Postman spec ID produced by bootstrap. | yes |  |
| `smoke-collection-id` | Canonical Smoke collection ID to refresh in place. | yes |  |
| `flow-path` | Optional repo-root-relative path to the flow.yaml manifest. Defaults to postman/flow.yaml. Under flow-mode auto the action runs curated when a manifest exists at the effective path, otherwise derives a smoke flow from spec-path and persists it there; without spec-path (or under flow-mode off) the canonical Smoke collection is refreshed from the generated spec collection without flow curation. | no |  |
| `flow-mode` | Flow selection policy. auto (default) runs curated when a flow.yaml exists at the effective path (flow-path or postman/flow.yaml) and otherwise derives a deterministic smoke flow from spec-path, persisting it to that path; curated requires flow-path; off disables curation entirely and refreshes the canonical Smoke collection from the generated spec collection. | no | `auto` |
| `flow-allow-delete` | Whether derived flows may include DELETE operations whose identifiers are proven to originate from the same run's create steps. Defaults to false; curated flow.yaml manifests are unaffected. | no | `false` |
| `postman-api-key` | Optional service-account API key. Only used to re-mint an expired postman-access-token; the collection reshape itself runs access-token-only through the Postman gateway. | no |  |
| `postman-region` | Postman data residency region for public API calls. Supported values are us and eu. | no | `us` |
| `auth-config-json` | Advanced low-level Smoke runtime auth JSON, usually generated by onboarding templates from smoke.apiKey or smoke.oauth config. Supports OAuth2 client credentials and API key auth. | no |  |
| `secrets-resolver-enabled` | Whether to include the legacy AWS Secrets Manager resolver item at the start of the generated Smoke collection. Defaults to true for backward compatibility; set to false to opt out. | no | `true` |
| `spec-path` | Optional repo-root-relative path to the local OpenAPI spec for validation and debug context. | no |  |
| `debug-dump-path` | Optional repo-root-relative or absolute path to write the transformed collection JSON before update. | no |  |
| `collection-sync-mode` | Collection lifecycle policy. Refresh is the supported v1 mode. | no | `refresh` |
| `postman-access-token` | Service-account access token (x-access-token) that authenticates the Smoke collection reshape against the Postman gateway. Required for the reshape; when omitted, the action mints one from postman-api-key (service-account PMAK). | no |  |
| `fail-on-flow-warning` | Whether non-blocking flow warnings should fail the action. | no | `false` |
| `keep-temp-collection-on-failure` | Whether to keep the generated temporary smoke collection for debugging after a failed apply. | no | `false` |
| `temp-collection-prefix` | Prefix used when generating the temporary smoke collection from the spec. | no | `[Smoke][Temp]` |
| `persist-derived-flow` | Whether a freshly derived flow is written to the effective flow path (flow-path or postman/flow.yaml) after a successful apply, so the next run is curated. Create-only; an existing manifest is never overwritten. Set false to derive without persisting. | no | `true` |
| `team-id` | Optional Postman team ID, used only to attribute non-identifying usage telemetry to your team. The action runs identically with or without it. | no |  |
| `branch-strategy` | Branch-aware sync strategy. legacy (default) keeps branch-blind behavior; publish-gate restricts canonical writes to the canonical branch and skips on other branches; preview additionally maintains suffixed per-branch preview asset sets. | no | `legacy` |
| `canonical-branch` | Explicit canonical branch (the sole writer of canonical assets). Defaults to the provider-resolved default branch; required on providers without a default-branch variable (Bitbucket, Azure DevOps) when branch-strategy is not legacy. | no |  |
| `channels` | Comma-separated channel map for long-lived promotion branches, e.g. "develop=DEV, staging=STAGE, release/*=RC". | no |  |
<!-- inputs-table:end -->

## Outputs

<!-- outputs-table:start -->
| Name | Description |
| --- | --- |
| `smoke-collection-id` | Canonical Smoke collection ID after curated flow application. |
| `flow-apply-status` | Flow apply result status. |
| `flow-apply-summary-json` | JSON summary of flow application results and warnings. |
| `temporary-smoke-collection-id` | Temporary generated smoke collection ID used during apply. |
| `flow-step-count` | Number of steps in the applied flow. |
| `resolved-operation-count` | Number of flow steps resolved to generated requests. |
| `applied-binding-count` | Number of bindings applied as prerequest logic. |
| `applied-extract-count` | Number of extracts applied as test logic. |
| `assertion-count` | Number of generated assertions applied across flow steps. |
| `derived-flow-path` | Repo-relative path where this run persisted a derived flow.yaml (empty when a curated manifest was used, curation was off, persistence was disabled, or the run was gated). Commit it to make the next run curated. |
| `sync-status` | Branch-aware sync status: synced, skipped-branch-gate, or empty under branch-strategy legacy. |
| `branch-decision` | Serialized BranchDecision JSON for downstream actions (also exported as POSTMAN_BRANCH_DECISION). |
<!-- outputs-table:end -->

## Self-contained binary (no npm / no Node)

For CI that cannot install npm or Node — locked-down Jenkins, bare Bitbucket agents, boxes with no package-registry access — a single self-contained executable is published as a GitHub Release asset. It bakes the Node runtime and the full bundle into one file, so the target needs no npm, no Node install, and no package-registry access. It is not network-isolated: the run still needs outbound access to the Postman API/gateway.

```bash
VERSION=2.1.6   # example: use a release that carries the binary
ASSET="postman-smoke-flow-${VERSION}-linux-x64"
BASE_URL="https://github.com/postman-cs/postman-smoke-flow-action/releases/download/v${VERSION}"
curl -fsSLO "${BASE_URL}/${ASSET}"
curl -fsSLO "${BASE_URL}/${ASSET}.sha256"
shasum -a 256 -c "${ASSET}.sha256"
chmod +x "$ASSET"
mv "$ASSET" postman-smoke-flow

export POSTMAN_ACCESS_TOKEN="<minted-token>"
./postman-smoke-flow --project-name core-payments --workspace-id ws-123 --smoke-collection-id col-smoke --flow-path ./flow.yaml
```

Credentials resolve from a CLI flag, then the `INPUT_*` env var, then a plain `POSTMAN_ACCESS_TOKEN` / `POSTMAN_API_KEY` — so Jenkins `withCredentials` works with no flag. Proxy-only agents must set `NODE_USE_ENV_PROXY=1` alongside `HTTP_PROXY` / `HTTPS_PROXY`. The binary makes **no runtime tool downloads** (it reshapes the Smoke collection over the access-token gateway; it does not run the collection). Its business calls use the region API host, Bifrost gateway, and iapub; best-effort completion telemetry uses `events.pm-cse.dev`. With `--spec-path` set, an absent manifest at the effective flow path derives a flow instead (no acknowledgment needed); omitting `--spec-path` and having no manifest triggers the destructive full-canonical Smoke refresh and must be paired with `--acknowledge-no-flow-refresh` when intentional. Current target is `linux-x64`. Full runbook, credential minting, the complete host allowlist, and a Jenkins pipeline: [Self-contained binary](docs/self-contained-binary.md).

## How it works

```mermaid
flowchart LR
    M["flow.yaml<br/>curated manifest"] --> R
    S["OpenAPI spec (spec-id)"] -->|"generate temp collection"| G["generated Smoke collection"]
    G --> R["resolve steps by operationId<br/>wire bindings + extracts"]
    R --> C["canonical Smoke collection<br/>refreshed in place"]
    G -->|"no manifest + no spec-path<br/>refresh without curation"| C
    G -.-> T["temp collection deleted"]
    O["Smoke runtime auth<br/>OAuth2 or API key"] --> C
```

In curated mode, a valid manifest at the effective flow path is read, then the action generates a temporary Smoke collection from the spec, resolves each flow step against the generated requests by `operationId` (tiered: name, then method-plus-path when `spec-path` is provided, then a warned description-substring fallback), wires bindings and extracts into pre-request and test scripts, refreshes the canonical Smoke collection in place, and removes the temporary collection. `flow-mode: curated` requires an explicit existing `flow-path`; auto mode may use the default path. The manifest schema and resolution rules are in [docs/flow-manifest.md](docs/flow-manifest.md).

When no `flow.yaml` exists at the effective flow path (`flow-path`, or `postman/flow.yaml` when omitted) under `flow-mode: auto` (the default) and `spec-path` is set, the action **derives** a deterministic smoke flow from the OpenAPI document and applies it through the exact same curated pipeline ([docs/derived-flow.md](docs/derived-flow.md)). After a successful apply, it create-only persists `flow.yaml` at that path unless `persist-derived-flow: false`; the next run then finds it and is curated — no second name, no caller plumbing. A manifest already at the effective path always wins over derivation; an invalid manifest is a hard error, and an empty spec or a spec where every operation is excluded fails the run instead of silently refreshing without curation.

In no-flow mode (`flow-path` omitted without `spec-path`, or `flow-mode: off`), the action still generates a temporary Smoke collection from the spec and refreshes the canonical Smoke collection from that generated collection. If Smoke runtime auth is configured, it applies that auth during the refresh. It does not add flow scripts, bindings, extracts, or curated ordering. OAuth2 client credentials are documented in [docs/smoke-oauth.md](docs/smoke-oauth.md), and API key auth is documented in [docs/smoke-api-key.md](docs/smoke-api-key.md).

All collection operations — generating the temporary collection from the spec, reading it, reshaping the canonical collection, and deleting the temporary one — run through the Postman gateway under postman-access-token. The action never mutates baseline or contract collections, and it never writes runtime tokens or client secrets back to Postman environments.

The action validates that the canonical collection belongs to `workspace-id`, assigns each temporary collection a run-unique identity, and deletes only the temporary ID it positively adopts. Unsafe create POSTs are submitted once and reconciled after statusless transport failures, HTTP 408/429, or 5xx responses. Postman does not expose a cross-process collection lease or create idempotency key, so workflows that can overlap must use a concurrency group keyed by `smoke-collection-id`, as shown in the Usage example. Job-level concurrency is evaluated before steps run, so a chained bootstrap workflow must use a pre-existing variable, reusable-workflow input, or fixed project key—not a same-job step output. This serializes cooperating CI runs; unrelated writers that ignore the key remain a residual risk.

## Credentials and regions

| Need | Recommended path |
| --- | --- |
| Generate, read, reshape, and delete the Smoke collection | Pass postman-access-token. The reshape runs entirely through the Postman gateway under this token, so it is required. Mint it with postman-resolve-service-token-action. |
| Re-mint the access token if it expires mid-run | Optionally pass postman-api-key from a GitHub Actions secret or CI secret. It is used only to refresh an expired postman-access-token and never drives an asset operation. |
| Service-account access token and team ID for the broader onboarding pipeline | Run postman-resolve-service-token-action before bootstrap or the composite action, and reuse its token output across steps. |
| Smoke collection runtime auth | Keep OAuth client credentials or target API keys in CI secrets or runtime variables. This action writes placeholders only. |

postman-region selects the Postman public API host used to re-mint the access token and to run the identity preflight: us for https://api.getpostman.com and eu for https://api.eu.postman.com. The default is us. Use the same region as bootstrap and repo sync.

## Resources

- npm package: [@postman-cse/onboarding-smoke-flow](https://www.npmjs.com/package/@postman-cse/onboarding-smoke-flow)
- Docs in this repo: [flow.yaml manifest format](docs/flow-manifest.md), [Smoke OAuth configuration](docs/smoke-oauth.md), [Smoke API key configuration](docs/smoke-api-key.md), [generated tests](docs/generated-tests.md), [CLI usage for non-GitHub CI](docs/cli.md), [self-contained binary](docs/self-contained-binary.md)
- Marketplace docs: [Support](SUPPORT.md), [Security policy](SECURITY.md), [Release policy](RELEASE_POLICY.md), [Contributing](CONTRIBUTING.md)
- Postman scripting references: [OAuth 2.0](https://learning.postman.com/docs/use/send-requests/authorization/oauth-20/), [pre-request scripts](https://learning.postman.com/docs/tests-and-scripts/write-scripts/pre-request-scripts/), [test scripts](https://learning.postman.com/docs/tests-and-scripts/write-scripts/test-scripts/), [pm variables](https://learning.postman.com/docs/tests-and-scripts/write-scripts/postman-sandbox-reference/pm-variables/)

## Telemetry

The action sends one anonymous usage event per run (action name/version, outcome, coarse CI metadata; never secrets, spec content, or repo names), and only when the optional `team-id` input is set. Disable with `POSTMAN_ACTIONS_TELEMETRY=off` or `DO_NOT_TRACK=1`; route events to your own collector with `POSTMAN_ACTIONS_TELEMETRY_ENDPOINT`.

## License

[MIT](LICENSE)
