/** Build-time variables (`.env.development`, the production defaults in `vite.config.ts`, or the Pages project settings). */
interface ImportMetaEnv {
  /** Base URL of the backend Worker, e.g. https://hci-backend.leon-grass.workers.dev */
  readonly VITE_API_URL?: string;
  /** `scripted` or `arbor`: where answers come from unless the user picked or the URL says otherwise. */
  readonly VITE_DEFAULT_PROVIDER?: string;
}
