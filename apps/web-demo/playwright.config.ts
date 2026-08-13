import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  webServer: {
    command: 'pnpm dev',
    port: 5173,
    reuseExistingServer: !process.env.CI,
  },
  use: {
    baseURL: 'http://localhost:5173',
    // Pin to the sandbox's pre-installed Chromium build rather than
    // downloading one that matches whatever @playwright/test version pnpm
    // resolved — avoids the "browser not found" mismatch in this dev
    // container. Remove this override in environments that run
    // `playwright install` normally (e.g. a real CI runner).
    launchOptions: process.env.PLAYWRIGHT_BROWSERS_PATH
      ? { executablePath: '/opt/pw-browsers/chromium' }
      : {},
  },
});
