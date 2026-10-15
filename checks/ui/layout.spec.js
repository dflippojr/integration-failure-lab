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

async function box(locator) {
  await expect(locator).toBeVisible();
  const bounds = await locator.boundingBox();
  expect(bounds).not.toBeNull();
  return bounds;
}

async function panes(page, sideBySide) {
  const controls = await box(page.locator('.ifl-body'));
  const output = await box(page.locator('.ifl-output'));
  const bar = await box(page.locator('.ifl-bar'));
  expect(bar.y + bar.height).toBeLessThanOrEqual(controls.y + 1);
  if (sideBySide) {
    expect(controls.x + controls.width).toBeLessThanOrEqual(output.x + 1);
    expect(Math.abs(controls.y - output.y)).toBeLessThanOrEqual(1);
    expect(bar.x).toBeLessThanOrEqual(controls.x + 1);
    expect(bar.x + bar.width).toBeGreaterThanOrEqual(output.x + output.width - 1);
  } else {
    expect(output.y).toBeGreaterThanOrEqual(controls.y + controls.height);
    expect(Math.abs(controls.x - output.x)).toBeLessThanOrEqual(1);
  }
}

test('two-pane layout follows the lab width, keeps the picker single column and stacks for print', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  const picker = await box(page.locator('.ifl-body'));
  const bar = await box(page.locator('.ifl-bar'));
  expect(picker.y).toBeGreaterThanOrEqual(bar.y + bar.height);
  expect(Math.abs(picker.x - bar.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(picker.width - bar.width)).toBeLessThanOrEqual(1);
  await expect(page.locator('.ifl-output')).toBeHidden();

  await page.getByRole('button', { name: /^Guided Walk/ }).click();
  for (const mode of ['guided', 'free-form']) {
    if (mode === 'free-form') await page.getByRole('button', { name: 'Switch to free-form', exact: true }).click();
    await page.getByRole('button', { name: mode === 'guided' ? 'Run scenario' : 'Run', exact: true }).click();
    await expect(page.locator('.ifl-final-state')).toBeVisible();
    await panes(page, true);
    // A narrow embedding must stack even while the viewport stays wide.
    await page.locator('main').evaluate(main => { main.style.maxWidth = '768px'; });
    await panes(page, false);
    await page.locator('main').evaluate(main => { main.style.maxWidth = ''; });
    for (const width of [768, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await panes(page, false);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await panes(page, true);
    await page.emulateMedia({ media: 'print' });
    await panes(page, false);
    await page.emulateMedia({ media: 'screen' });
  }
});
