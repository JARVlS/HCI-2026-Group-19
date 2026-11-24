import { useCallback, useMemo } from 'react';
import { CHATS_WEDGE, INNER_R, OUTER_R, polar, ringAngle, WEDGES, type Effect } from '../../lib/altGesture';
import { CHAT, routeOf, type NavVia, type ViewKind } from '../../lib/nav';
import { useStore } from '../../lib/store';
import { lower, useUi } from './ui';
import { useAltGesture } from './useAltGesture';

/**
 * The radial menu (interaction concept #11, a marking menu; IMPLEMENTATION_PLAN.md ADR-13): hold
 * alt/option, move toward a direction, let go. Eight wedges whose positions never move, so the
 * hand learns them; selection is by direction, not distance, so every target is large (Fitts).
 * One nested ring: resting on "chats" fans out the five most recent other chats.
 */

type WedgeId = 'chat' | 'chats' | 'tree' | 'forest' | 'study' | 'concepts' | 'settings' | 'new';

interface Wedge {
  id: WedgeId;
  label: string;
  arrow: string;
  /** Not built yet: shown dim so its place is learned, and says so when chosen. */
  soon?: string;
}

/** Clockwise from up (wedge 0). Fixed: no wedge appears, moves or hides with the context. */
export const WEDGE_LIST: readonly Wedge[] = [
  { id: 'chat', label: 'chat', arrow: '↑' },
  { id: 'chats', label: 'chats', arrow: '↗' },
  { id: 'tree', label: 'tree', arrow: '→' },
  { id: 'forest', label: 'forest', arrow: '↘' },
  { id: 'study', label: 'study', arrow: '↓', soon: 'study mode comes with the mastery milestone (M5)' },
  { id: 'concepts', label: 'concepts', arrow: '↙' },
  { id: 'settings', label: 'settings', arrow: '←' },
  { id: 'new', label: 'new chat', arrow: '↖' },
];

/** The wedge that marks where you are now. */
const HERE: Partial<Record<ViewKind, WedgeId>> = { chat: 'chat', chats: 'chats', forest: 'forest', concepts: 'concepts', settings: 'settings' };

const RING_MAX = 5;

export function Radial() {
  const { state, dispatch, navigate, newChat, chats, toast, track } = useStore();
  const { focusPrompt } = useUi();
  const activeId = state.session.activeConversationId;
  const ring = useMemo(
    () =>
      chats
        .flatMap((g) => g.items)
        .filter((c) => !c.active)
        .slice(0, RING_MAX),
    [chats],
  );
  const from = routeOf(state.ui.view, activeId).kind;

  const go = useCallback(
    (wedge: number, sub: number | null, via: NavVia, ms: number) => {
      const w = WEDGE_LIST[wedge];
      const nav = { via, ms };
      switch (w.id) {
        case 'chat':
          navigate(CHAT, nav);
          focusPrompt();
          break;
        case 'chats':
          if (sub !== null && ring[sub]) navigate({ kind: 'chat', conversationId: ring[sub].id }, nav);
          else navigate({ kind: 'chats' }, nav);
          break;
        case 'tree':
          navigate(CHAT, nav);
          if (!state.ui.panelOpen) dispatch({ type: 'panel', open: true });
          // The pane renders on the next frame when it was closed.
          requestAnimationFrame(() => (document.querySelector('.a-pane .at-grid') as HTMLElement | null)?.focus());
          break;
        case 'forest':
          navigate({ kind: 'forest' }, nav);
          break;
        case 'concepts':
          navigate({ kind: 'concepts' }, nav);
          break;
        case 'settings':
          navigate({ kind: 'settings' }, nav);
          if (!state.ui.panelOpen) dispatch({ type: 'panel', open: true });
          break;
        case 'new':
          track({ type: 'nav', payload: { from, to: 'chat', via, ms } });
          newChat();
          focusPrompt();
          break;
        case 'study':
          track({ type: 'nav', payload: { from, to: from, via, ms } });
          toast(w.soon ?? '');
          break;
      }
    },
    [navigate, focusPrompt, ring, state.ui.panelOpen, dispatch, newChat, track, toast, from],
  );

  const effect = useCallback(
    (e: Effect) => {
      if (e.type === 'select') go(e.wedge, e.sub, e.via, Math.round(e.ms));
      else if (e.type === 'open') track({ type: 'radial_open', payload: { input: e.input, on: from } });
      else if (e.type === 'cancel' && e.drawn) track({ type: 'radial_cancel', payload: { reason: e.reason, ms: Math.round(e.ms) } });
    },
    [go, track, from],
  );

  const shown = useAltGesture({ effect, ringSize: () => ring.length, enabled: state.settings.design === 'ascii' });
  if (!shown) return null;

  const { center, wedge, sub } = shown;
  const here = HERE[from];
  const active = wedge === null ? null : WEDGE_LIST[wedge];
  const announce = active ? (sub !== null && ring[sub] ? `chat: ${lower(ring[sub].title)}` : active.soon ? `${active.label}, not built yet` : active.label) : 'nothing: let go to cancel';
  return (
    <div className={`a-radial${shown.input === 'touch' ? ' is-touch' : ''}`} role="menu" aria-label="go to">
      <div className="a-radial-disc" style={{ left: center.x, top: center.y, width: (INNER_R + 46) * 2, height: (INNER_R + 46) * 2 }} aria-hidden="true" />
      <div className={`a-radial-hub${wedge === null ? ' on' : ''}`} style={{ left: center.x, top: center.y }} aria-hidden="true">
        {wedge === null ? '×' : WEDGE_LIST[wedge].arrow}
      </div>
      {WEDGE_LIST.map((w, i) => {
        const p = polar(center, (i * 360) / WEDGES, INNER_R);
        const cls = ['a-radial-item', wedge === i && sub === null ? 'on' : '', here === w.id ? 'here' : '', w.soon ? 'soon' : '', wedge === i && sub !== null ? 'via' : ''].filter(Boolean).join(' ');
        return (
          <div key={w.id} role="menuitem" aria-disabled={w.soon ? true : undefined} aria-current={here === w.id ? 'page' : undefined} className={cls} style={{ left: p.x, top: p.y }}>
            <span className="a-radial-key" aria-hidden="true">
              {i + 1}
            </span>
            {w.label}
            {here === w.id && <span className="a-radial-here"> ·here</span>}
          </div>
        );
      })}
      {shown.ring &&
        ring.map((c, i) => {
          const p = polar(center, ringAngle(i, ring.length), OUTER_R);
          return (
            <div key={c.id} role="menuitem" className={`a-radial-item a-radial-chat${sub === i ? ' on' : ''}`} style={{ left: p.x, top: p.y }}>
              {lower(c.title)}
            </div>
          );
        })}
      <span className="a-sr" aria-live="assertive">
        {announce}
      </span>
      <p className="a-radial-hint" style={{ left: center.x, top: center.y + INNER_R + 70 }} aria-hidden="true">
        {shown.input === 'touch' ? 'tap a direction · tap away to close' : 'let go of alt to go · esc cancels'}
        {wedge === CHATS_WEDGE && !shown.ring && ring.length ? ' · rest here for recent chats' : ''}
      </p>
    </div>
  );
}
