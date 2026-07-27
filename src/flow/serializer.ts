import { stringify } from 'yaml';

import type { FlowDefinition, FlowManifest } from '../types.js';

/**
 * Serialize a derived flow as the curated flow.yaml manifest shape.
 *
 * The file format is the outer FlowManifest ({ flows: [...] }), not the bare
 * FlowDefinition: loadFlowManifest + validateFlowManifest consume exactly what
 * this emits, so a persisted derived flow round-trips losslessly into a
 * curated run.
 */
export function stringifyFlowManifest(flow: FlowDefinition, spec?: FlowManifest['spec']): string {
  const manifest: FlowManifest = spec ? { spec, flows: [flow] } : { flows: [flow] };
  return stringify(manifest);
}
