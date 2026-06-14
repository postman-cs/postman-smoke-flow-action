# Support

Use GitHub issues for reproducible action or CLI problems. Include the action tag, runner type, Node.js version, region, whether flow-path was set, and redacted logs.

For onboarding credential setup, use postman-resolve-service-token-action first. When service-account minting is unavailable, use the Postman CLI credential store created by `postman login` as the fallback source.

Do not include Postman API keys, access tokens, OAuth client secrets, collection JSON with live secrets, or debug dumps that contain runtime values. Rotate any credential that was posted publicly.

For vulnerability reports or accidental secret exposure, follow [SECURITY.md](SECURITY.md).
