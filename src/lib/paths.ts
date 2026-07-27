import { lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { ValidationError } from './errors.js';

export function assertPathWithinCwd(targetPath: string, fieldName: string): string {
  if (path.isAbsolute(targetPath)) {
    throw new ValidationError(`${fieldName} must be relative to the repository root; received ${targetPath}`);
  }
  if (targetPath.split(/[\\/]+/).includes('..')) {
    throw new ValidationError(
      `${fieldName} must stay within the repository root and must not contain lexical traversal; received ${targetPath}`
    );
  }
  const base = path.resolve('.');
  const resolved = path.resolve(base, targetPath);
  const relative = path.relative(base, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ValidationError(`${fieldName} must stay within the repository root; received ${targetPath}`);
  }
  return resolved;
}

function assertRealPathWithinWorkspace(realPath: string, workspaceRoot: string, fieldName: string, targetPath: string): void {
  const relative = path.relative(workspaceRoot, realPath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ValidationError(
      `${fieldName} must stay within the repository root after resolving symlinks; received ${targetPath}`
    );
  }
}

/**
 * Full workspace-containment policy for a path that will be read or written:
 * lexical containment, no symlink on any existing parent component, realpath
 * containment of the nearest existing ancestor, and no symlinked target.
 * Works for paths that do not exist yet (prospective writes).
 */
export function assertWorkspaceContainment(targetPath: string, fieldName: string): string {
  const resolved = assertPathWithinCwd(targetPath, fieldName);
  const base = realpathSync(path.resolve('.'));

  // Refuse symlinks on every existing component between the workspace root
  // and the target, then re-check containment against the REAL parent path.
  let probe = path.dirname(resolved);
  const existingDirs: string[] = [];
  while (true) {
    try {
      const stat = lstatSync(probe);
      if (stat.isSymbolicLink()) {
        throw new ValidationError(`${fieldName} must not traverse symlinks; ${probe} is a symbolic link.`);
      }
      existingDirs.push(probe);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const nearestExisting = existingDirs.length > 0 ? existingDirs[0]! : base;
  const realParent = realpathSync(nearestExisting);
  assertRealPathWithinWorkspace(realParent, base, fieldName, targetPath);

  try {
    const targetStat = lstatSync(resolved);
    if (targetStat.isSymbolicLink()) {
      throw new ValidationError(`${fieldName} must not be a symbolic link; received ${targetPath}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  return resolved;
}

/** Return false only when a safe workspace target or component is absent. */
export function workspaceFileExists(targetPath: string, fieldName: string): boolean {
  const resolved = assertWorkspaceContainment(targetPath, fieldName);
  try {
    lstatSync(resolved);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

/** Resolve an existing regular workspace file without following symlinks. */
export function resolveWorkspaceRegularFile(targetPath: string, fieldName: string): string {
  const resolved = assertWorkspaceContainment(targetPath, fieldName);
  let targetStat;
  try {
    targetStat = lstatSync(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ValidationError(`${fieldName} must reference an existing regular file; received ${targetPath}`);
    }
    throw error;
  }
  if (!targetStat.isFile()) {
    throw new ValidationError(`${fieldName} must reference a regular file; received ${targetPath}`);
  }
  const realTarget = realpathSync(resolved);
  assertRealPathWithinWorkspace(realTarget, realpathSync(path.resolve('.')), fieldName, targetPath);
  return realTarget;
}

/**
 * Write a workspace file with the boundary a prospective writer needs, not
 * just the lexical reader check: the target must resolve inside the REAL
 * workspace root (symlinked parents cannot escape the checkout), no path
 * component may be a symlink, and the write is create-only ('wx') so an
 * existing file - human curation included - is never overwritten.
 */
export function writeWorkspaceFileExclusive(targetPath: string, content: string, fieldName: string): string {
  const resolved = assertWorkspaceContainment(targetPath, fieldName);
  const base = realpathSync(path.resolve('.'));

  mkdirSync(path.dirname(resolved), { recursive: true });
  // Re-verify immediately before the write: the validated parent could have
  // been swapped for a symlink since the check above. Re-anchor the target
  // through the real parent so the 'wx' write cannot escape the workspace.
  const lexicalParent = path.dirname(resolved);
  const realDir = realpathSync(lexicalParent);
  assertRealPathWithinWorkspace(realDir, base, fieldName, targetPath);
  const target = path.join(realDir, path.basename(resolved));
  try {
    const targetStat = lstatSync(target);
    if (targetStat.isSymbolicLink()) {
      throw new ValidationError(`${fieldName} must not be a symbolic link; received ${targetPath}`);
    }
    if (!targetStat.isFile()) {
      throw new ValidationError(`${fieldName} must not collide with a non-regular file; received ${targetPath}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  writeFileSync(target, content, { encoding: 'utf8', flag: 'wx' });
  return resolved;
}
