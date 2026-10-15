import { test, expect } from '@playwright/test';

test('host theme tokens reach Guided and Free-form runs without horizontal overflow', async ({ page }, testInfo) => {
  await page.goto('/');
  const dark = testInfo.project.use.colorScheme === 'dark';
  expect(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(dark);
  await expect(page.locator('#lab')).toHaveCSS('--ifl-paper', dark ? '#18251f' : '#f6f3eb');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await page.getByRole('button', { name: /^Guided Walk/ }).click();
  for (const mode of ['guided', 'free-form']) {
    if (mode === 'free-form') await page.getByRole('button', { name: 'Switch to free-form', exact: true }).click();
    await expect(page.locator('.ifl-final-state')).toBeHidden();
    await page.getByRole('button', { name: mode === 'guided' ? 'Run scenario' : 'Run', exact: true }).click();
    await expect(page.locator('.ifl-final-state')).toBeVisible();
    await expect(page.locator('#lab')).toHaveCSS('--ifl-paper', dark ? '#18251f' : '#f6f3eb');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});
