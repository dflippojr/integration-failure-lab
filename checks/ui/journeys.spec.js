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
    const trace = page.getByRole('region', { name: 'Event trace', exact: true });
    await expect(trace.locator('li')).toHaveCount(result.trace.length);
    await expect(trace).toHaveAttribute('tabindex', '0');
    const parked = result.trace.filter(row => row.kind === 'dead-letter' || row.kind === 'drop').length;
    await expect(page.getByText(/^Parked \/ dropped events /)).toHaveText('Parked / dropped events ' + parked);
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
  const selects = page.getByRole('combobox');
  await expect(selects).toHaveCount(6);
  for (const name of ['Event that times out', 'Which attempts time out', 'Event whose ack is lost', 'Event to delay', 'Retries', 'Backoff']) {
    await expect(page.getByRole('combobox', { name, exact: true })).toHaveCount(1);
  }
  const runButton = page.getByRole('button', { name: 'Run', exact: true });
  const paid = page.locator('.ifl-record tbody tr').nth(1).locator('td').last();
  const compared = page.getByRole('region', { name: 'Compared with your previous run', exact: true });
  await runButton.click(); await completed(page); await expect(paid).toHaveText('$120.00');
  await expect(compared).toHaveCount(0);
  await page.getByLabel('Ack lost for', { exact: true }).check();
  await runButton.click(); await expect(paid).toHaveText('$240.00');
  await expect(compared.getByRole('listitem')).toHaveText(['Ack lost for: off → ClaimPaid']);
  await page.getByLabel('Idempotent consumer (dedupe on eventId)', { exact: true }).check();
  await runButton.click(); await expect(paid).toHaveText('$120.00');
  await expect(compared.getByRole('listitem')).toHaveText(['Idempotent consumer (dedupe on eventId): off → on']);
  await expect(compared.getByRole('columnheader')).toHaveText(['Claim C-1001', 'Previous', 'This run']);
  const duplicate = { failures: { duplicate: { event: 'ClaimPaid' } } };
  const before = run(duplicate), after = run(duplicate, { idempotency: true });
  const comparisonRows = compared.locator('tbody tr');
  await expect(comparisonRows).toHaveCount(4);
  for (const [index, cells] of [
    ['Verdict', before.verdict.summary, after.verdict.summary],
    ['Status', 'Paid', 'Paid'],
    ['Paid', '$240.00', '$120.00'],
    ['Events applied', 'E1 → E2 → E3 → E3', 'E1 → E2 → E3'],
  ].entries()) {
    await expect(comparisonRows.nth(index).locator('th, td')).toHaveText(cells);
  }
  await runButton.click(); await completed(page);
  await expect(compared).toContainText('Same settings as your previous run.');
  await expect(comparisonRows).toHaveCount(4);
  for (const row of await comparisonRows.all()) {
    const cells = row.getByRole('cell');
    await expect(cells.nth(1)).toHaveText(await cells.nth(0).innerText());
  }
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

test('J6 guided scenario opens pre-filled in free-form, reruns with a safeguard, and the mode switch restores defaults', async ({ page }) => {
  await guided(page);
  await page.getByRole('button', { name: /^6a:/ }).click();
  await expect(page.getByRole('button', { name: 'Try this in Free-form', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: /^2a:/ }).click();
  await page.getByRole('button', { name: 'Try this in Free-form', exact: true }).click();
  await expect(page.locator('.ifl-form')).toBeVisible();
  await expect(page.getByLabel('Downstream times out on', { exact: true })).toBeFocused();
  await expect(page.locator('.ifl-output')).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('ifl-mode'))).toBe('free');
  await expect(page.getByLabel('Ack lost for', { exact: true })).toBeChecked();
  await expect(page.getByLabel('Event whose ack is lost', { exact: true })).toHaveValue('ClaimPaid');
  await expect(page.getByLabel('Idempotent consumer (dedupe on eventId)', { exact: true })).not.toBeChecked();
  const paid = page.locator('.ifl-record tbody tr').nth(1).locator('td').last();
  const runButton = page.getByRole('button', { name: 'Run', exact: true });
  await runButton.click(); await completed(page); await expect(paid).toHaveText('$240.00');
  await page.getByLabel('Idempotent consumer (dedupe on eventId)', { exact: true }).check();
  await runButton.click(); await expect(paid).toHaveText('$120.00');
  await page.getByRole('button', { name: 'Switch to guided', exact: true }).click();
  await page.getByRole('button', { name: 'Switch to free-form', exact: true }).click();
  await expect(page.getByLabel('Ack lost for', { exact: true })).not.toBeChecked();
  await expect(page.getByLabel('Idempotent consumer (dedupe on eventId)', { exact: true })).not.toBeChecked();
  await expect(page.getByLabel('Dead-letter queue', { exact: true })).toBeChecked();
  await expect(page.locator('select[name=retryLimit]')).toHaveValue('3');
  await expect(page.locator('select[name=backoff]')).toHaveValue('exponential');
});
