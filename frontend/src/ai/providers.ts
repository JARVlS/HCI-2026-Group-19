import type { ProviderChoice } from '../lib/types';
import { ArborProvider } from './arbor/provider';
import type { OwnProvider } from './own/provider';
import type { Provider } from './provider';
import { ScriptedProvider } from './scripted/provider';

/**
 * Which provider answers (IMPLEMENTATION_PLAN.md ADR-4, M3, M7): the scripted demo, Claude through
 * the backend, or the user's own model (`own`: model calls go from the browser to the user's
 * endpoints, chats are still saved on the backend). Picked in settings, or for one visit with
 * `?provider=arbor|own|scripted` (`?demo=1` forces the demo); the build sets the default with
 * VITE_DEFAULT_PROVIDER. The choice is also the mode (M2): scripted = the demo world, nothing
 * saved; arbor and own = the user's own chats, saved.
 */
export const PROVIDER_CHOICES = ['scripted', 'arbor', 'own'] as const satisfies readonly ProviderChoice[];

export const isProviderChoice = (v: unknown): v is ProviderChoice => PROVIDER_CHOICES.includes(v as ProviderChoice);

/** Live mode: the user's own chats, loaded from and saved to the backend. */
export const isLiveChoice = (c: ProviderChoice) => c !== 'scripted';

/** `?demo=1` beats everything; then the URL parameter, the saved setting, the build default. Unknown values count as unset. */
export function chooseProvider({ demo, url, saved, build }: { demo?: boolean; url?: unknown; saved?: unknown; build?: unknown }): ProviderChoice {
  if (demo) return 'scripted';
  return [url, saved, build].find(isProviderChoice) ?? 'scripted';
}

/** `own` is the app's one own-model provider: settings → model tests it and lists its models too. */
export function createProvider(choice: ProviderChoice, own: OwnProvider): Provider {
  if (choice === 'arbor') return new ArborProvider();
  if (choice === 'own') return own;
  return new ScriptedProvider();
}
