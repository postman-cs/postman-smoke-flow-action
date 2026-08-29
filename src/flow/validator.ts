import type { FlowDefinition, FlowManifest, FlowWarning } from '../types.js';
import { ValidationError } from '../lib/errors.js';

const UNSAFE_OBJECT_PATH_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

export function validateFlowManifest(manifest: FlowManifest): { flow: FlowDefinition; warnings: FlowWarning[] } {
  const warnings: FlowWarning[] = [];

  if (!Array.isArray(manifest.flows) || manifest.flows.length === 0) {
    throw new ValidationError('flow.yaml must contain at least one flow.');
  }
  if (manifest.flows.length !== 1) {
    throw new ValidationError('V1 expects exactly one smoke flow per service.');
  }

  const [flow] = manifest.flows;
  if (!flow || flow.type !== 'smoke') {
    throw new ValidationError('The single V1 flow must be type "smoke".');
  }
  if (!flow.name?.trim()) {
    throw new ValidationError('The smoke flow must have a non-empty name.');
  }
  if (!Array.isArray(flow.steps) || flow.steps.length === 0) {
    throw new ValidationError('The smoke flow must contain at least one step.');
  }

  const seenStepKeys = new Set<string>();
  for (const step of flow.steps) {
    if (!step.stepKey?.trim()) {
      throw new ValidationError('Each step must include a stepKey.');
    }
    if (seenStepKeys.has(step.stepKey)) {
      throw new ValidationError(`Duplicate stepKey found: ${step.stepKey}`);
    }
    seenStepKeys.add(step.stepKey);
    if (!step.operationId?.trim()) {
      throw new ValidationError(`Step ${step.stepKey} is missing operationId.`);
    }
    if (!Array.isArray(step.bindings)) {
      throw new ValidationError(`Step ${step.stepKey} must include bindings as an array.`);
    }
    if (!Array.isArray(step.extract)) {
      throw new ValidationError(`Step ${step.stepKey} must include extract as an array.`);
    }
    for (const binding of step.bindings) {
      if (!binding.fieldKey?.trim()) {
        throw new ValidationError(`Step ${step.stepKey} has a binding without fieldKey.`);
      }
      if (binding.fieldKey.split('.').some((segment) => UNSAFE_OBJECT_PATH_SEGMENTS.has(segment))) {
        throw new ValidationError(
          `Step ${step.stepKey} binding ${binding.fieldKey} contains an unsafe object-path segment.`
        );
      }
      if (binding.source === 'prior_output' && (!binding.sourceStepKey || !binding.variable)) {
        throw new ValidationError(
          `Step ${step.stepKey} binding ${binding.fieldKey} must include sourceStepKey and variable when using prior_output.`
        );
      }
      if (binding.source === 'literal' && binding.value === undefined) {
        throw new ValidationError(
          `Step ${step.stepKey} binding ${binding.fieldKey} must include value when using literal source.`
        );
      }
      if (binding.source === 'example' && binding.value !== undefined) {
        warnings.push({
          message: `Step ${step.stepKey} binding ${binding.fieldKey} uses source=example; explicit value is ignored and the generated request example is preserved.`
        });
      }
    }
    for (const extract of step.extract) {
      if (!extract.variable?.trim() || !extract.jsonPath?.trim()) {
        throw new ValidationError(`Step ${step.stepKey} has an invalid extract rule.`);
      }
    }
  }

  return { flow, warnings };
}
