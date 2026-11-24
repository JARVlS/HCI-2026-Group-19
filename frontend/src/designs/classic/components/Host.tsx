import { ChevronLeft, ChevronRight, Lock, Puzzle, RotateCw, SquarePen, UserRound } from 'lucide-react';
import { layoutTree } from '../../../lib/layout';
import { pct } from '../../../lib/modes';
import { useStore } from '../../../lib/store';
import { ArborLogo, Glyph } from './Glyph';

/** A minimal stand-in for the browser, so the overlay clearly reads as an extension. */
export function BrowserChrome() {
  const { state, dispatch, toast } = useStore();
  const { settings } = state;
  const { panelOpen } = state.ui;
  return (
    <div className="chrome">
      <div className="lights" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
      <div className="chrome-nav" aria-hidden="true">
        <ChevronLeft size={16} />
        <ChevronRight size={16} />
        <RotateCw size={14} />
      </div>
      <div className="url">
        <Lock size={11} aria-hidden="true" />
        <span>chat.example.com/c/neural-networks</span>
      </div>
      <div className="chrome-ext">
        <button
          className={`ext-btn ${panelOpen ? 'on' : ''}`}
          onClick={() => dispatch({ type: 'panel', open: !panelOpen })}
          aria-pressed={panelOpen}
          aria-label={panelOpen ? 'Hide Arbor panel' : 'Show Arbor panel'}
          title="Arbor"
        >
          <ArborLogo size={18} />
          {!settings.enabled && <span className="ext-paused" aria-hidden="true" />}
        </button>
        <button className="ext-btn" aria-label="Extensions" onClick={() => toast('Prototype: browser extensions menu')}>
          <Puzzle size={16} />
        </button>
      </div>
    </div>
  );
}

/** The host chat app's own sidebar. Arbor adds one small glyph per chat. */
export function HostSidebar() {
  const { state, navigate, toast, chats, forestTrees, mode, openChat, newChat } = useStore();
  const enabled = state.settings.enabled;
  const scoreOf = (treeId: string | null) => {
    const t = treeId ? forestTrees.find((x) => x.id === treeId) : undefined;
    return t ? layoutTree(t).score : 0;
  };

  const open = (id: string, treeId: string | null) => {
    if (chats.some((g) => g.items.some((c) => c.id === id && c.active))) return;
    // Live chats (and demo chats with a transcript) open; the demo's past chats are only their trees.
    if (mode === 'live' || state.domain.messagesByConv[id]) return openChat(id);
    if (!enabled || !treeId) return toast('Prototype: only the current chat is live.');
    navigate({ kind: 'forest', treeId }, { via: 'click' });
    toast('Prototype: past demo chats open in your Arbor forest.');
  };

  return (
    <aside className="host-sidebar" aria-label="Chat history">
      <div className="host-brand">
        <span className="host-logo" aria-hidden="true" />
        Chat
      </div>
      <button className="host-new" onClick={newChat}>
        <SquarePen size={15} /> New chat
      </button>
      <nav className="host-history">
        {chats.map((g) => (
          <div key={g.label}>
            <p className="host-group">{g.label}</p>
            {g.items.map((c) => {
              const score = scoreOf(c.treeId);
              return (
                <button
                  key={c.id}
                  className={`host-item ${c.active ? 'active' : ''}`}
                  onClick={() => open(c.id, c.treeId)}
                  aria-current={c.active ? 'page' : undefined}
                >
                  <span className="host-item-title">{c.title}</span>
                  {enabled && (
                    <span className="host-glyph" title={`Arbor: ${pct(score)}% your thinking`}>
                      <Glyph score={score} size={11} />
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </nav>
      <div className="host-user">
        <span className="host-avatar" aria-hidden="true">
          <UserRound size={15} />
        </span>
        Student account
      </div>
    </aside>
  );
}
