import { expect, test } from '@playwright/test';

test('renders the Vita talk button', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Talk to Vita' })).toBeVisible();
});

test('DPDPA consent modal: hidden by default, opens on "Talk to Vita", Cancel dismisses it without starting a session', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await page.getByRole('button', { name: 'Talk to Vita' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Before we start' })).toBeVisible();

  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Talk to Vita' })).toBeVisible();
});

test('demo JWT field persists a pasted token across a page reload', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Demo JWT (local testing only').fill('a-test-token');
  await expect(page.getByLabel('Demo JWT (local testing only')).toHaveValue('a-test-token');

  await page.reload();

  await expect(page.getByLabel('Demo JWT (local testing only')).toHaveValue('a-test-token');
});

test('DPDPA consent modal: Accept & Start dismisses the modal and proceeds past the gate', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: 'Talk to Vita' }).click();
  await page.getByRole('button', { name: 'Accept & Start' }).click();

  await expect(page.getByRole('dialog')).toHaveCount(0);
});

// Full mic-permission + WebSocket round trip is covered against a mocked
// gateway in CI (grant fake-media-stream + mock WS server) — see
// docs/BUILD_GUIDE.md §4.2 for the fixture setup this test extends.
