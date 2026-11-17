import { lazy, Suspense, useMemo, useState, type CSSProperties } from 'react';
import { chooseProvider, isLiveChoice } from './ai/providers';
import { logOut, readAccount, type Account } from './lib/account';
import { PROVIDER_KEY, SETTINGS_KEY } from './lib/app';
import { StoreProvider, useStore } from './lib/store';
import type { Design } from './lib/types';
import { AccountContext, Welcome, type AccountControls, type WelcomeMode } from './Welcome';

/**
 * Arbor comes in several design styles that share one store (conversation, classifier,
 * scripted assistant). Each design is its own UI under src/designs/ and loads lazily,
 * so only its own CSS is on the page. Switch with ?design=ascii|classic or in settings;
 * the conversation carries over, which makes side-by-side comparisons in user tests easy.
 */
const DESIGNS: Record<Design, React.LazyExoticComponent<() => React.JSX.Element>> = {
  ascii: lazy(() => import('./designs/ascii/App')),
  classic: lazy(() => import('./designs/classic/App')),
};

function DesignSwitch() {
  const { state } = useStore();
  const Design = DESIGNS[state.settings.design] ?? DESIGNS.ascii;
  if (state.session.boot !== 'ready') return <Boot />;
  return (
    <Suspense fallback={null}>
      <Design />
    </Suspense>
  );
}

const BOOT: CSSProperties = {
  position: 'fixed',
  inset: 0,
  display: 'grid',
  placeContent: 'center',
  gap: 8,
  padding: 24,
  font: '13px/20px ui-monospace, SFMono-Regular, Menlo, monospace',
  background: 'Canvas',
  color: 'CanvasText',
};
const DIM: CSSProperties = { margin: 0, opacity: 0.7 };

/**
 * Live mode, before the user's chats are in: a plain loading line, or what went wrong with a
 * retry. Never the demo instead: that would look like the user's data.
 */
function Boot() {
  const { state, sync, retryLoad } = useStore();
  const { boot } = state.session;
  const { theme } = state.settings;
  const style = { ...BOOT, colorScheme: theme === 'system' ? 'light dark' : theme };
  if (boot === 'loading') {
    return (
      <div style={style} role="status" aria-live="polite">
        <p style={{ margin: 0 }}>arbor · loading your chats…</p>
      </div>
    );
  }
  return (
    <div style={style} role="alert">
      <p style={{ margin: 0 }}>arbor · could not load your chats</p>
      <p style={DIM}>{typeof boot === 'object' ? boot.error : ''}</p>
      {sync.pending > 0 && (
        <p style={DIM}>
          {sync.pending} unsaved change{sync.pending === 1 ? ' is' : 's are'} kept on this device and sent once the backend answers.
        </p>
      )}
      <p style={{ margin: '8px 0 0' }}>
        <button onClick={retryLoad} style={{ font: 'inherit' }}>
          retry
        </button>{' '}
        <span style={{ opacity: 0.7 }}>
          or try the <a href="?demo=1">offline demo</a> (nothing saved)
        </span>
      </p>
    </div>
  );
}

function storage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function params() {
  try {
    return new URLSearchParams(window.location.search);
  } catch {
    return new URLSearchParams();
  }
}

const read = (key: string) => {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
};

/** Live mode on this visit, decided as the store will decide it (lib/app.ts `initialState`). */
function startsLive(p: URLSearchParams) {
  return isLiveChoice(chooseProvider({ demo: p.get('demo') === '1', url: p.get('provider'), saved: read(PROVIDER_KEY), build: import.meta.env.VITE_DEFAULT_PROVIDER }));
}

/** The theme before the store exists: `?theme=`, else the saved setting, else the system's. */
function earlyTheme(p: URLSearchParams) {
  const t = p.get('theme');
  if (t === 'light' || t === 'dark' || t === 'system') return t;
  try {
    return JSON.parse(read(SETTINGS_KEY) ?? '{}').theme ?? 'system';
  } catch {
    return 'system';
  }
}

/**
 * The app, with the welcome screen in front on a first visit in live mode (ADR-8 amended): log in,
 * sign up, or continue as guest. Nothing loads before that choice, so logging in never leaves an
 * empty guest behind. `?welcome=1` shows it again (demos, user tests).
 */
export default function App() {
  const p = useMemo(params, []);
  const [account, setAccount] = useState<Account | null>(() => readAccount(storage()));
  const [screen, setScreen] = useState<WelcomeMode | null>(() =>
    startsLive(p) && (p.get('welcome') === '1' || !readAccount(storage())) ? 'start' : null,
  );
  const theme = earlyTheme(p);

  const done = (a: Account, switched: boolean) => {
    // Another user's token: reload, so the store loads that user's chats from scratch.
    if (switched && screen !== 'start') return window.location.reload();
    setAccount(a);
    setScreen(null);
  };

  const controls = useMemo<AccountControls>(
    () => ({
      account,
      open: (mode) => setScreen(mode),
      logOut() {
        logOut(storage());
        window.location.reload();
      },
    }),
    [account],
  );

  if (screen === 'start') return <Welcome mode="start" storage={storage()} theme={theme} onDone={done} />;
  return (
    <AccountContext.Provider value={controls}>
      <StoreProvider>
        <DesignSwitch />
      </StoreProvider>
      {screen && <Welcome mode={screen} storage={storage()} theme={theme} onDone={done} onCancel={() => setScreen(null)} />}
    </AccountContext.Provider>
  );
}
