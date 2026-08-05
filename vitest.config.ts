import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@tokia/shared': path.resolve(process.cwd(), 'packages/shared/src/index.ts'),
      '@tokia/shared/normalization': path.resolve(process.cwd(), 'packages/shared/src/normalization.ts'),
      '@tokia/shared/schemas': path.resolve(process.cwd(), 'packages/shared/src/schemas.ts'),
      '@tokia/shared/types': path.resolve(process.cwd(), 'packages/shared/src/types.ts')
    }
  },
  test: {
    environment: 'node',
    include: ['**/*.test.ts'],
    passWithNoTests: false
  }
});
