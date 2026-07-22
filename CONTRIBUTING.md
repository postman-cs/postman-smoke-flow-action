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

Then lint workflows with [`actionlint`](https://github.com/rhysd/actionlint):

```bash
go install github.com/rhysd/actionlint/cmd/actionlint@v1.7.11
$(go env GOPATH)/bin/actionlint
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

Ordinary PRs use the deterministic offline gate. Live sandbox coverage runs on
immutable releases and nightly in `postman-cs/postman-actions-e2e`.

## Release Monitor

Immutable release tags publish after local validation succeeds (tests, typecheck,
lint, dist verify, actionlint, and SEA artifact smoke checks). Publish does
**not** wait on live sandbox e2e. After an immutable npm publish tag finishes
publishing, the release workflow fire-and-forgets a single dispatch to
`postman-cs/postman-actions-e2e` with this exact tag pinned for
`postman-smoke-flow-action` (`action` / `ref` / `gate_correlation_id` /
`suite=smoke`). The monitor job uses `continue-on-error: true` and is not a
dependency of the rolling major-alias job.

The rolling major alias validates locally but skips npm publish and the live
e2e monitor. `E2E_DISPATCH_TOKEN` is required only for the post-publish monitor
job; a missing, denied, or failed dispatch can fail that job alone and must not
block GitHub release, npm publish, tarball upload, or alias advancement. Record
the dispatch notice from the release logs as monitor evidence when available.

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
ci: dispatch live e2e monitor after publish
```

## Reporting Issues

Use the GitHub issue tracker for bug reports and feature requests. For questions, open a Discussion thread.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
