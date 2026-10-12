import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }, testInfo) => {
  await page.goto('/');
  await expect(page.locator('#lab')).toHaveCSS('--ifl-paper', testInfo.project.use.colorScheme === 'dark' ? '#18251f' : '#f6f3eb');
});

// Exercise each primary state before and after producing a run where applicable.
for (const state of ['picker', 'guided', 'free']) {
  test(state + ' controls reflow at 320/375/768/1440 CSS pixels', async ({ page }) => {
    await page.goto('/');
    if (state !== 'picker') await page.getByRole('button', { name: state === 'guided' ? /^Guided Walk/ : /^Free-form Pick/ }).click();
    for (const width of [320, 375, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.locator(state === 'picker' ? '.ifl-picker' : state === 'guided' ? '.ifl-chips' : '.ifl-form')).toBeVisible();
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (state !== 'picker') {
        await page.getByRole('button', { name: state === 'guided' ? 'Run scenario' : 'Run', exact: true }).click();
        await expect(page.locator('.ifl-final-state')).toBeVisible();
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      }
    }
  });
}

test('live resize preserves partly configured form, focus and functional mode switching', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: /^Free-form Pick/ }).click();
  const event = page.getByLabel('Event that times out', { exact: true });
  await page.getByLabel('Downstream times out on', { exact: true }).check();
  await event.selectOption('ClaimAccepted');
  await page.getByLabel('Which attempts time out', { exact: true }).selectOption('all');
  await event.focus();
  const documentId = await page.evaluate(() => performance.timeOrigin);
  for (const width of [768, 375, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(event).toHaveValue('ClaimAccepted');
    await expect(event).toBeFocused();
    await expect(page.getByLabel('Downstream times out on', { exact: true })).toBeChecked();
    await expect(page.getByLabel('Which attempts time out', { exact: true })).toHaveValue('all');
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(documentId);
  }
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.locator('.ifl-final-state')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Dead-letter queue', exact: true })).toContainText('ClaimAccepted');
  await page.getByRole('button', { name: 'Switch to guided', exact: true }).click();
  await expect(page.getByRole('button', { name: /^1a:/ })).toBeFocused();
  await page.getByRole('button', { name: 'Switch to free-form', exact: true }).click();
  await expect(page.getByLabel('Downstream times out on', { exact: true })).toBeFocused();
  expect(errors).toEqual([]);
});
