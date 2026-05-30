export const customerPreviewActionContract = {
  inputs: {
    'project-name': { required: true },
    'workspace-id': { required: true },
    'spec-id': { required: true },
    'smoke-collection-id': { required: true },
    'flow-path': { required: true },
    'postman-api-key': { required: true },
    'auth-config-json': { required: false },
    'secrets-resolver-enabled': { required: false, default: 'true' },
    'spec-path': { required: false },
    'debug-dump-path': { required: false },
    'collection-sync-mode': { required: false, default: 'refresh' },
    'postman-access-token': { required: false },
    'fail-on-flow-warning': { required: false, default: 'false' },
    'keep-temp-collection-on-failure': { required: false, default: 'false' },
    'temp-collection-prefix': { required: false, default: '[Smoke][Temp]' }
  },
  outputs: {
    'smoke-collection-id': {},
    'flow-apply-status': {},
    'flow-apply-summary-json': {},
    'temporary-smoke-collection-id': {},
    'flow-step-count': {},
    'resolved-operation-count': {},
    'applied-binding-count': {},
    'applied-extract-count': {},
    'assertion-count': {}
  }
} as const;
