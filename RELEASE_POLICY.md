# Release Policy

Releases use immutable v1.x.y tags plus the rolling v1 alias. Git tags are the source of truth for published action versions.

Before publishing a release, run the package validators from this directory: npm test, npm run typecheck, npm run lint, npm run build, and npm run check:dist.

The committed dist files must match source for release tags because GitHub Actions runs the bundled artifact from the tag.

Do not force-push existing release tags. Publish a new patch tag when a released bundle needs a fix.
