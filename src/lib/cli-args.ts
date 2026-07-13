import { smokeFlowActionContract } from '../contracts.js';

export const ACKNOWLEDGE_NO_FLOW_REFRESH_FLAG = 'acknowledge-no-flow-refresh';

const BOOLEAN_TRUE = new Set(['1', 'true', 'yes', 'on']);
const BOOLEAN_FALSE = new Set(['0', 'false', 'no', 'off']);

const BOOLEAN_INPUT_OPTIONS = new Set([
  'secrets-resolver-enabled',
  'fail-on-flow-warning',
  'keep-temp-collection-on-failure'
]);

const KNOWN_INPUT_OPTIONS = new Set(Object.keys(smokeFlowActionContract.inputs));

const KNOWN_OPTIONS = new Set([...KNOWN_INPUT_OPTIONS, ACKNOWLEDGE_NO_FLOW_REFRESH_FLAG, 'help', 'version']);

export type ParsedCliArgs =
  | { kind: 'help' }
  | { kind: 'version' }
  | {
      kind: 'run';
      env: NodeJS.ProcessEnv;
      acknowledgeNoFlowRefresh: boolean;
    };

export function normalizeBooleanFlag(flagName: string, rawValue: string): string {
  const normalized = rawValue.trim().toLowerCase();
  if (BOOLEAN_TRUE.has(normalized)) {
    return 'true';
  }
  if (BOOLEAN_FALSE.has(normalized)) {
    return 'false';
  }
  throw new Error(`Invalid boolean value for --${flagName}: ${rawValue}`);
}

function toInputEnvName(optionName: string): string {
  return `INPUT_${optionName.replace(/-/g, '_').toUpperCase()}`;
}

export function parseCliArgs(argv: string[], _baseEnv: NodeJS.ProcessEnv = {}): ParsedCliArgs {
  void _baseEnv;
  const args = argv.slice(2);
  const env: NodeJS.ProcessEnv = {};
  const seen = new Set<string>();
  let acknowledgeNoFlowRefresh = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token) {
      continue;
    }

    if (!token.startsWith('--')) {
      throw new Error(`Unexpected positional argument: ${token}`);
    }

    const raw = token.slice(2);
    const equalsIndex = raw.indexOf('=');
    const optionName = equalsIndex >= 0 ? raw.slice(0, equalsIndex) : raw;

    if (!optionName || !KNOWN_OPTIONS.has(optionName)) {
      throw new Error(`Unknown option: --${optionName || token.slice(2)}`);
    }

    if (optionName === 'help' || optionName === 'version') {
      if (equalsIndex >= 0) {
        throw new Error(`Option --${optionName} does not accept a value`);
      }
      if (args.length !== 1) {
        throw new Error(`Option --${optionName} cannot be combined with other options`);
      }
      return { kind: optionName };
    }

    if (seen.has(optionName)) {
      throw new Error(`Duplicate option: --${optionName}`);
    }
    seen.add(optionName);

    let rawValue: string | undefined;
    if (equalsIndex >= 0) {
      rawValue = raw.slice(equalsIndex + 1);
    } else {
      const next = args[index + 1];
      if (next !== undefined && !next.startsWith('--')) {
        rawValue = next;
        index += 1;
      } else if (optionName === ACKNOWLEDGE_NO_FLOW_REFRESH_FLAG) {
        rawValue = 'true';
      } else {
        throw new Error(`Missing value for --${optionName}`);
      }
    }

    if (rawValue === '') {
      throw new Error(`Missing value for --${optionName}`);
    }

    if (BOOLEAN_INPUT_OPTIONS.has(optionName) || optionName === ACKNOWLEDGE_NO_FLOW_REFRESH_FLAG) {
      const normalized = normalizeBooleanFlag(optionName, rawValue);
      if (optionName === ACKNOWLEDGE_NO_FLOW_REFRESH_FLAG) {
        acknowledgeNoFlowRefresh = normalized === 'true';
        continue;
      }
      env[toInputEnvName(optionName)] = normalized;
      continue;
    }

    env[toInputEnvName(optionName)] = rawValue;
  }

  return {
    kind: 'run',
    env,
    acknowledgeNoFlowRefresh
  };
}

export function applyArgsToEnv(argv: string[], env: NodeJS.ProcessEnv): void {
  const parsed = parseCliArgs(argv, env);
  if (parsed.kind !== 'run') {
    return;
  }
  Object.assign(env, parsed.env);
}
