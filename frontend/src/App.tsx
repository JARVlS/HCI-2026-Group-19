import { lazy, Suspense, type CSSProperties } from 'react';
import { StoreProvider, useStore } from './lib/store';
import type { Design } from './lib/types';

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

export default function App() {
  return (
    <StoreProvider>
      <DesignSwitch />
    </StoreProvider>
  );
}
