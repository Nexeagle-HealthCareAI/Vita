import { defineConfig } from 'vitest/config';

// Excludes the real-easyHMSAPI contract test from the default `vitest`/`pnpm test` run --
// it depends on an external dev service being up and its bookAppointment case is a real
// write, so it must never run on every PR. Run explicitly via `pnpm test:contract` (see
// package.json and hmsClient.contract.test.ts's own doc comment).
export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', 'test/hmsClient.contract.test.ts'],
  },
});
