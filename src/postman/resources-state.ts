import { existsSync, readFileSync } from 'node:fs';

import { parse } from 'yaml';

type CloudResourceMap = Record<string, string>;

type ResourcesState = {
  cloudResources?: {
    flows?: CloudResourceMap;
  };
};

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function readFlowIdFromResources(flowName: string): string | undefined {
  if (!existsSync('.postman/resources.yaml')) {
    return undefined;
  }

  try {
    const parsed = parse(readFileSync('.postman/resources.yaml', 'utf8')) as ResourcesState | null;
    const flows = parsed?.cloudResources?.flows;
    if (!flows) {
      return undefined;
    }

    const normalizedName = normalize(flowName);
    const entries = Object.entries(flows);
    const namedMatch = entries.find(([resourcePath]) => normalize(resourcePath).includes(normalizedName));
    return namedMatch?.[1] ?? entries[0]?.[1];
  } catch {
    return undefined;
  }
}
