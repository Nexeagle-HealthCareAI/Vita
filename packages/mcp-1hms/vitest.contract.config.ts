import { defineConfig } from 'vitest/config';

// Separate config used only by `pnpm test:contract` -- the default vitest.config.ts
// excludes hmsClient.contract.test.ts (exclude patterns apply even to an explicit path
// argument, so there's no way to "opt back in" from within that config); this one
// targets it exclusively instead.
export default defineConfig({
  test: {
    include: ['test/hmsClient.contract.test.ts'],
  },
});
