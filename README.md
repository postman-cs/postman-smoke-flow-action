# Postman Onboarding: Smoke Flow

[![CI](https://github.com/postman-cs/postman-smoke-flow-action/actions/workflows/ci.yml/badge.svg)](https://github.com/postman-cs/postman-smoke-flow-action/actions/workflows/ci.yml) [![Release](https://img.shields.io/github/v/release/postman-cs/postman-smoke-flow-action?sort=semver)](https://github.com/postman-cs/postman-smoke-flow-action/releases) [![npm](https://img.shields.io/npm/v/%40postman-cse%2Fonboarding-smoke-flow)](https://www.npmjs.com/package/@postman-cse/onboarding-smoke-flow) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Reshapes the generated Postman Smoke collection to match a curated `flow.yaml`, with optional [OAuth2](https://learning.postman.com/docs/use/send-requests/authorization/oauth-20/) token acquisition.

Part of the [Postman API Onboarding suite](https://github.com/postman-cs/postman-api-onboarding-action).

## Which action should I use?

| Need | Action |
| --- | --- |
| Mint a service-account access token and team ID | [Postman Onboarding: Service Token](https://github.com/postman-cs/postman-resolve-service-token-action) |
| Discover an OpenAPI spec from AWS | [Postman Onboarding: AWS Spec Discovery](https://github.com/postman-cs/postman-aws-spec-discovery-action) |
| Create the Postman workspace, upload the spec, and generate collections | [Postman Onboarding: Workspace Bootstrap](https://github.com/postman-cs/postman-bootstrap-action) |
| Apply a curated smoke flow to the generated Smoke collection | [Postman Onboarding: Smoke Flow](https://github.com/postman-cs/postman-smoke-flow-action) |
| Export Postman artifacts and wire CI assets | [Postman Onboarding: Repo Sync](https://github.com/postman-cs/postman-repo-sync-action) |
| Link Postman Insights services to the workspace | [Postman Onboarding: Insights Linking](https://github.com/postman-cs/postman-insights-onboarding-action) |
| Run bootstrap, repo sync, and optional Insights linking as one GitHub workflow step | [Postman API Onboarding](https://github.com/postman-cs/postman-api-onboarding-action) |

## Usage

```yaml
jobs:
  smoke-flow:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5

      - uses: postman-cs/postman-smoke-flow-action@v1
        with:
          project-name: core-payments
          workspace-id: ${{ vars.POSTMAN_WORKSPACE_ID }}
          spec-id: ${{ vars.POSTMAN_SPEC_ID }}
          smoke-collection-id: ${{ vars.POSTMAN_SMOKE_COLLECTION_ID }}
          flow-path: .postman-api-launchpad/flows/core-payments/flow.yaml
          spec-path: api/openapi.yaml
          postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
          postman-region: us
```

The workspace, spec, and Smoke collection IDs normally come straight from a `postman-bootstrap-action` step in the same job (see the chained pipeline example below).
For EU data residency, set `postman-region: eu` on bootstrap, Smoke Flow, and repo sync so every step calls the same Postman region.

## Examples

### Chained bootstrap -> smoke-flow -> repo-sync pipeline

This action is designed to run directly after `postman-bootstrap-action` and before `postman-repo-sync-action`:

```yaml
jobs:
  onboarding:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5

      - id: postman_token
        uses: postman-cs/postman-resolve-service-token-action@v1
        with:
          postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
          postman-region: us

      - id: bootstrap
        uses: postman-cs/postman-bootstrap-action@v1
        with:
          project-name: core-payments
          spec-url: https://raw.githubusercontent.com/postman-cs/postman-smoke-flow-action/main/examples/core-payments-openapi.yaml
          postman-region: us
          postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
          postman-access-token: ${{ steps.postman_token.outputs.token }}

      - id: smoke_flow
        uses: postman-cs/postman-smoke-flow-action@v1
        with:
          project-name: core-payments
          workspace-id: ${{ steps.bootstrap.outputs.workspace-id }}
          spec-id: ${{ steps.bootstrap.outputs.spec-id }}
          smoke-collection-id: ${{ steps.bootstrap.outputs.smoke-collection-id }}
          flow-path: .postman-api-launchpad/flows/core-payments/flow.yaml
          postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
          postman-region: us

      - id: repo_sync
        uses: postman-cs/postman-repo-sync-action@v1
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

### Apply a curated flow.yaml

With `flow-path` set, the action generates a temporary Smoke collection from the current spec, reshapes it to match the curated flow, injects [pre-request](https://learning.postman.com/docs/tests-and-scripts/write-scripts/pre-request-scripts/) and [test scripts](https://learning.postman.com/docs/tests-and-scripts/write-scripts/test-scripts/) from bindings and extracts, updates the canonical Smoke collection in place, and deletes the temporary collection. The manifest format is documented in [docs/flow-manifest.md](docs/flow-manifest.md).

```yaml
- uses: postman-cs/postman-smoke-flow-action@v1
  with:
    project-name: core-payments
    workspace-id: ${{ steps.bootstrap.outputs.workspace-id }}
    spec-id: ${{ steps.bootstrap.outputs.spec-id }}
    smoke-collection-id: ${{ steps.bootstrap.outputs.smoke-collection-id }}
    postman-region: us
    flow-path: .postman-api-launchpad/flows/core-payments/flow.yaml
    spec-path: api/openapi.yaml
    postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
```

### OAuth-only update without flow-path

To inject Smoke-only [OAuth2](https://learning.postman.com/docs/use/send-requests/authorization/oauth-20/) client-credentials token acquisition into the existing Smoke collection before a `flow.yaml` exists, omit `flow-path` and pass `auth-config-json`. The existing collection is updated in place without recreating or reordering requests. Full configuration options are in [docs/smoke-oauth.md](docs/smoke-oauth.md).

```yaml
- uses: postman-cs/postman-smoke-flow-action@v1
  with:
    project-name: core-payments
    workspace-id: ${{ steps.bootstrap.outputs.workspace-id }}
    spec-id: ${{ steps.bootstrap.outputs.spec-id }}
    smoke-collection-id: ${{ steps.bootstrap.outputs.smoke-collection-id }}
    postman-region: us
    postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
    auth-config-json: '{"enabled":true,"type":"oauth2","grantType":"client_credentials","tokenUrl":"{{auth_token_url}}","clientAuthentication":"body"}'
```

### Debug the transformed collection with debug-dump-path

Set `debug-dump-path` to write the transformed collection JSON to disk before the update call, then upload it as a workflow artifact for inspection:

```yaml
- uses: postman-cs/postman-smoke-flow-action@v1
  with:
    project-name: core-payments
    workspace-id: ${{ steps.bootstrap.outputs.workspace-id }}
    spec-id: ${{ steps.bootstrap.outputs.spec-id }}
    smoke-collection-id: ${{ steps.bootstrap.outputs.smoke-collection-id }}
    postman-region: us
    flow-path: .postman-api-launchpad/flows/core-payments/flow.yaml
    debug-dump-path: smoke-collection-debug.json
    keep-temp-collection-on-failure: "true"
    postman-api-key: ${{ secrets.POSTMAN_API_KEY }}

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
  --postman-api-key "$POSTMAN_API_KEY"
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
| `flow-path` | Optional repo-root-relative path to the curated flow.yaml manifest. When omitted, OAuth config can still be applied to the existing Smoke collection. | no |  |
| `postman-api-key` | Postman API key used for collection generation and mutation. | yes |  |
| `postman-region` | Postman data residency region for public API calls. Supported values are us and eu. | no | `us` |
| `auth-config-json` | Optional JSON config for Smoke collection OAuth2 client-credentials token acquisition. | no |  |
| `secrets-resolver-enabled` | Whether to include the legacy AWS Secrets Manager resolver item at the start of the generated Smoke collection. Defaults to true for backward compatibility; set to false to opt out. | no | `true` |
| `spec-path` | Optional repo-root-relative path to the local OpenAPI spec for validation and debug context. | no |  |
| `debug-dump-path` | Optional repo-root-relative or absolute path to write the transformed collection JSON before update. | no |  |
| `collection-sync-mode` | Collection lifecycle policy. Refresh is the supported v1 mode. | no | `refresh` |
| `postman-access-token` | Compatibility input for broader onboarding pipelines. Smoke Flow does not use it; when provided, the value is masked and a deprecation warning is logged. | no |  |
| `fail-on-flow-warning` | Whether non-blocking flow warnings should fail the action. | no | `false` |
| `keep-temp-collection-on-failure` | Whether to keep the generated temporary smoke collection for debugging after a failed apply. | no | `false` |
| `temp-collection-prefix` | Prefix used when generating the temporary smoke collection from the spec. | no | `[Smoke][Temp]` |
| `team-id` | Optional Postman team ID, used only to attribute non-identifying usage telemetry to your team. The action runs identically with or without it. | no |  |
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
<!-- outputs-table:end -->

## How it works

In flow mode (`flow-path` set), the action reads the curated manifest, generates a temporary Smoke collection from the spec, resolves each flow step against the generated requests by `operationId` (with an optional method-plus-path fallback when `spec-path` is provided), wires bindings and extracts into pre-request and test scripts, refreshes the canonical Smoke collection in place, and removes the temporary collection. The manifest schema and resolution rules are in [docs/flow-manifest.md](docs/flow-manifest.md).

In OAuth-only mode (`flow-path` omitted, `auth-config-json` enabled), the action fetches the existing canonical Smoke collection and adds collection-level OAuth2 client-credentials token acquisition without touching request order or content. Details and runtime variable injection are in [docs/smoke-oauth.md](docs/smoke-oauth.md).

The action never mutates baseline or contract collections, and it never writes runtime tokens or client secrets back to Postman environments.

## Credentials and regions

| Need | Recommended path |
| --- | --- |
| Postman API collection generation and updates | Pass postman-api-key from a GitHub Actions secret or CI secret. |
| Service-account access token and team ID for the broader onboarding pipeline | Run postman-resolve-service-token-action before bootstrap or the composite action. |
| Smoke collection OAuth at run time | Keep OAuth client credentials in CI secrets or runtime variables. This action writes placeholders only. |

postman-region controls the Postman public API host. Use us for https://api.getpostman.com and eu for https://api.eu.postman.com. The default is us. Smoke Flow is scoped to public Postman API regions and should use the same public region as bootstrap and repo sync.

## Resources

### The suite

| Action | Role |
| --- | --- |
| [Postman API Onboarding](https://github.com/postman-cs/postman-api-onboarding-action) | Entry point: chains workspace bootstrap, repo sync, and optional Insights linking |
| [Postman Onboarding: Service Token](https://github.com/postman-cs/postman-resolve-service-token-action) | Mints the service-account access token and team ID |
| [Postman Onboarding: AWS Spec Discovery](https://github.com/postman-cs/postman-aws-spec-discovery-action) | Discovers and exports API specs from AWS services |
| [Postman Onboarding: Workspace Bootstrap](https://github.com/postman-cs/postman-bootstrap-action) | Creates the workspace, uploads the spec, generates collections |
| [Postman Onboarding: Smoke Flow](https://github.com/postman-cs/postman-smoke-flow-action) | Applies a curated flow.yaml to the Smoke collection |
| [Postman Onboarding: Repo Sync](https://github.com/postman-cs/postman-repo-sync-action) | Exports artifacts into the repo and wires CI, mocks, and monitors |
| [Postman Onboarding: Insights Linking](https://github.com/postman-cs/postman-insights-onboarding-action) | Links Insights discovered services to the workspace |

- [postman-resolve-service-token-action](https://github.com/postman-cs/postman-resolve-service-token-action): mints a service-account access token and team ID
- [postman-api-onboarding-action](https://github.com/postman-cs/postman-api-onboarding-action): composite action that orchestrates the onboarding pipeline
- [postman-bootstrap-action](https://github.com/postman-cs/postman-bootstrap-action): workspace provisioning, spec upload, collection generation
- [postman-repo-sync-action](https://github.com/postman-cs/postman-repo-sync-action): artifact sync, environments, mocks, monitors
- [postman-insights-onboarding-action](https://github.com/postman-cs/postman-insights-onboarding-action): Insights-to-workspace linking
- [postman-aws-spec-discovery-action](https://github.com/postman-cs/postman-aws-spec-discovery-action): AWS API and spec discovery
- npm package: [@postman-cse/onboarding-smoke-flow](https://www.npmjs.com/package/@postman-cse/onboarding-smoke-flow)
- [flow.yaml manifest format](docs/flow-manifest.md)
- [Smoke OAuth configuration](docs/smoke-oauth.md)
- Postman scripting references: [OAuth 2.0](https://learning.postman.com/docs/use/send-requests/authorization/oauth-20/), [pre-request scripts](https://learning.postman.com/docs/tests-and-scripts/write-scripts/pre-request-scripts/), [test scripts](https://learning.postman.com/docs/tests-and-scripts/write-scripts/test-scripts/), [pm variables](https://learning.postman.com/docs/tests-and-scripts/write-scripts/postman-sandbox-reference/pm-variables/)
- [CLI usage for non-GitHub CI](docs/cli.md)
- [Support](SUPPORT.md), [Security policy](SECURITY.md), and [Release policy](RELEASE_POLICY.md)
- [Contributing](CONTRIBUTING.md)


## Telemetry

This action sends a single non-identifying usage event when a run completes, so the
Postman team can measure adoption across CI systems. The event contains the
action name and version, your Postman team ID, the detected CI provider and
runner kind, the run outcome, the CI run identifier, an event timestamp, and a one-way SHA-256 hash of the repository
identifier. Each event also carries a schema version and a constant event marker (always `completion`). The Postman team ID is sent in the clear on a legitimate-interest
basis to measure product adoption.

The `events.pm-cse.dev` endpoint is operated by the Postman Customer Success
Engineering team. Postman, Inc. processes these events only to measure
onboarding adoption in aggregate, retains them only as aggregated counts for
product-adoption trend analysis, and includes no payload field that identifies
an individual person.

It never sends API keys, access tokens, spec content, workspace or repository
names, or any personal data. It is fire-and-forget with a hard
timeout and can never block or fail your pipeline. Corporate HTTP and HTTPS
proxies are honored through the standard `HTTPS_PROXY`, `HTTP_PROXY`, and
`NO_PROXY` environment variables.

Disable it by setting either environment variable in your CI:

```sh
POSTMAN_ACTIONS_TELEMETRY=off
# or the cross-tool standard
DO_NOT_TRACK=1
```

Telemetry is also skipped automatically when no Postman team ID can be resolved.

This action resolves a Postman team only when a `team-id` input is provided, so
telemetry stays inert unless you set it.

Events are sent over HTTPS to `https://events.pm-cse.dev/v1/events`. To
allowlist this destination on a restricted network, or to route events to a
collector you operate, set the `POSTMAN_ACTIONS_TELEMETRY_ENDPOINT` environment
variable to your own URL.

## License

[MIT](LICENSE)
