import { expect, test } from '@playwright/test';

test('renders the registration form and Vita talk button', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByPlaceholder('Patient Name')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Talk to Vita' })).toBeVisible();
});

test('typing into the form fields works independently of the voice session', async ({ page }) => {
  await page.goto('/');
  await page.getByPlaceholder('Patient Name').fill('Asha Verma');
  await expect(page.getByPlaceholder('Patient Name')).toHaveValue('Asha Verma');
});

// Full mic-permission + WebSocket round trip is covered against a mocked
// gateway in CI (grant fake-media-stream + mock WS server) — see
// docs/BUILD_GUIDE.md §4.2 for the fixture setup this test extends.
