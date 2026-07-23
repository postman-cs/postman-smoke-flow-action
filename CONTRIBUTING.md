# Contributing to postman-smoke-flow-action

Thank you for your interest in contributing. This guide covers the workflow and standards for submitting changes.

## Getting Started

1. Fork and clone the repository.
2. Install dependencies: `npm ci`.
3. Create a feature branch: `git checkout -b my-change`.

This repository is a Node.js GitHub Action and npm CLI. Runtime code lives in `src/`, tests live in `tests/`, and bundled artifacts live in `dist/`.

## Local Validation

Before opening a PR, run the package validators:

```bash
npm ci
npm run lint
npm test
npm run typecheck
npm run build
npm run verify:dist
```

Then lint workflows with [`actionlint`](https://github.com/rhysd/actionlint) `1.7.11` via the official downloader (no Go toolchain):

```bash
tmp="$(mktemp -d)"
bash <(curl -sSfL https://raw.githubusercontent.com/rhysd/actionlint/main/scripts/download-actionlint.bash) 1.7.11 "$tmp"
"$tmp/actionlint"
```

`actionlint` runs the embedded shell scripts through `shellcheck` automatically when `shellcheck` is on `PATH`.

## Before Submitting a PR

- [ ] `actionlint` passes locally.
- [ ] `npm run lint`, `npm test`, `npm run typecheck`, and `npm run verify:dist` pass locally.
- [ ] The offline `gate` check passes.
- [ ] Changes are focused and address a single concern.
- [ ] README inputs/outputs tables match `action.yml`.
- [ ] Behavior changes are reflected in `README.md`.

## Live E2E Tier

Ordinary PRs use the deterministic offline gate. Live sandbox coverage is an
asynchronous exact-tag smoke monitor after immutable publication, plus the
nightly full monitor in `postman-cs/postman-actions-e2e`.

## Release Gate

Immutable release tags for this repo publish after local validate succeeds
(deterministic tests, typecheck, dist verify, actionlint, and tag/version
checks). After immutable publication, the release workflow dispatches an
asynchronous smoke E2E monitor in `postman-cs/postman-actions-e2e` with this
exact tag pinned for `postman-smoke-flow-action`. That dispatch is
`continue-on-error`; missing/denied dispatch or a later monitor failure does not
roll back or block published artifacts.

The rolling `v1` alias validates locally but skips npm publish and the live e2e
monitor dispatch. `E2E_DISPATCH_TOKEN` powers the post-publish smoke monitor for
immutable publishing tags; record the dispatch notice from the release logs as
monitor evidence. The nightly full monitor remains in
`postman-cs/postman-actions-e2e`.


## Commit Messages

This project uses [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/). All commits must follow this format:

```text
<type>: <description>

[optional body]

[optional footer(s)]
```

**Types:** `feat`, `fix`, `docs`, `chore`, `ci`, `refactor`, `test`, `perf`, `revert`

**Examples:**

```text
feat: support additional smoke flow assertions
fix: preserve request auth when applying flow.yaml
docs: clarify smoke collection inputs
ci: block release on live e2e gate
```

## Reporting Issues

Use the GitHub issue tracker for bug reports and feature requests. For questions, open a Discussion thread.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
