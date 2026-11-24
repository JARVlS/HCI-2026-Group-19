import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { HoverName, PaneKind, TreeView, ViewVia } from '../../lib/events';
import { HoverClock } from '../../lib/hoverLog';
import { MODE_SCORE } from '../../lib/modes';
import { sheetOf, type NavVia, type Sheet } from '../../lib/nav';
import { useStore } from '../../lib/store';
import type { Mode } from '../../lib/types';

/* ───────────── UI state that only this design needs ─────────────
 * The conversation, settings, highlight and forest focus live in the shared store;
 * the rest (time scrubber, tree view, link source) is local to the ASCII design. Sheets are views
 * (`nav.ts`): `sheet` is read from the store's view, `setSheet` navigates.
 */

export type { Sheet } from '../../lib/nav';
/** What the pointer is on, so the link overlay knows where to draw from. */
export type LinkSource = { kind: 'message'; id: string } | { kind: 'leaf'; id: string; messageId?: string } | null;

interface Ui {
  /** Forgetting scrubber: days from now (0 = now). */
  days: number;
  setDays: (d: number) => void;
  view: TreeView;
  /** `via`: how the user switched, for the usage log. */
  setView: (v: TreeView, via: ViewVia) => void;
  sheet: Sheet;
  /** Open a sheet (a view, so back closes it), or close it with null. */
  setSheet: (s: Sheet, via?: NavVia) => void;
  /** User message whose "why this label" is open. */
  why: string | null;
  setWhy: (id: string | null) => void;
  link: LinkSource;
  setLink: (l: LinkSource) => void;
  /** Leaf whose messages are listed to pick from (leaf → message, in any chat). */
  refs: string | null;
  setRefs: (leafId: string | null) => void;
  /** Put text in the composer and focus it. */
  fill: (text: string) => void;
  focusPrompt: () => void;
  /** Usage log: something the user did with a leaf in the pane or the forest. */
  paneAction: (kind: PaneKind, conceptId: string) => void;
  /** The pointer is on this leaf (null: on none); resting there REST_MS is logged once. */
  rest: (leafId: string | null) => void;
  /**
   * Usage log: the pointer is on `key` (null: on none of this slot's places); once it has rested
   * there REST_MS, `log` runs, once per visit of the place. One slot per kind of place, so a late
   * "left" of one kind never cancels another. When it leaves, how long it stayed is logged too
   * (`hover`, `lib/hoverLog.ts`), so `key` is an id or a position, never text.
   */
  restOn: (slot: RestSlot, key: string | null, log?: () => void) => void;
}

export type RestSlot = HoverName;

/** A pointer that stays this long on a leaf, a message or a hint rests there (usage log). */
const REST_MS = 400;
/** The forgetting scrubber and the forest's search are logged once they have stayed put this long, not at every step. */
export const SETTLE_MS = 800;

const UiContext = createContext<Ui | null>(null);

export function UiProvider({ children }: { children: ReactNode }) {
  const { dispatch, state, track, navigate, back } = useStore();
  const [days, setDays] = useState(0);
  const [view, showView] = useState<TreeView>(() => (param('layout') === 'outline' ? 'outline' : 'tree'));
  const sheet = sheetOf(state.ui.view);
  const forestOpen = state.ui.view.kind === 'forest';
  const [why, showWhy] = useState<string | null>(null);
  const [link, pointAt] = useState<LinkSource>(null);
  const [refs, showRefs] = useState<string | null>(null);

  /* The usage log (lib/events.ts). The setters read the current values from a ref, so they keep one identity like plain state setters. */
  const current = useRef({ view, sheet, why, refs, days, forest: forestOpen, concepts: state.domain.concepts });
  current.current = { view, sheet, why, refs, days, forest: forestOpen, concepts: state.domain.concepts };
  const paneAction = useCallback(
    (kind: PaneKind, conceptId: string | null) => {
      const { forest, view, days, concepts } = current.current;
      const label = (conceptId && concepts[conceptId]?.label) || null;
      track({ type: 'pane_action', payload: { kind, view: forest ? 'forest' : view, conceptId, label, days } });
    },
    [track],
  );
  useEffect(() => track({ type: 'view_start', payload: { view: current.current.view } }), [track]);
  const setView = useCallback(
    (to: TreeView, via: ViewVia) => {
      const from = current.current.view;
      if (to !== from) track({ type: 'view_change', payload: { from, to, via } });
      showView(to);
    },
    [track],
  );
  // `sheet_open` is logged from the view change (events.ts).
  const setSheet = useCallback(
    (s: Sheet, via: NavVia = 'click') => {
      if (s) navigate(s === 'concepts' ? { kind: 'concepts' } : { kind: 'settings', section: 'model' }, { via });
      else if (current.current.sheet) back(undefined, via);
    },
    [navigate, back],
  );
  const setWhy = useCallback(
    (id: string | null) => {
      if (id && id !== current.current.why) track({ type: 'why_open', payload: { messageId: id } });
      showWhy(id);
    },
    [track],
  );
  const setRefs = useCallback(
    (leafId: string | null) => {
      if (leafId && leafId !== current.current.refs) paneAction('open_refs', leafId);
      showRefs(leafId);
    },
    [paneAction],
  );
  // How long each hover lasted (`hover`): the pointer's place from a passive listener, the view from the store.
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const latest = useRef({ track, kind: state.ui.view.kind });
  latest.current = { track, kind: state.ui.view.kind };
  const clock = useRef<HoverClock | null>(null);
  clock.current ??= new HoverClock({
    track: (e) => latest.current.track(e),
    pointer: () => pointer.current,
    view: () => latest.current.kind,
    size: () => ({ width: window.innerWidth, height: window.innerHeight }),
  });
  useEffect(() => {
    const hovers = clock.current;
    const move = (e: PointerEvent) => {
      pointer.current = { x: e.clientX, y: e.clientY };
    };
    const hidden = () => document.visibilityState === 'hidden' && hovers?.endAll();
    window.addEventListener('pointermove', move, { capture: true, passive: true });
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('pointermove', move, { capture: true });
      document.removeEventListener('visibilitychange', hidden);
      hovers?.endAll();
    };
  }, []);

  const resting = useRef(new Map<RestSlot, { key: string; timer?: number }>());
  const restOn = useCallback((slot: RestSlot, key: string | null, log?: () => void) => {
    clock.current?.set(slot, key);
    const r = resting.current.get(slot);
    if ((r?.key ?? null) === key) return;
    clearTimeout(r?.timer);
    if (key) resting.current.set(slot, { key, timer: log && window.setTimeout(log, REST_MS) });
    else resting.current.delete(slot);
  }, []);
  useEffect(() => () => resting.current.forEach((r) => clearTimeout(r.timer)), []);
  const rest = useCallback((leafId: string | null) => restOn('leaf', leafId, leafId ? () => paneAction('rest_on_leaf', leafId) : undefined), [restOn, paneAction]);
  const setLink = useCallback(
    (l: LinkSource) => {
      pointAt(l);
      rest(l?.kind === 'leaf' ? l.id : null);
    },
    [rest],
  );
  // The scrubber's value once it settles (also from `[` `]`, /time and the squirrel); not at the start.
  useSettled(days, () => paneAction('scrub', null));

  const focusPrompt = useCallback(() => {
    requestAnimationFrame(() => {
      const el = document.getElementById('a-prompt') as HTMLTextAreaElement | null;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }, []);
  const fill = useCallback((text: string) => dispatch({ type: 'draft', text }), [dispatch]);

  const value = useMemo(
    () => ({ days, setDays, view, setView, sheet, setSheet, why, setWhy, link, setLink, refs, setRefs, fill, focusPrompt, paneAction, rest, restOn }),
    [days, view, setView, sheet, setSheet, why, setWhy, link, setLink, refs, setRefs, fill, focusPrompt, paneAction, rest, restOn],
  );
  return <UiContext.Provider value={value}>{children}</UiContext.Provider>;
}

/**
 * Usage log: runs `log` once `value` has stayed the same for SETTLE_MS, never for the value it
 * started with or settled on last (so a scrub there and back logs nothing).
 */
export function useSettled(value: string | number, log: () => void) {
  const settled = useRef(value);
  const latest = useRef(log);
  latest.current = log;
  useEffect(() => {
    if (value === settled.current) return;
    const t = window.setTimeout(() => {
      settled.current = value;
      latest.current();
    }, SETTLE_MS);
    return () => clearTimeout(t);
  }, [value]);
}

export function useUi() {
  const ctx = useContext(UiContext);
  if (!ctx) throw new Error('useUi outside UiProvider');
  return ctx;
}

function param(name: string) {
  try {
    return new URLSearchParams(window.location.search).get(name);
  } catch {
    return null;
  }
}

/* ───────────── Primitives ───────────── */

/**
 * The one glyph: filled = you, half = together, hollow = AI. Drawn as a pie in a 1ch cell,
 * so it sits on the character grid like any letter and works in every font.
 */
export function G({ score, mode, className = '' }: { score?: number; mode?: Mode; className?: string }) {
  const s = score ?? (mode ? MODE_SCORE[mode] : 0);
  const c = 2 * Math.PI * 2.5;
  return (
    <span className={`a-g ${className}`} aria-hidden="true">
      <svg viewBox="0 0 12 12">
        <circle className={`a-g-ring ${s > 0 ? 'is-you' : 'is-ai'}`} cx="6" cy="6" r="5" />
        <circle
          className="a-g-fill"
          cx="6"
          cy="6"
          r="2.5"
          strokeWidth="5"
          strokeDasharray={`${Math.min(1, s) * c} ${c}`}
          transform="rotate(-90 6 6)"
        />
      </svg>
    </span>
  );
}

/** A key cap, written the terminal way. */
export function K({ children }: { children: ReactNode }) {
  return <kbd className="a-k">{children}</kbd>;
}

/** `(•) label` radio group. */
export function Radios<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { v: T; label: ReactNode }[];
  onChange: (v: T) => void;
}) {
  return (
    <span className="a-radios" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.v} role="radio" aria-checked={value === o.v} className="a-radio" onClick={() => onChange(o.v)}>
          <span className="a-radio-box" aria-hidden="true">
            {value === o.v ? '(•)' : '( )'}
          </span>
          {o.label}
        </button>
      ))}
    </span>
  );
}

/** `[x] label` checkbox. */
export function Check({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <button role="checkbox" aria-checked={checked} className="a-check" onClick={() => onChange(!checked)}>
      <span aria-hidden="true">{checked ? '[x]' : '[ ]'}</span> {children}
    </button>
  );
}

export const lower = (s: string) => s.toLowerCase();

/**
 * An error in the design's lowercase voice, except what must keep its case to be copied: names like
 * OLLAMA_ORIGINS, URLs, model ids, times, quoted words, and acronyms (HTTP, CORS).
 */
export const lowerProse = (s: string) =>
  s.replace(/"[^"]*"|\S+/g, (w) => (/[_/.\d"]|^\W*[A-Z]{2,}/.test(w.replace(/[.,;:!?)]+$/, '')) ? w : w.toLowerCase()));

/** Reasons, lower-cased and without the quoted words the evidence already points at. */
export const shortReason = (r: string) => lower(r.replace(/\s*\(“[^”]*”\)/, ''));

/** Is the keyboard event aimed at a text field? */
export const typing = (e: KeyboardEvent | React.KeyboardEvent) => {
  const t = e.target as HTMLElement | null;
  return Boolean(t?.closest?.('input, textarea, [contenteditable="true"]'));
};
