import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './checks/ui',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:4193',
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: ['light', 'dark'].flatMap(colorScheme => [
    { name: 'desktop-' + colorScheme, use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, colorScheme } },
    { name: 'phone-' + colorScheme, use: { ...devices['Pixel 7'], colorScheme } },
  ]),
  webServer: {
    command: 'node checks/ui-instance.mjs serve',
    url: 'http://127.0.0.1:4193/__instance',
    reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
  },
});
