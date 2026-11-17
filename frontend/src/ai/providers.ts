import type { ProviderChoice } from '../lib/types';
import { ArborProvider } from './arbor/provider';
import type { Provider } from './provider';
import { ScriptedProvider } from './scripted/provider';

/**
 * Which provider answers (IMPLEMENTATION_PLAN.md ADR-4, M3): the scripted demo or Claude through the
 * backend. Picked in settings, or for one visit with `?provider=arbor|scripted` (`?demo=1` forces
 * the demo); the build sets the default with VITE_DEFAULT_PROVIDER. The choice is also the mode
 * (M2): scripted = the demo world, nothing saved; arbor = the user's own chats, saved.
 */
export const PROVIDER_CHOICES = ['scripted', 'arbor'] as const satisfies readonly ProviderChoice[];

export const isProviderChoice = (v: unknown): v is ProviderChoice => PROVIDER_CHOICES.includes(v as ProviderChoice);

/** `?demo=1` beats everything; then the URL parameter, the saved setting, the build default. Unknown values count as unset. */
export function chooseProvider({ demo, url, saved, build }: { demo?: boolean; url?: unknown; saved?: unknown; build?: unknown }): ProviderChoice {
  if (demo) return 'scripted';
  return [url, saved, build].find(isProviderChoice) ?? 'scripted';
}

export function createProvider(choice: ProviderChoice): Provider {
  return choice === 'arbor' ? new ArborProvider() : new ScriptedProvider();
}
