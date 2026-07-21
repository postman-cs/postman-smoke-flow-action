# Self-contained binary (no npm / no Node)

For CI environments that cannot install npm packages or a Node.js runtime — locked-down Jenkins, Bitbucket Pipelines on a bare agent, boxes with no package-registry access — this action ships as a single self-contained executable. It is a [Node.js Single Executable Application](https://nodejs.org/api/single-executable-applications.html): the Node runtime and the entire bundle are baked into one file, so the target needs **no npm, no Node install, and no network access to a package registry**.

"Self-contained" means the *runtime* is bundled — it is not network-isolated. This action reshapes the Smoke collection over the Postman access-token gateway, so the run needs outbound access to Postman for the whole run (see [Network requirements](#network-requirements)).

The binary is built and smoke-tested natively in CI on every release (`.github/workflows/release.yml`) and attached as a GitHub Release asset. It carries the same code as the `action.yml` and npm CLI paths.

- **Current target:** `linux-x64` (glibc). Other targets (linux-arm64, win-x64, darwin-arm64) are not built yet.
- **First release with the binary:** the first `v*` tag published after this lands. Pin an explicit released version in the examples below.

## Get the binary

Download the release asset and mark it executable. Pin an explicit version:

```bash
VERSION=2.1.4   # set to the release that carries the binary
curl -fsSL -o postman-smoke-flow \
  "https://github.com/postman-cs/postman-smoke-flow-action/releases/download/v${VERSION}/postman-smoke-flow-${VERSION}-linux-x64"
chmod +x postman-smoke-flow

./postman-smoke-flow --version   # -> matches ${VERSION}
```

If the repository or release is private, the browser-style URL above returns an HTML login page instead of the binary. Fetch it through the GitHub API with a token that has `contents:read`, or — recommended for locked-down environments — **mirror the asset once into your own artifact store** (Artifactory, Nexus, S3) and have CI pull it from there. That keeps the build offline from GitHub entirely and gives you a stable internal URL.

## Prove self-containment

The binary embeds its own runtime and never consults `PATH` for `node`. You can prove that with an empty environment:

```bash
# Reaches the CLI's own input validation with no Node on PATH:
env -i PATH=/nonexistent ./postman-smoke-flow
# -> "Omitting --flow-path selects a destructive full canonical Smoke refresh. ..."
```

This is the same assertion the release workflow runs before publishing the asset.

## What it does

This action reshapes the generated Postman **Smoke** collection to match a curated `flow.yaml` (or, without a flow, refreshes the canonical Smoke collection). Every operation runs over the **access-token gateway** — it generates a temporary collection, reshapes the canonical one in place, and deletes the temp. It does **not** run the collection (no newman/Postman CLI), so there are **no runtime tool downloads** on any path.

Omitting `--flow-path` selects a destructive full-canonical Smoke refresh; the binary refuses that unless you also pass `--acknowledge-no-flow-refresh`.

## Credentials

The self-contained binary resolves each credential from three sources, highest precedence first:

1. A CLI flag — `--postman-access-token <token>`, `--postman-api-key <key>`
2. The GitHub Action input env var — `INPUT_POSTMAN_ACCESS_TOKEN`, `INPUT_POSTMAN_API_KEY`
3. A plain environment variable — `POSTMAN_ACCESS_TOKEN`, `POSTMAN_API_KEY`

The plain-env fallback (3) is what makes Jenkins [`withCredentials`](https://www.jenkins.io/doc/pipeline/steps/credentials-binding/) work with no flags: whatever sets `POSTMAN_ACCESS_TOKEN` in the environment, the binary picks it up. `postman-access-token` is **required** — every gateway reshape runs on it; a `postman-api-key` is used only to re-mint the access token on expiry. Because the access token is short-lived (~1–1.5h), store the long-lived **PMAK** in your CI secret store and mint the access token during the job (see the [Jenkins example](#jenkins-pipeline-example)).

Mint against the API base for your region — `api.getpostman.com` for US, `api.eu.postman.com` for [EU data residency](https://learning.postman.com/docs/administration/enterprise/about-eu-data-residency/) — and pass the matching `--postman-region`. A US-minted token is not valid against the EU API and vice versa.

## Network requirements

The binary bundles its runtime, but the reshape is an online operation. The agent needs outbound access (direct or via an HTTP/HTTPS proxy) to Postman for the entire run. On agents that enforce an outbound allowlist, allow **all** of the following (prod defaults). The region only changes the API host; the Bifrost and iapub hosts are the same for US and EU:

| Host | Purpose |
| --- | --- |
| `api.getpostman.com` (US) / `api.eu.postman.com` (EU) | Public API — token minting/re-mint |
| `bifrost-premium-https-v4.gw.postman.com` | Bifrost proxy — the access-token gateway for the Smoke collection generate/reshape/delete (`/ws/proxy`) |
| `iapub.postman.co` | Session identity preflight (`/api/sessions/current`) |

Allowlisting only the API host is **not** enough: the gateway reshape and identity preflight will fail even though minting succeeds. This action does not contact `gateway.postman.com` or `dl-cli.pstmn.io` (those appear in the endpoint profile but are not used by this action), and it makes no runtime tool downloads.

## Run

Inputs are the same kebab-case names as [`action.yml`](../action.yml), passed as `--<input-name> <value>`:

```bash
export POSTMAN_ACCESS_TOKEN="<minted-token>"

./postman-smoke-flow \
  --project-name core-payments \
  --workspace-id ws-123 \
  --spec-id spec-123 \
  --smoke-collection-id col-smoke \
  --flow-path ./flow.yaml \
  --postman-region us
```

- The reshape targets the canonical Smoke collection identified by `--smoke-collection-id`; the collection must already exist (this action does not create it — `postman-bootstrap-action` does).
- `--flow-path` points at your curated `flow.yaml`. To run the destructive no-flow refresh instead, omit it and pass `--acknowledge-no-flow-refresh`.
- The CLI prints the run result as JSON on stdout (logs go to stderr).

## Jenkins pipeline example

The binary must run on a **linux-x64 agent** — it is a Linux ELF and cannot execute on a Windows agent. The Jenkins credential stores the long-lived **PMAK**; the pipeline mints a short-lived access token from it in-job and exports it as `POSTMAN_ACCESS_TOKEN`, so the binary picks it up via the plain-env fallback with no flag.

```groovy
pipeline {
  // Requires a Linux x64 agent. Swap 'linux' for your instance's label.
  agent { label 'linux' }

  environment {
    SMOKE_FLOW_VERSION = '2.1.4'   // set to the release that carries the binary
    POSTMAN_REGION = 'us'          // EU data residency: 'eu'
  }

  stages {
    stage('Fetch binary') {
      steps {
        sh '''
          set -eu
          # Prefer your internal mirror in locked-down environments:
          URL="https://github.com/postman-cs/postman-smoke-flow-action/releases/download/v${SMOKE_FLOW_VERSION}/postman-smoke-flow-${SMOKE_FLOW_VERSION}-linux-x64"
          curl -fsSL "$URL" -o postman-smoke-flow
          chmod +x postman-smoke-flow
          ./postman-smoke-flow --version
        '''
      }
    }
    stage('Apply smoke flow') {
      steps {
        // Bind the PMAK, mint a fresh access token, then run -- all in one shell so
        // the minted token stays in scope. The binary reads it from
        // POSTMAN_ACCESS_TOKEN (no --postman-access-token flag).
        withCredentials([string(credentialsId: 'postman-api-key', variable: 'POSTMAN_API_KEY')]) {
          sh '''
            set +x          # Jenkins runs sh with -x by default; disable it BEFORE touching the PMAK
            set -eu
            case "$POSTMAN_REGION" in
              eu) API_BASE="https://api.eu.postman.com" ;;
              *)  API_BASE="https://api.getpostman.com" ;;
            esac
            resp="$(curl -fsSL -X POST "$API_BASE/service-account-tokens" \
              -H "x-api-key: $POSTMAN_API_KEY" -H "Content-Type: application/json" \
              -d "{\\"apiKey\\":\\"$POSTMAN_API_KEY\\"}")"
            # Accept both response shapes: "access_token" or a nested session "token".
            POSTMAN_ACCESS_TOKEN="$(printf '%s' "$resp" | grep -o '"access_token": *"[^"]*"' | head -1 | cut -d'"' -f4)"
            [ -n "$POSTMAN_ACCESS_TOKEN" ] || \
              POSTMAN_ACCESS_TOKEN="$(printf '%s' "$resp" | grep -o '"token": *"[^"]*"' | head -1 | cut -d'"' -f4)"
            [ -n "$POSTMAN_ACCESS_TOKEN" ] || { echo "token mint failed" >&2; exit 1; }
            export POSTMAN_ACCESS_TOKEN
            unset POSTMAN_API_KEY   # least-privilege: run access-token-only
            ./postman-smoke-flow \
              --project-name core-payments \
              --workspace-id ws-123 \
              --spec-id spec-123 \
              --smoke-collection-id col-smoke \
              --flow-path ./flow.yaml \
              --postman-region "$POSTMAN_REGION"
          '''
        }
      }
    }
  }
}
```

## Scope and limitations

- **Platform:** linux-x64 (glibc) only. arm64/Windows/macOS targets are not built yet.
- **Network:** not air-gapped — requires outbound access to the Postman API/gateway hosts for the whole run. See [Network requirements](#network-requirements).
- **Collection must exist:** this action reshapes an existing canonical Smoke collection (`--smoke-collection-id`); it does not create one. Run `postman-bootstrap-action` first.
- **Version:** the embedded `--version` and telemetry version are baked in at build time from the release tag; the versioned filename (`postman-smoke-flow-<version>-linux-x64`) also carries it.
```

