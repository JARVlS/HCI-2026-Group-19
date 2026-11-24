import { useCallback, useMemo } from 'react';
import { CHATS_WEDGE, DEAD_ZONE, OUTER_R, polar, ringAngle, SLICE_R, WEDGES, type Effect } from '../../lib/altGesture';
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

/* ───────────── The pie: eight slices of an annulus, the hub is the dead zone ───────────── */

const STEP = 360 / WEDGES;
/** Where a slice's label sits: the middle of its ring. */
const LABEL_R = (DEAD_ZONE + SLICE_R) / 2 + 4;
const pt = (deg: number, r: number) => polar({ x: 0, y: 0 }, deg, r);
const f = (n: number) => n.toFixed(2);

/** The outline of slice `i` (centred on `i * 45°`, 0 = up, clockwise), between the hub and SLICE_R. */
function slicePath(i: number): string {
  const a0 = i * STEP - STEP / 2;
  const a1 = i * STEP + STEP / 2;
  const [o0, o1, i1, i0] = [pt(a0, SLICE_R), pt(a1, SLICE_R), pt(a1, DEAD_ZONE), pt(a0, DEAD_ZONE)];
  return `M${f(o0.x)} ${f(o0.y)} A${SLICE_R} ${SLICE_R} 0 0 1 ${f(o1.x)} ${f(o1.y)} L${f(i1.x)} ${f(i1.y)} A${DEAD_ZONE} ${DEAD_ZONE} 0 0 0 ${f(i0.x)} ${f(i0.y)} Z`;
}
const SLICES = Array.from({ length: WEDGES }, (_, i) => slicePath(i));

/**
 * How wide a label may be so it stays inside its slice: up and down slices are narrow (the
 * chord at the label's radius, so longer labels wrap), left and right ones are as wide as the
 * ring is deep, the diagonals in between.
 */
const LABEL_W = Array.from({ length: WEDGES }, (_, i) => {
  const chord = 2 * LABEL_R * Math.sin(((STEP / 2) * Math.PI) / 180) - 10;
  const depth = SLICE_R - DEAD_ZONE - 22;
  const along = Math.abs(Math.sin((i * STEP * Math.PI) / 180)); // 0 up/down, 1 left/right
  return Math.round(chord + (depth - chord) * along * along);
});

function sliceClass(w: Wedge, i: number, wedge: number | null, sub: number | null, here: WedgeId | undefined): string {
  return [
    'a-radial-slice',
    wedge === i && sub === null ? 'on' : '',
    wedge === i && sub !== null ? 'via' : '',
    here === w.id ? 'here' : '',
    w.soon ? 'soon' : '',
  ]
    .filter(Boolean)
    .join(' ');
}

export function Radial() {
  const { state, dispatch, navigate, newChat, chats, toast, track } = useStore();
  const { focusPrompt, restOn } = useUi();
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
      // How long each option was pointed at (`hover` radial): a chat on the ring is `chats:<n>`.
      if (e.type === 'hover') restOn('radial', e.wedge === null ? null : e.sub !== null ? `${WEDGE_LIST[e.wedge].id}:${e.sub}` : WEDGE_LIST[e.wedge].id);
      else if (e.type !== 'open') restOn('radial', null);
      if (e.type === 'select') go(e.wedge, e.sub, e.via, Math.round(e.ms));
      else if (e.type === 'open') track({ type: 'radial_open', payload: { input: e.input, on: from } });
      else if (e.type === 'cancel' && e.drawn) track({ type: 'radial_cancel', payload: { reason: e.reason, ms: Math.round(e.ms) } });
    },
    [go, track, from, restOn],
  );

  const shown = useAltGesture({ effect, ringSize: () => ring.length, enabled: state.settings.design === 'ascii' });
  if (!shown) return null;

  const { center, wedge, sub } = shown;
  const here = HERE[from];
  const active = wedge === null ? null : WEDGE_LIST[wedge];
  const announce = active ? (sub !== null && ring[sub] ? `chat: ${lower(ring[sub].title)}` : active.soon ? `${active.label}, not built yet` : active.label) : 'nothing: let go to cancel';
  const size = (OUTER_R + 40) * 2;
  return (
    <div className={`a-radial${shown.input === 'touch' ? ' is-touch' : ''}`} role="menu" aria-label="go to">
      <svg className="a-radial-pie" style={{ left: center.x, top: center.y, width: size, height: size }} viewBox={`${-size / 2} ${-size / 2} ${size} ${size}`} aria-hidden="true">
        {WEDGE_LIST.map((w, i) => (
          <path key={w.id} d={SLICES[i]} className={sliceClass(w, i, wedge, sub, here)} />
        ))}
        <circle className={`a-radial-hub${wedge === null ? ' on' : ''}`} r={DEAD_ZONE} />
        <text className="a-radial-hub-mark" dominantBaseline="central" textAnchor="middle">
          {wedge === null ? '×' : WEDGE_LIST[wedge].arrow}
        </text>
      </svg>
      {WEDGE_LIST.map((w, i) => {
        const p = polar(center, (i * 360) / WEDGES, LABEL_R);
        return (
          <div
            key={w.id}
            role="menuitem"
            aria-disabled={w.soon ? true : undefined}
            aria-current={here === w.id ? 'page' : undefined}
            className={`a-radial-label ${sliceClass(w, i, wedge, sub, here)}`}
            style={{ left: p.x, top: p.y, width: LABEL_W[i] }}
          >
            <span className="a-radial-key" aria-hidden="true">
              {i + 1}
            </span>{' '}
            {w.label}
            {here === w.id && <span className="a-radial-here"> ·here</span>}
          </div>
        );
      })}
      {shown.ring &&
        ring.map((c, i) => {
          const p = polar(center, ringAngle(i, ring.length), OUTER_R);
          return (
            <div key={c.id} role="menuitem" className={`a-radial-chat${sub === i ? ' on' : ''}`} style={{ left: p.x, top: p.y }}>
              {lower(c.title)}
            </div>
          );
        })}
      <span className="a-sr" aria-live="assertive">
        {announce}
      </span>
      <p className="a-radial-hint" style={{ left: center.x, top: center.y + SLICE_R + 20 }} aria-hidden="true">
        {shown.input === 'touch' ? 'tap a slice · tap away to close' : 'let go of alt to go · centre or esc cancels'}
        {wedge === CHATS_WEDGE && !shown.ring && ring.length ? ' · rest here for recent chats' : ''}
      </p>
    </div>
  );
}
