import { defineProject, mergeConfig } from 'vitest/config';
import base from '../../vitest.shared.js';

export default mergeConfig(
  base,
  defineProject({
    define: { __SDK_VERSION__: JSON.stringify('0.0.0-test') },
    test: { name: 'sdk', pool: 'forks', fileParallelism: false },
  }),
);
