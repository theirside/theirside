import { defineProject, mergeConfig } from 'vitest/config';
import base from '../../vitest.shared.js';

export default mergeConfig(
  base,
  defineProject({
    test: {
      name: 'collector',
      pool: 'forks',
      fileParallelism: false,
      testTimeout: 30000,
      hookTimeout: 60000,
    },
  }),
);
