import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Build settings of the deployed site (Cloudflare Pages), as defaults: a variable set in the
 * Pages project settings or in the shell wins. Local `npm run dev` uses `.env.development`.
 */
const PRODUCTION_DEFAULTS: Record<string, string> = {
  VITE_API_URL: 'https://hci-backend.leon-grass.workers.dev',
  // Where answers come from unless the user picks in settings or the URL says ?provider=...
  // `arbor` (live Claude through the backend) since 17 Nov 2026 (ADR-4, M8): a new visitor gets a
  // real tutor and an empty chat, not the scripted demo (`?demo=1` still shows that). Every visitor
  // spends tokens from the backend's budget (TOTAL_TOKEN_BUDGET in backend/wrangler.toml); when it
  // is used up, answers fail with a clear "budget" message and the demo keeps working.
  VITE_DEFAULT_PROVIDER: 'arbor',
};

export default defineConfig(({ mode }) => {
  const set = loadEnv(mode, '.', 'VITE_');
  const missing = mode === 'production' ? Object.entries(PRODUCTION_DEFAULTS).filter(([name]) => !(name in set)) : [];
  return {
    plugins: [react()],
    base: './',
    define: Object.fromEntries(missing.map(([name, value]) => [`import.meta.env.${name}`, JSON.stringify(value)])),
  };
});
