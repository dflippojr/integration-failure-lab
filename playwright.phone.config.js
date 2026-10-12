import { defineConfig, devices } from '@playwright/test';
import config from './playwright.config.js';

// The existing CI installs Chromium. This additional local acceptance matrix
// requires `npx playwright install chromium webkit` and keeps CI unchanged.
export default defineConfig({
  ...config,
  projects: [
    ...config.projects,
    ...['light', 'dark'].flatMap(colorScheme => [
      { name: 'iphone-se-' + colorScheme, use: { ...devices['iPhone SE'], colorScheme } },
      { name: 'iphone-15-' + colorScheme, use: { ...devices['iPhone 15'], colorScheme } },
    ]),
  ],
});
