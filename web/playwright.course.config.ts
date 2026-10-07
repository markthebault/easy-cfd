import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// Course browser tests do not solve CFD: they use the retained real run evidence.
// Linux CI needs software WebGL for the app's geometry viewer, not a WebGPU adapter.
export default defineConfig({
  ...base,
  testMatch: ['course.spec.ts', 'edition.spec.ts'],
  use: {
    ...base.use,
    launchOptions: process.platform === 'darwin' ? base.use?.launchOptions : { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
  },
});
