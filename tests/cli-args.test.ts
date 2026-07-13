import { describe, expect, it } from 'vitest';

import {
  ACKNOWLEDGE_NO_FLOW_REFRESH_FLAG,
  applyArgsToEnv,
  parseCliArgs
} from '../src/lib/cli-args.js';

describe('CLI argument parsing', () => {
  it('accepts both --flag value and --flag=value forms', () => {
    const env: NodeJS.ProcessEnv = {};

    applyArgsToEnv(
      [
        'node',
        'postman-smoke-flow',
        '--project-name=payments',
        '--workspace-id',
        'ws-123',
        '--postman-api-key=PMAK-123'
      ],
      env
    );

    expect(env.INPUT_PROJECT_NAME).toBe('payments');
    expect(env.INPUT_WORKSPACE_ID).toBe('ws-123');
    expect(env.INPUT_POSTMAN_API_KEY).toBe('PMAK-123');
  });

  it('writes explicit CLI values to runner-form and normalized aliases', () => {
    const parsed = parseCliArgs(
      ['node', 'postman-smoke-flow', '--project-name=cli-project', '--flow-path', 'examples/flow.yaml'],
      {}
    );
    expect(parsed.kind).toBe('run');
    if (parsed.kind !== 'run') {
      return;
    }

    expect(parsed.env['INPUT_PROJECT-NAME']).toBe('cli-project');
    expect(parsed.env.INPUT_PROJECT_NAME).toBe('cli-project');
    expect(parsed.env['INPUT_FLOW-PATH']).toBe('examples/flow.yaml');
    expect(parsed.env.INPUT_FLOW_PATH).toBe('examples/flow.yaml');
  });

  it('rejects unknown options such as --flow-pth', () => {
    expect(() =>
      parseCliArgs(['node', 'postman-smoke-flow', '--flow-pth', 'flow.yaml'], {})
    ).toThrow(/Unknown option: --flow-pth/);
  });

  it('rejects positional arguments', () => {
    expect(() =>
      parseCliArgs(['node', 'postman-smoke-flow', 'flow.yaml'], {})
    ).toThrow(/Unexpected positional argument: flow\.yaml/);
  });

  it('rejects missing option values', () => {
    expect(() =>
      parseCliArgs(['node', 'postman-smoke-flow', '--project-name'], {})
    ).toThrow(/Missing value for --project-name/);
  });

  it('rejects a value that is itself another flag', () => {
    expect(() =>
      parseCliArgs(['node', 'postman-smoke-flow', '--project-name', '--workspace-id'], {})
    ).toThrow(/Missing value for --project-name/);
  });

  it('rejects missing boolean and empty inline values', () => {
    expect(() =>
      parseCliArgs(['node', 'postman-smoke-flow', '--fail-on-flow-warning'], {})
    ).toThrow(/Missing value for --fail-on-flow-warning/);
    expect(() =>
      parseCliArgs(['node', 'postman-smoke-flow', '--flow-path='], {})
    ).toThrow(/Missing value for --flow-path/);
  });

  it('rejects duplicate options', () => {
    expect(() =>
      parseCliArgs(
        ['node', 'postman-smoke-flow', '--project-name=a', '--project-name', 'b'],
        {}
      )
    ).toThrow(/Duplicate option: --project-name/);
  });

  it('rejects invalid boolean values', () => {
    expect(() =>
      parseCliArgs(
        ['node', 'postman-smoke-flow', '--fail-on-flow-warning', 'maybe'],
        {}
      )
    ).toThrow(/Invalid boolean value for --fail-on-flow-warning/);
  });

  it('accepts strict boolean values and normalizes them', () => {
    const parsed = parseCliArgs(
      ['node', 'postman-smoke-flow', '--fail-on-flow-warning=YES', '--secrets-resolver-enabled', '0'],
      {}
    );
    expect(parsed.kind).toBe('run');
    if (parsed.kind !== 'run') {
      return;
    }
    expect(parsed.env.INPUT_FAIL_ON_FLOW_WARNING).toBe('true');
    expect(parsed.env.INPUT_SECRETS_RESOLVER_ENABLED).toBe('false');
  });

  it('detects --help and --version without applying run options', () => {
    expect(parseCliArgs(['node', 'postman-smoke-flow', '--help'], {}).kind).toBe('help');
    expect(parseCliArgs(['node', 'postman-smoke-flow', '--version'], {}).kind).toBe('version');
  });

  it('rejects values or mixed run options on help and version', () => {
    expect(() =>
      parseCliArgs(['node', 'postman-smoke-flow', '--help=yes'], {})
    ).toThrow(/does not accept a value/);
    expect(() =>
      parseCliArgs(['node', 'postman-smoke-flow', '--version', '--flow-path', 'flow.yaml'], {})
    ).toThrow(/cannot be combined/);
  });

  it(`surfaces ${ACKNOWLEDGE_NO_FLOW_REFRESH_FLAG} as a CLI-only acknowledgment`, () => {
    const parsed = parseCliArgs(
      ['node', 'postman-smoke-flow', `--${ACKNOWLEDGE_NO_FLOW_REFRESH_FLAG}`],
      {}
    );
    expect(parsed.kind).toBe('run');
    if (parsed.kind !== 'run') {
      return;
    }
    expect(parsed.acknowledgeNoFlowRefresh).toBe(true);
    expect(parsed.env.INPUT_ACKNOWLEDGE_NO_FLOW_REFRESH).toBeUndefined();
  });
});
