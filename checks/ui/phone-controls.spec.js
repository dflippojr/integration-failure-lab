import { test, expect } from '@playwright/test';
import { SCENARIOS } from '../../dist/scenarios.js';

async function touchGeometry(page) {
  const targets = await page.locator('.ifl button:enabled, .ifl select:enabled, .ifl-check').evaluateAll(elements =>
    elements.filter(element => element.getClientRects().length).map(element => {
      const rect = element.getBoundingClientRect();
      return { name: element.getAttribute('aria-label') || element.textContent.trim(),
        x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }));
  expect(targets.length).toBeGreaterThan(0);
  for (const target of targets) {
    expect(target.width, target.name + ' width').toBeGreaterThanOrEqual(44);
    expect(target.height, target.name + ' height').toBeGreaterThanOrEqual(44);
  }
  for (let i = 0; i < targets.length; i++) {
    for (const other of targets.slice(i + 1)) {
      const target = targets[i];
      const dx = Math.max(0, target.x - other.x - other.width, other.x - target.x - target.width);
      const dy = Math.max(0, target.y - other.y - other.height, other.y - target.y - target.height);
      expect(Math.hypot(dx, dy), target.name + ' / ' + other.name + ' gap').toBeGreaterThanOrEqual(8);
    }
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

test('picker count follows the manifest and guided progress including 6a/6b', async ({ page }) => {
  await page.goto('/');
  const picker = page.getByRole('button', { name: /^Guided Walk/ });
  await expect(picker).toContainText(`Walk through ${SCENARIOS.length} failures one at a time.`);
  await picker.click();
  await expect(page.locator('.ifl-kicker').first()).toHaveText(`Guided · scenario 1 of ${SCENARIOS.length}`);
  await expect(page.getByRole('group', { name: 'Scenarios', exact: true }).getByRole('button')).toHaveCount(SCENARIOS.length);
  for (const id of ['6a', '6b']) {
    const index = SCENARIOS.findIndex(scenario => scenario.id.startsWith(id + '-'));
    await page.getByRole('button', { name: new RegExp('^' + id + ':') }).click();
    await expect(page.locator('.ifl-kicker').first()).toHaveText(`Guided · scenario ${index + 1} of ${SCENARIOS.length}`);
  }
});

test('phone hit areas, gaps and select text survive rotation and narrow forms', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.use.isMobile, 'Touch geometry uses genuine phone device contexts');
  const { width, height } = testInfo.project.use.viewport;
  for (const viewport of [{ width, height }, { width: height, height: width }, { width: 320, height }]) {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await expect(page.locator('#lab')).toHaveCSS('--ifl-paper', testInfo.project.use.colorScheme === 'dark' ? '#18251f' : '#f6f3eb');
    await touchGeometry(page);
    await page.getByRole('button', { name: /^Guided Walk/ }).click();
    for (const scenario of SCENARIOS) {
      await page.getByRole('button', { name: scenario.id.split('-')[0] + ': ' + scenario.title, exact: true }).click();
      await touchGeometry(page);
    }
    await page.getByRole('button', { name: /^1a:/ }).click();
    await page.route('**/executed.js', route => route.fulfill({ status: 503, body: 'Synthetic unavailable recording' }));
    await page.getByRole('button', { name: 'Executed: Java / Spring', exact: true }).click();
    await page.getByRole('button', { name: 'Replay real run', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Retry replay', exact: true })).toBeVisible();
    await touchGeometry(page);
    await page.getByRole('button', { name: 'Switch to free-form', exact: true }).click();
    await touchGeometry(page);
    const selects = page.locator('.ifl select');
    await expect(selects).toHaveCount(6);
    for (const select of await selects.all()) {
      expect(await select.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
      await select.focus();
      await expect(select).toBeFocused();
      await select.selectOption({ index: 1 });
    }
    // Click the label away from the checkbox to exercise its full hit area.
    const label = page.locator('.ifl-check').filter({ hasText: 'Ack lost for' });
    await label.click({ position: { x: 35, y: 22 } });
    await expect(page.getByLabel('Ack lost for', { exact: true })).toBeChecked();
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(page.locator('.ifl-final-state')).toBeVisible();
    await touchGeometry(page);
    await page.unroute('**/executed.js');
  }
});
