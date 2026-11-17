import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Build settings of the deployed site (Cloudflare Pages), as defaults: a variable set in the
 * Pages project settings or in the shell wins. Local `npm run dev` uses `.env.development`.
 */
const PRODUCTION_DEFAULTS: Record<string, string> = {
  VITE_API_URL: 'https://hci-backend.leon-grass.workers.dev',
  // Where answers come from unless the user picks in settings or the URL says ?provider=...
  // The plan's target is `arbor` (live Claude) as the default outside demo mode. It stays
  // `scripted` until the group has its own API key and a higher token cap, because with `arbor`
  // every visitor of the main site spends tokens (decided 17 Nov 2026).
  VITE_DEFAULT_PROVIDER: 'scripted',
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
