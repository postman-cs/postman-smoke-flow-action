import {
  ACKNOWLEDGE_NO_FLOW_REFRESH_FLAG,
  parseCliArgs
} from './lib/cli-args.js';
import { summarizeError } from './lib/logging.js';
import { resolveActionVersion } from './action-version.js';
import { readActionInputs, runAction } from './index.js';
import type { CoreLike } from './types.js';

const outputs: Record<string, string> = {};

const cliCore: CoreLike = {
  setOutput(name, value) {
    outputs[name] = value;
  },
  info(message) {
    console.error(message);
  },
  warning(message) {
    console.error(`warning: ${message}`);
  },
  setFailed(message) {
    console.error(`error: ${message}`);
  }
};

function printHelp(): void {
  process.stdout.write(`Usage: postman-smoke-flow [options]

Apply a curated flow.yaml to a Postman Smoke collection, or refresh the
canonical collection from the generated spec collection.

Options mirror action.yml inputs as --kebab-case flags.

Destructive no-flow refresh (omitting --flow-path) requires:
  --${ACKNOWLEDGE_NO_FLOW_REFRESH_FLAG}

Other:
  --help       Show this help text and exit
  --version    Print the package version and exit
`);
}

function printVersion(): void {
  process.stdout.write(`${resolveActionVersion()}\n`);
}

export function assertCliNoFlowRefreshAllowed(options: {
  flowPath: string | undefined;
  acknowledgeNoFlowRefresh: boolean;
}): void {
  const flowPath = options.flowPath?.trim();
  if (flowPath) {
    return;
  }
  if (options.acknowledgeNoFlowRefresh) {
    return;
  }
  throw new Error(
    `Omitting --flow-path selects a destructive full canonical Smoke refresh. ` +
      `Re-run with --flow-path <path> or pass --${ACKNOWLEDGE_NO_FLOW_REFRESH_FLAG} to acknowledge.`
  );
}

export async function runCli(
  argv: string[] = process.argv,
  actionCore: CoreLike = cliCore,
  env: NodeJS.ProcessEnv = process.env
): Promise<Record<string, string> | void> {
  const parsed = parseCliArgs(argv, env);
  if (parsed.kind === 'help') {
    printHelp();
    return;
  }
  if (parsed.kind === 'version') {
    printVersion();
    return;
  }

  const mergedEnv: NodeJS.ProcessEnv = { ...env, ...parsed.env };
  const inputs = readActionInputs(mergedEnv);
  assertCliNoFlowRefreshAllowed({
    flowPath: inputs.flowPath,
    acknowledgeNoFlowRefresh: parsed.acknowledgeNoFlowRefresh
  });

  await runAction(actionCore, mergedEnv);
  return outputs;
}

async function main(): Promise<void> {
  const result = await runCli(process.argv, cliCore, process.env);
  if (result) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
}

function shouldRunMain(): boolean {
  const cjsModule = typeof module !== 'undefined' ? module : undefined;
  const cjsRequire = typeof require !== 'undefined' ? require : undefined;
  return Boolean(cjsModule && cjsRequire && cjsRequire.main === cjsModule);
}

if (shouldRunMain()) {
  main().catch((error) => {
    console.error(summarizeError(error));
    process.exitCode = 1;
  });
}
