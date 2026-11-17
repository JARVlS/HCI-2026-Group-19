import { defineConfig } from 'vitest/config';

/** Evals call the live backend, so they are not part of `npm test`: `npm run eval:score`. They print their table. */
export default defineConfig({
  test: { include: ['eval/**/*.eval.ts'], testTimeout: 300_000, silent: false, reporters: ['verbose'] },
});
