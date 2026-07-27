import { readFileSync } from 'node:fs';

import { parse } from 'yaml';

import type { FlowManifest } from '../types.js';
import { resolveWorkspaceRegularFile } from '../lib/paths.js';
import { ValidationError } from '../lib/errors.js';

export function loadFlowManifest(flowPath: string): FlowManifest {
  const resolved = resolveWorkspaceRegularFile(flowPath, 'flow-path');
  const raw = readFileSync(resolved, 'utf8');
  const parsed = parse(raw) as FlowManifest;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ValidationError('flow.yaml must parse to an object.');
  }
  return parsed;
}
