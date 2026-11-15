import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['tests/{unit,component,a11y,build}/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    setupFiles: ['tests/setup/dom.ts'],
    globalSetup: ['tests/setup/build.ts'],
    css: false,
    restoreMocks: true,
    testTimeout: 20_000,
  },
});
