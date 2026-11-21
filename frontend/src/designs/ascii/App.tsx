import { useEffect, useState } from 'react';
import { mean } from '../../lib/modes';
import { thinkingShare } from '../../lib/scores';
import { TIME_MAX, TIME_TICKS } from '../../lib/retention';
import { useStore } from '../../lib/store';
import { ChatList, LeafRefs } from './Chats';
import { Composer } from './Composer';
import { Concepts } from './Concepts';
import { Forest } from './Forest';
import { Links } from './Links';
import { ModelSheet } from './Model';
import { Modeline } from './Modeline';
import { Pane } from './Pane';
import { Transcript } from './Transcript';
import { G, UiProvider, typing, useUi } from './ui';
import './ascii.css';

/**
 * The ASCII design: everything on one character grid, in one monospace voice.
 * Interaction concepts are listed in Concepts.tsx (press ? in the app).
 */
export default function AsciiApp() {
  return (
    <UiProvider>
      <Shell />
    </UiProvider>
  );
}

function Shell() {
  const { state, dispatch, busy, stop, track } = useStore();
  const ui = useUi();
  const { theme } = state.settings;

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') delete root.dataset.theme;
    else root.dataset.theme = theme;
  }, [theme]);

  // Global keys (when no text field has focus). Overlays handle their own keys first. Each one used is logged.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      const stops = TIME_TICKS.map((t) => t.days);
      const key = e.key;
      if (key === '/') ui.fill('/');
      else if (key === 'i') ui.focusPrompt();
      else if (key === '?') ui.setSheet(ui.sheet ? null : 'concepts');
      else if (key === 't' && !state.ui.forest.open) ui.setView(ui.view === 'tree' ? 'outline' : 'tree', 'key');
      else if (key === 'f') dispatch({ type: 'forest', open: !state.ui.forest.open });
      else if (key === 'c' && !state.ui.forest.open) dispatch({ type: 'chats', open: true });
      else if (key === ']') ui.setDays(stops.find((d) => d > ui.days) ?? TIME_MAX);
      else if (key === '[') ui.setDays([...stops].reverse().find((d) => d < ui.days) ?? 0);
      else if (key === 'Escape') {
        if (busy) stop();
        ui.setWhy(null);
        dispatch({ type: 'highlight', ids: [] });
      } else return;
      track({ type: 'shortcut', payload: { key, where: 'chat' } });
      if (key !== 'Escape') e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ui, state.ui.forest.open, dispatch, busy, stop, track]);

  return (
    <div className="ascii">
      <TopLine />
      <div className="a-main">
        <main className="a-chat" aria-label="Conversation">
          <Transcript />
          <Composer />
        </main>
        {state.ui.panelOpen && <Pane />}
        {state.ui.forest.open && <Forest />}
      </div>
      <Modeline />
      <Links />
      <Concepts />
      <ModelSheet />
      <ChatList />
      <LeafRefs />
      <Toast />
    </div>
  );
}

/** A browser reduced to one line, so the overlay still reads as an extension on someone else's chat. */
function TopLine() {
  const { state, dispatch, toast, messages } = useStore();
  const turns = messages.filter((m) => m.role === 'user' && m.classification);
  const score = turns.length ? mean(turns.map(thinkingShare)) : 0.5;
  return (
    <header className="a-top">
      <span className="a-top-nav a-dim" aria-hidden="true">
        ‹ › ↻
      </span>
      <span className="a-url">
        <span className="a-dim">https://</span>chat.example.com<span className="a-dim">/c/neural-networks</span>
      </span>
      <span className="a-top-ext">
        <button
          className={`a-ext${state.ui.panelOpen ? ' on' : ''}`}
          aria-pressed={state.ui.panelOpen}
          title="arbor"
          onClick={() => dispatch({ type: 'panel', open: !state.ui.panelOpen })}
        >
          {state.settings.enabled ? <G score={score} /> : <span aria-hidden="true">z</span>} arbor
        </button>
        <button className="a-ext a-dim" onClick={() => toast('prototype: browser extensions menu')} aria-label="Extensions">
          ⋯
        </button>
      </span>
    </header>
  );
}

function Toast() {
  const { state } = useStore();
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!state.ui.toast) return;
    setVisible(true);
    const t = setTimeout(() => setVisible(false), 3200);
    return () => clearTimeout(t);
  }, [state.ui.toast]);
  return (
    <div className={`a-toast${visible ? ' show' : ''}`} role="status" aria-live="polite">
      <span className="a-dim">arbor › </span>
      {state.ui.toast?.text}
    </div>
  );
}
