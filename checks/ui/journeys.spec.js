import { test, expect } from '@playwright/test';
import { SCENARIOS } from '../../dist/scenarios.js';
import { run } from '../../engine/engine.js';

// Each test gets a fresh browser context. Only mode/source preferences persist;
// scenario selection, form settings and results intentionally reset on reload.
test.beforeEach(async ({ page }, testInfo) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: /^Guided Walk/ })).toBeVisible();
  await expect(page.locator('#lab')).toHaveCSS('--ifl-paper', testInfo.project.use.colorScheme === 'dark' ? '#18251f' : '#f6f3eb');
});

async function guided(page) {
  await page.getByRole('button', { name: /^Guided Walk/ }).click();
  await expect(page.getByRole('group', { name: 'Scenarios', exact: true })).toBeVisible();
}
async function completed(page) {
  await expect(page.locator('.ifl-final-state')).toBeVisible();
}
async function finalGroups(page, result) {
  for (const [name, entries] of [['Dead-letter queue', result.dlq], ['Dropped messages', result.dropped], ['Ordering buffer', result.buffered]]) {
    const group = page.getByRole('region', { name, exact: true });
    await expect(group.getByRole('heading')).toHaveText(name + ' (' + entries.length + ')');
    if (!entries.length) await expect(group.getByText('Empty', { exact: true })).toBeVisible();
    else for (const entry of entries) {
      await expect(group.getByText(entry.eventId, { exact: true })).toBeVisible();
      await expect(group.getByText(entry.eventType, { exact: true })).toBeVisible();
    }
  }
}

test('J1 keyboard selection, navigation endpoints, focus and persistent mode', async ({ page }) => {
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: /^Guided Walk/ })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: /^1a:/ })).toBeFocused();
  await expect(page.getByRole('button', { name: /Previous/ })).toBeDisabled();
  await page.getByRole('button', { name: /Next/ }).click();
  await expect(page.getByRole('heading', { name: SCENARIOS[1].title, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Next/ })).toBeFocused();
  await page.getByRole('button', { name: /^6b:/ }).click();
  await expect(page.getByRole('button', { name: /Next/ })).toBeDisabled();
  await page.getByRole('button', { name: 'Switch to free-form', exact: true }).click();
  await page.reload();
  await expect(page.locator('.ifl-form')).toBeVisible();
  await expect(page.locator('.ifl-output')).toBeHidden();
});

test('J2 all guided scenarios expose their verdict, claim record and final queues', async ({ page }) => {
  await guided(page);
  for (const scenario of SCENARIOS) {
    await page.getByRole('button', { name: scenario.id.split('-')[0] + ': ' + scenario.title, exact: true }).click();
    await expect(page.locator('.ifl-output')).toBeHidden();
    await page.getByRole('button', { name: 'Run scenario', exact: true }).click();
    await completed(page);
    const result = run(scenario);
    await expect(page.locator('.ifl-verdict-head')).toHaveText(result.verdict.summary);
    const rows = page.locator('.ifl-record tbody tr');
    await expect(rows.nth(0).locator('td').last()).toHaveText(result.record.status ?? '—');
    await expect(rows.nth(1).locator('td').last()).toHaveText('$' + (result.record.paidCents / 100).toFixed(2));
    await expect(rows.nth(2).locator('td').last()).toHaveText(result.record.applied.join(' → ') || 'none');
    await expect(page.getByRole('region', { name: 'Event trace', exact: true }).locator('li')).toHaveCount(result.trace.length);
    await finalGroups(page, result);
  }
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Transient timeout', exact: true })).toBeVisible();
  await expect(page.locator('.ifl-output')).toBeHidden();
});

test('J3 recordings stay lazy, replay locally and retain source preference', async ({ page }) => {
  const recordingRequests = [];
  page.on('request', request => { if (request.url().endsWith('/executed.js')) recordingRequests.push(request.url()); });
  await guided(page);
  await page.getByRole('button', { name: 'Executed: Java / Spring', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Replay real run', exact: true })).toBeVisible();
  expect(recordingRequests).toEqual([]);
  await page.getByRole('button', { name: 'Replay real run', exact: true }).click();
  await completed(page);
  expect(recordingRequests).toEqual(['http://127.0.0.1:4193/executed.js']);
  await expect(page.locator('.ifl-output > .ifl-note')).toContainText('Recorded from a real run');
  await expect(page.locator('.ifl-record tbody tr').nth(1).locator('td').last()).toHaveText('$120.00');
  await page.getByRole('button', { name: 'Simulated in browser', exact: true }).click();
  await expect(page.locator('.ifl-output')).toBeHidden();
});

test('J3 unavailable recording offers retry and a working simulation', async ({ page }) => {
  await page.route('**/executed.js', route => route.fulfill({ status: 503, body: 'Synthetic unavailable recording' }));
  await guided(page);
  await page.getByRole('button', { name: 'Executed: Java / Spring', exact: true }).click();
  await page.getByRole('button', { name: 'Replay real run', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Replay status' })).toContainText('Recorded replay unavailable');
  await page.getByRole('button', { name: 'Retry replay', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Replay status' })).toContainText('Recorded replay unavailable');
  await page.getByRole('button', { name: 'Simulated in browser', exact: true }).click();
  await page.getByRole('button', { name: 'Run scenario', exact: true }).click();
  await completed(page);
  await expect(page.locator('.ifl-record tbody tr').nth(1).locator('td').last()).toHaveText('$120.00');
});

test('J4 free-form duplicate, dedupe, timeout, validation and reload defaults', async ({ page }) => {
  await page.getByRole('button', { name: /^Free-form Pick/ }).click();
  const runButton = page.getByRole('button', { name: 'Run', exact: true });
  const paid = page.locator('.ifl-record tbody tr').nth(1).locator('td').last();
  await runButton.click(); await completed(page); await expect(paid).toHaveText('$120.00');
  await page.getByLabel('Ack lost for', { exact: true }).check();
  await runButton.click(); await expect(paid).toHaveText('$240.00');
  await page.getByLabel('Idempotent consumer (dedupe on eventId)', { exact: true }).check();
  await runButton.click(); await expect(paid).toHaveText('$120.00');
  await page.getByLabel('Ack lost for', { exact: true }).uncheck();
  await page.getByLabel('Downstream times out on', { exact: true }).check();
  await page.getByLabel('Which attempts time out', { exact: true }).selectOption('all');
  await runButton.click();
  await expect(page.getByRole('region', { name: 'Dead-letter queue', exact: true }).getByRole('heading')).toHaveText('Dead-letter queue (1)');
  await page.getByLabel('Downstream times out on', { exact: true }).uncheck();
  await page.getByLabel('Producer renames paidAmount on ClaimPaid', { exact: true }).check();
  await page.getByLabel('Validate the payload schema', { exact: true }).check();
  await runButton.click();
  await expect(page.getByRole('region', { name: 'Dead-letter queue', exact: true })).toContainText('ClaimPaid');
  await page.reload();
  await expect(page.locator('.ifl-form')).toBeVisible();
  await expect(page.getByLabel('Which attempts time out', { exact: true })).toHaveValue('first');
  await expect(page.getByLabel('Validate the payload schema', { exact: true })).not.toBeChecked();
  await expect(page.locator('.ifl-output')).toBeHidden();
});
