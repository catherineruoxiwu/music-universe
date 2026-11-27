import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative asset paths, so the built site works from any folder (GitHub Pages serves it from
  // /<repository>/, not from the domain root).
  base: './',
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
