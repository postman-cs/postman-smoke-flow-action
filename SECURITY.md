# Security Policy

## Supported Versions

Only the latest `v1.x.y` release (tracked by the rolling `v1` alias) receives security fixes. Older tags remain published for reproducibility and are never retroactively modified.

## Reporting a Vulnerability

Please do not open a public issue for security reports.

- Preferred: use GitHub private vulnerability reporting on this repository (Security tab, "Report a vulnerability").
- Alternative: email [security@postman.com](mailto:security@postman.com) and mention the repository name.

You should receive an acknowledgement within five business days. Please include reproduction steps, the action version tag, and any relevant (redacted) workflow logs.

## Scope Notes

- This action handles a Postman API key and may receive a compatibility access-token input from broader onboarding pipelines. Accepted Postman credentials are masked in logs by the action itself; never echo them in your own workflow steps.
- Use postman-resolve-service-token-action as the primary path for service-account access tokens and team IDs in automated onboarding pipelines.
- When service-account minting is unavailable, use the Postman CLI credential store created by `postman login` as the fallback source. Do not paste copied cookies, DevTools values, or manually harvested session credentials into workflow secrets.
- OAuth client credentials passed at collection run time must stay in CI secrets or runtime variables. The action writes variable placeholders only, not token values or client secrets.
- Reports about secrets you exposed in your own workflow configuration are out of scope; rotate the credential in Postman immediately.
