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
  // No token stored yet -- the dev panel starts open.
  await page.getByLabel('Demo JWT (local testing only').fill('a-test-token');
  await expect(page.getByLabel('Demo JWT (local testing only')).toHaveValue('a-test-token');

  await page.reload();

  // A stored token collapses the dev panel by default -- reopen it before asserting.
  await page.getByRole('button', { name: 'Dev settings' }).click();
  await expect(page.getByLabel('Demo JWT (local testing only')).toHaveValue('a-test-token');
});

test('dev settings toggle shows/hides the demo JWT panel', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('Demo JWT (local testing only')).toBeVisible();

  await page.getByRole('button', { name: 'Hide dev settings' }).click();
  await expect(page.getByLabel('Demo JWT (local testing only')).toHaveCount(0);

  await page.getByRole('button', { name: 'Dev settings' }).click();
  await expect(page.getByLabel('Demo JWT (local testing only')).toBeVisible();
});

test('conversation history is empty until a turn happens', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Your conversation with Vita will appear here.')).toBeVisible();
});

test('DPDPA consent modal: Accept & Start dismisses the modal and proceeds past the gate', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: 'Talk to Vita' }).click();
  await page.getByRole('button', { name: 'Accept & Start' }).click();

  await expect(page.getByRole('dialog')).toHaveCount(0);
});

// A full mic-permission + WebSocket round trip against a mocked gateway (grant
// fake-media-stream + mock WS server) is NOT covered here or anywhere else in CI yet --
// this was previously claimed done in a stale comment. It remains real future work; see
// docs/BUILD_GUIDE.md's testing notes for the fixture setup a real version of this test
// would extend.
