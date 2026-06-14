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
npm run check:dist
```

Then lint workflows with [`actionlint`](https://github.com/rhysd/actionlint):

```bash
go install github.com/rhysd/actionlint/cmd/actionlint@v1.7.11
$(go env GOPATH)/bin/actionlint
```

`actionlint` runs the embedded shell scripts through `shellcheck` automatically when `shellcheck` is on `PATH`.

## Before Submitting a PR

- [ ] `actionlint` passes locally.
- [ ] `npm run lint`, `npm test`, `npm run typecheck`, and `npm run check:dist` pass locally.
- [ ] The `Live E2E` PR check passes; PRs should not be approved or merged until the correlated `postman-actions-e2e` run succeeds.
- [ ] Changes are focused and address a single concern.
- [ ] README inputs/outputs tables match `action.yml`.
- [ ] Behavior changes are reflected in `README.md`.

## PR E2E Gate

Every pull request targeting `main` runs the central live e2e suite before
approval or merge. The PR workflow dispatches `postman-cs/postman-actions-e2e`
with the PR head SHA pinned for `postman-smoke-flow-action`, waits for the
correlated run to succeed, and reports that result as the `Live E2E` check.

Because the suite runs action code with repository-scoped live sandbox credentials, the PR
branch must live in this repository. Fork-based PRs cannot receive those secrets;
push the branch to this repo to run the required merge gate.

## Release Gate

Immutable release tags for this repo are blocked by the central live e2e suite in
`postman-cs/postman-actions-e2e` before any GitHub release, npm package, or
release tarball is published. The release workflow validates locally, dispatches
the e2e workflow with this exact tag pinned for `postman-smoke-flow-action`,
waits for the correlated run to succeed, and only then publishes.

The rolling `v1` alias validates locally but skips npm publish
and the live e2e gate. `E2E_DISPATCH_TOKEN` is release-critical for immutable
publishing tags; if it is missing, invalid, or the e2e fails/times out, the
release must stop before public artifacts are created. Record the e2e run URL
and conclusion from the release logs as release evidence.

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
