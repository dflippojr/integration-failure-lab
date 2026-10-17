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
  projects: [
    {
      name: 'desktop-light',
      testIgnore: '**/theme.spec.js',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, colorScheme: 'light' },
    },
    {
      name: 'phone-light',
      testMatch: ['**/journeys.spec.js', '**/phone-controls.spec.js'],
      use: { ...devices['Pixel 7'], viewport: { width: 412, height: 915 }, colorScheme: 'light' },
    },
    ...[
      { name: 'desktop-dark', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, colorScheme: 'dark' } },
      { name: 'phone-dark', use: { ...devices['Pixel 7'], viewport: { width: 412, height: 915 }, colorScheme: 'dark' } },
    ].map(project => ({ ...project, testMatch: '**/theme.spec.js' })),
    // Safari's engine, which most phone visitors to the embedding use: genuine iPhone contexts, every spec.
    ...['light', 'dark'].flatMap(colorScheme => [
      { name: 'iphone-se-' + colorScheme, use: { ...devices['iPhone SE'], colorScheme } },
      { name: 'iphone-15-' + colorScheme, use: { ...devices['iPhone 15'], colorScheme } },
    ]),
  ],
  webServer: {
    command: 'node checks/ui-instance.mjs serve',
    url: 'http://127.0.0.1:4193/__instance',
    reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
  },
});
