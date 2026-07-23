export function sha256(bytes: Uint8Array | Buffer | string): string;
export function computeNpmSri(bytes: Uint8Array | Buffer | string): string;
export function assertNpmSriMatch(expected: string, actual: string): void;
export function validateTagVersion(tag: string, packageVersion: string): void;
export function expectedArtifactNames(packageVersion: string): string[];
export function validateSeaSidecar(
  artifacts: Map<string, Uint8Array | Buffer>,
  packageVersion: string,
  manifestArtifacts: Array<{ path: string; sha256: string }>
): void;
export function validateManifest(manifest: unknown, context: {
  repository: string;
  commitSha: string;
  tag: string;
  packageName: string;
  packageVersion: string;
  artifacts: Map<string, Uint8Array | Buffer>;
}): void;
