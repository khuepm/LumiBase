import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'policy/index': 'src/policy/index.ts',
    'field/index': 'src/field/index.ts',
    'schemas/index': 'src/schemas/index.ts',
    'extensions/index': 'src/extensions/index.ts',
    'platform/index': 'src/platform/index.ts',
    'intents/index': 'src/intents/index.ts',
    'form-layout/index': 'src/form-layout/index.ts',
    version: 'src/version.ts',
    'utils/logger': 'src/utils/logger.ts',
  },
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  splitting: false,
  treeshake: true,
});
