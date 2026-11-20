import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { PaneKind, TreeView, ViewVia } from '../../lib/events';
import { MODE_SCORE } from '../../lib/modes';
import { useStore } from '../../lib/store';
import type { Mode } from '../../lib/types';

/* ───────────── UI state that only this design needs ─────────────
 * The conversation, settings, highlight and forest focus live in the shared store;
 * the rest (time scrubber, tree view, open sheets, link source) is local to the ASCII design.
 */

export type Sheet = 'concepts' | 'model' | null;
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
  setSheet: (s: Sheet) => void;
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
}

/** A pointer that stays this long on a leaf rests there (usage log, `pane_action`). */
const REST_MS = 400;
/** The forgetting scrubber is logged once it has stayed put this long, not at every step. */
const SCRUB_MS = 800;

const UiContext = createContext<Ui | null>(null);

export function UiProvider({ children }: { children: ReactNode }) {
  const { dispatch, state, track } = useStore();
  const [days, setDays] = useState(0);
  const [view, showView] = useState<TreeView>(() => (param('layout') === 'outline' ? 'outline' : 'tree'));
  const [sheet, showSheet] = useState<Sheet>(null);
  const [why, showWhy] = useState<string | null>(null);
  const [link, pointAt] = useState<LinkSource>(null);
  const [refs, showRefs] = useState<string | null>(null);

  /* The usage log (lib/events.ts). The setters read the current values from a ref, so they keep one identity like plain state setters. */
  const current = useRef({ view, sheet, why, refs, days, forest: state.ui.forest.open });
  current.current = { view, sheet, why, refs, days, forest: state.ui.forest.open };
  const paneAction = useCallback(
    (kind: PaneKind, conceptId: string | null) => {
      const { forest, view, days } = current.current;
      track({ type: 'pane_action', payload: { kind, view: forest ? 'forest' : view, conceptId, days } });
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
  const setSheet = useCallback(
    (s: Sheet) => {
      if (s && s !== current.current.sheet) track({ type: 'sheet_open', payload: { which: s } });
      showSheet(s);
    },
    [track],
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
  const resting = useRef<{ id: string | null; timer?: number }>({ id: null });
  const rest = useCallback(
    (leafId: string | null) => {
      const r = resting.current;
      if (leafId === r.id) return;
      clearTimeout(r.timer);
      resting.current = { id: leafId, timer: leafId ? window.setTimeout(() => paneAction('rest_on_leaf', leafId), REST_MS) : undefined };
    },
    [paneAction],
  );
  useEffect(() => () => clearTimeout(resting.current.timer), []);
  const setLink = useCallback(
    (l: LinkSource) => {
      pointAt(l);
      rest(l?.kind === 'leaf' ? l.id : null);
    },
    [rest],
  );
  // The scrubber's value once it settles (also from `[` `]`, /time and the squirrel); not at the start.
  const scrubbed = useRef(false);
  useEffect(() => {
    if (!scrubbed.current) {
      scrubbed.current = true;
      return;
    }
    const t = window.setTimeout(() => paneAction('scrub', null), SCRUB_MS);
    return () => clearTimeout(t);
  }, [days, paneAction]);

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
    () => ({ days, setDays, view, setView, sheet, setSheet, why, setWhy, link, setLink, refs, setRefs, fill, focusPrompt, paneAction, rest }),
    [days, view, setView, sheet, setSheet, why, setWhy, link, setLink, refs, setRefs, fill, focusPrompt, paneAction, rest],
  );
  return <UiContext.Provider value={value}>{children}</UiContext.Provider>;
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
