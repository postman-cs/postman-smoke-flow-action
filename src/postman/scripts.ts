import type { FlowBinding, FlowExtract, FlowStep, SmokeAuthConfig } from '../types.js';

function quote(value: string): string {
  return JSON.stringify(value);
}

export function countAssertionsForStep(step: FlowStep): number {
  return 3 + step.extract.length;
}

function createJsonPathResolverPrelude(): string[] {
  return [
    "function resolveJsonPath(root, jsonPath) {",
    "  if (!jsonPath || !jsonPath.startsWith('$.')) return undefined;",
    "  const segments = jsonPath.slice(2).replace(/\\[(\\d+)\\]/g, '.$1').split('.').filter(Boolean);",
    "  let cursor = root;",
    "  for (const segment of segments) {",
    "    if (cursor === null || cursor === undefined) return undefined;",
    "    cursor = cursor[segment];",
    "  }",
    "  return cursor;",
    "}"
  ];
}

export function buildPreRequestScript(step: FlowStep): string[] {
  const lines = [
    `// [Smoke Flow] Auto-generated prerequest script for ${step.operationId}`
  ];

  for (const binding of step.bindings) {
    if (binding.source === 'prior_output' && binding.variable) {
      lines.push(`pm.collectionVariables.set(${quote(binding.fieldKey)}, pm.collectionVariables.get(${quote(binding.variable)}) || '');`);
      continue;
    }
    if (binding.source === 'literal') {
      lines.push(`pm.collectionVariables.set(${quote(binding.fieldKey)}, ${quote(binding.value ?? '')});`);
    }
  }

  if (step.bindings.length === 0) {
    lines.push('// No explicit prerequest bindings were defined for this step.');
  }

  return lines;
}

export function buildTestScript(step: FlowStep): string[] {
  const lines = [
    `// [Smoke Flow] Auto-generated test script for ${step.operationId}`,
    '',
    "pm.test('Status code is successful (2xx)', function () {",
    '  pm.response.to.be.success;',
    '});',
    '',
    "pm.test('Response time is acceptable', function () {",
    "  const threshold = parseInt(pm.environment.get('RESPONSE_TIME_THRESHOLD') || '2000', 10);",
    '  pm.expect(pm.response.responseTime).to.be.below(threshold);',
    '});',
    '',
    "pm.test('Response body is not empty', function () {",
    '  if (pm.response.code !== 204) {',
    '    pm.expect(pm.response.text().length).to.be.above(0);',
    '  }',
    '});',
    ''
  ];

  if (step.extract.length > 0) {
    lines.push(...createJsonPathResolverPrelude(), '', 'let jsonBody;', 'try {', '  jsonBody = pm.response.json();', '} catch {', '  jsonBody = undefined;', '}');
    for (const extract of step.extract) {
      lines.push(
        '',
        `pm.test(${quote(`Extract ${extract.variable}`)}, function () {`,
        `  const value = resolveJsonPath(jsonBody, ${quote(extract.jsonPath)});`,
        "  pm.expect(value, 'expected extracted value to exist').to.not.be.undefined;",
        `  pm.collectionVariables.set(${quote(extract.variable)}, typeof value === 'string' ? value : JSON.stringify(value));`,
        '});'
      );
    }
  }

  return lines;
}

export function createTestEvent(step: FlowStep): Record<string, unknown> {
  return {
    listen: 'test',
    script: {
      type: 'text/javascript',
      exec: buildTestScript(step)
    }
  };
}

export function createPreRequestEvent(step: FlowStep): Record<string, unknown> {
  return {
    listen: 'prerequest',
    script: {
      type: 'text/javascript',
      exec: buildPreRequestScript(step)
    }
  };
}

function getAuthVariableNames(authConfig: SmokeAuthConfig): Required<NonNullable<SmokeAuthConfig['variables']>> {
  return {
    tokenUrl: authConfig.variables?.tokenUrl || 'auth_token_url',
    scope: authConfig.variables?.scope || 'auth_scope',
    clientId: authConfig.variables?.clientId || 'auth_client_id',
    clientSecret: authConfig.variables?.clientSecret || 'auth_client_secret',
    accessToken: authConfig.variables?.accessToken || 'access_token',
    expiresAt: authConfig.variables?.expiresAt || 'access_token_expires_at'
  };
}

export function buildOAuthPreRequestScript(authConfig: SmokeAuthConfig): string[] {
  const variables = getAuthVariableNames(authConfig);
  const refreshSkewSeconds = authConfig.cache?.refreshSkewSeconds ?? 60;
  const tokenUrlTemplate = authConfig.tokenUrl || `{{${variables.tokenUrl}}}`;
  const contentType = authConfig.request?.contentType || 'application/x-www-form-urlencoded';

  return [
    '// [Smoke Flow] Auto-generated OAuth2 client-credentials token cache.',
    `const accessTokenVariable = ${quote(variables.accessToken)};`,
    `const expiresAtVariable = ${quote(variables.expiresAt)};`,
    `const refreshSkewMs = ${Math.max(0, refreshSkewSeconds)} * 1000;`,
    "const cachedToken = pm.variables.get(accessTokenVariable);",
    "const cachedExpiresAt = Number(pm.variables.get(expiresAtVariable) || '0');",
    'if (cachedToken && cachedExpiresAt && Date.now() < cachedExpiresAt - refreshSkewMs) {',
    '  return;',
    '}',
    '',
    `const tokenUrl = pm.variables.replaceIn(${quote(tokenUrlTemplate)});`,
    `const clientId = pm.variables.get(${quote(variables.clientId)});`,
    `const clientSecret = pm.variables.get(${quote(variables.clientSecret)});`,
    `const scope = pm.variables.get(${quote(variables.scope)}) || '';`,
    "if (!tokenUrl || tokenUrl.includes('{{')) {",
    "  throw new Error('Smoke OAuth is enabled, but auth_token_url is missing.');",
    '}',
    'if (!clientId || !clientSecret) {',
    "  throw new Error('Smoke OAuth is enabled, but client credentials were not provided at runtime.');",
    '}',
    '',
    'const tokenBody = {',
    "  grant_type: 'client_credentials',",
    '  client_id: clientId,',
    '  client_secret: clientSecret',
    '};',
    'if (scope) {',
    '  tokenBody.scope = scope;',
    '}',
    '',
    'pm.sendRequest({',
    '  url: tokenUrl,',
    "  method: 'POST',",
    `  header: { 'Content-Type': ${quote(contentType)} },`,
    '  body: {',
    "    mode: 'urlencoded',",
    '    urlencoded: Object.entries(tokenBody).map(([key, value]) => ({ key, value: String(value) }))',
    '  }',
    '}, function (error, response) {',
    '  if (error) {',
    "    throw new Error('Smoke OAuth token request failed.');",
    '  }',
    '  if (!response || response.code < 200 || response.code >= 300) {',
    "    throw new Error('Smoke OAuth token request returned a non-success status.');",
    '  }',
    '  const json = response.json();',
    '  const accessToken = json && json.access_token;',
    '  if (!accessToken) {',
    "    throw new Error('Smoke OAuth token response did not include access_token.');",
    '  }',
    "  const expiresInSeconds = Number(json.expires_in || '300');",
    '  pm.variables.set(accessTokenVariable, accessToken);',
    '  pm.variables.set(expiresAtVariable, String(Date.now() + expiresInSeconds * 1000));',
    '});'
  ];
}

export function createOAuthPreRequestEvent(authConfig: SmokeAuthConfig): Record<string, unknown> {
  return {
    listen: 'prerequest',
    script: {
      type: 'text/javascript',
      exec: buildOAuthPreRequestScript(authConfig)
    }
  };
}

export function createSecretsResolverItem(): Record<string, unknown> {
  return {
    name: '00 - Resolve Secrets',
    request: {
      auth: {
        type: 'awsv4',
        awsv4: [
          { key: 'accessKey', value: '{{AWS_ACCESS_KEY_ID}}' },
          { key: 'secretKey', value: '{{AWS_SECRET_ACCESS_KEY}}' },
          { key: 'region', value: '{{AWS_REGION}}' },
          { key: 'service', value: 'secretsmanager' }
        ]
      },
      method: 'POST',
      header: [
        { key: 'X-Amz-Target', value: 'secretsmanager.GetSecretValue' },
        { key: 'Content-Type', value: 'application/x-amz-json-1.1' }
      ],
      body: {
        mode: 'raw',
        raw: '{"SecretId": "{{AWS_SECRET_NAME}}"}'
      },
      url: {
        raw: 'https://secretsmanager.{{AWS_REGION}}.amazonaws.com',
        protocol: 'https',
        host: ['secretsmanager', '{{AWS_REGION}}', 'amazonaws', 'com']
      }
    },
    event: [
      {
        listen: 'test',
        script: {
          type: 'text/javascript',
          exec: [
            'if (pm.environment.get("CI") === "true") { return; }',
            'const body = pm.response.json();',
            'if (body.SecretString) {',
            '  const secrets = JSON.parse(body.SecretString);',
            '  Object.entries(secrets).forEach(([k, v]) => pm.collectionVariables.set(k, v));',
            '}'
          ]
        }
      }
    ]
  };
}
