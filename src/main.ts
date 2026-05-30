import * as core from '@actions/core';

import { runAction } from './index.js';
import { summarizeError } from './lib/logging.js';

runAction().catch((error) => {
  core.setFailed(summarizeError(error));
});
