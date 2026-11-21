import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useStore } from '../../lib/store';
import { shortDate } from '../../lib/time';
import type { Leaf } from '../../lib/types';
import { G, K, lower, useUi } from './ui';

/* ───────────────────────── Chats and revisits (IMPLEMENTATION_PLAN.md M2) ─────────────────────────
 *   chat list   — `c` or /chats: every chat by day, each with the crowns of the trees it grew
 *   leaf → msg  — a leaf touched by several messages lists them (chat · snippet · date), in any chat
 * Both are the same keyboard-first sheet: ↑↓ move, ↵ open, esc close.
 */

interface Item {
  key: string;
  /** A heading above this row when it differs from the row before. */
  group?: string;
  label: string;
  content: ReactNode;
  current?: boolean;
  onPick: () => void;
}

function Picker({
  title,
  meta,
  items,
  foot,
  onClose,
  onKey,
}: {
  title: string;
  meta?: ReactNode;
  items: Item[];
  foot: ReactNode;
  onClose: () => void;
  /** Extra keys; return true when handled. */
  onKey?: (e: KeyboardEvent) => boolean;
}) {
  const [sel, setSel] = useState(() => Math.max(0, items.findIndex((i) => i.current)));
  const list = useRef<HTMLUListElement>(null);
  const keys = useRef({ items, sel, onClose, onKey });
  keys.current = { items, sel, onClose, onKey };

  useEffect(() => {
    list.current?.focus();
    // A modal sheet: its keys win, and other shortcuts of the app stay quiet while it is open.
    const on = (e: KeyboardEvent) => {
      const { items, sel, onClose, onKey } = keys.current;
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') setSel((s) => (s + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % Math.max(1, items.length));
      else if (e.key === 'Enter') items[sel]?.onPick();
      else if (!(e.metaKey || e.ctrlKey || e.altKey) && onKey?.(e)) {
        /* handled */
      } else {
        if (e.key !== 'Tab') e.stopImmediatePropagation();
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener('keydown', on, true);
    return () => window.removeEventListener('keydown', on, true);
  }, []);

  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  return (
    <div className="a-sheet-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="a-sheet a-picker" role="dialog" aria-modal="true" aria-label={title}>
        <header className="a-sheet-head">
          <h2>{title}</h2>
          {meta && <span className="a-dim">{meta}</span>}
          <button className="a-icon" onClick={onClose} aria-label="Close" title="close  esc">
            ×
          </button>
        </header>
        <ul className="a-pick" role="listbox" aria-label={title} tabIndex={-1} ref={list}>
          {items.map((it, i) => (
            <Fragment key={it.key}>
              {it.group && it.group !== items[i - 1]?.group && (
                <li className="a-pick-group a-dim" role="presentation">
                  {it.group}
                </li>
              )}
              <li
                role="option"
                aria-selected={i === sel}
                aria-label={it.label}
                className={`${i === sel ? 'on' : ''}${it.current ? ' here' : ''}`}
                onMouseEnter={() => setSel(i)}
                onClick={it.onPick}
              >
                {it.content}
              </li>
            </Fragment>
          ))}
        </ul>
        <p className="a-sheet-foot a-dim">{foot}</p>
      </div>
    </div>
  );
}

/** "14:05" today, "nov 12" before. */
function when(iso: string) {
  const d = shortDate(iso);
  return d === 'Today' ? new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : lower(d);
}

const CROWN_MAX = 6;

/** A tree as a crown of glyphs: one per leaf this chat touched. */
function Crown({ scores, title }: { scores: number[]; title: string }) {
  return (
    <span className="a-crown" title={title}>
      {scores.slice(0, CROWN_MAX).map((s, i) => (
        <Fragment key={i}>
          {i > 0 && ' '}
          <G score={s} />
        </Fragment>
      ))}
      {scores.length > CROWN_MAX && <span className="a-dim">+</span>} <span className="a-dim">{lower(title)}</span>
    </span>
  );
}

/** The chat list (`c`, /chats). */
export function ChatList() {
  const { state, dispatch, chats, mode, openChat, newChat } = useStore();
  const close = useCallback(() => dispatch({ type: 'chats', open: false }), [dispatch]);
  if (!state.ui.chats) return null;
  const items: Item[] = chats.flatMap((g) =>
    g.items.map((c) => ({
      key: c.id,
      group: lower(g.label),
      label: `${c.title}${c.active ? ' (open)' : ''}, ${c.crowns.length} tree${c.crowns.length === 1 ? '' : 's'}`,
      current: c.active,
      onPick: () => openChat(c.id),
      content: (
        <>
          <span className="a-pick-mark">{c.active ? '›' : ''}</span>
          <span className="a-pick-title">{lower(c.title)}</span>
          <span className="a-pick-crowns">
            {c.crowns.length ? c.crowns.slice(0, 3).map((t) => <Crown key={t.treeId} scores={t.scores} title={t.title} />) : <span className="a-dim">no tree yet</span>}
          </span>
          <span className="a-pick-when a-dim">{when(c.updatedAt)}</span>
        </>
      ),
    })),
  );
  const n = items.length;
  return (
    <Picker
      title="chats"
      meta={`${n} chat${n === 1 ? '' : 's'} · ${mode === 'live' ? 'saved' : 'demo: nothing is saved'}`}
      items={items}
      onClose={close}
      onKey={(e) => {
        if (e.key !== 'n') return false;
        newChat();
        return true;
      }}
      foot={
        <>
          <K>↑↓</K> move <K>↵</K> open <K>n</K> new chat <K>esc</K> close
        </>
      }
    />
  );
}

/** A leaf's messages (in any chat), to jump to one. */
export function LeafRefs() {
  const { state, forestTrees, openChat, loadChat } = useStore();
  const { refs: leafId, setRefs, paneAction } = useUi();
  const leaf = useMemo(() => (leafId ? findLeaf(forestTrees, leafId) : undefined), [forestTrees, leafId]);
  const refs = useMemo(() => [...(leaf?.refs ?? [])].reverse(), [leaf]);
  const chatIds = useMemo(() => [...new Set(refs.map((r) => r.conversationId))], [refs]);

  // Snippets need the messages: load the chats involved (live mode; cached for the visit).
  useEffect(() => {
    chatIds.forEach(loadChat);
  }, [chatIds, loadChat]);

  if (!leaf) return null;
  const { conversations, messagesByConv } = state.domain;
  const active = state.session.activeConversationId;
  const close = () => setRefs(null);
  const items: Item[] = refs.map((r) => {
    const chat = conversations[r.conversationId];
    const msg = messagesByConv[r.conversationId]?.find((m) => m.id === r.messageId);
    const load = state.session.chatLoad[r.conversationId];
    const snippet = msg ? `“${msg.text.replace(/\s+/g, ' ').slice(0, 80)}”` : load === 'loading' ? 'loading…' : load ? 'could not load this chat' : 'no transcript';
    return {
      key: r.messageId,
      label: `${chat?.title ?? 'a chat'}: ${msg?.text.slice(0, 80) ?? ''}`,
      current: r.conversationId === active,
      onPick: () => {
        paneAction('jump_to_message', leaf.id);
        close();
        openChat(r.conversationId, r.messageId);
      },
      content: (
        <>
          <span className="a-pick-mark">{r.conversationId === active ? '›' : ''}</span>
          <span className="a-pick-title">{lower(chat?.title ?? 'a chat')}</span>
          <span className={`a-pick-snippet${msg ? '' : ' a-dim'}`}>{snippet}</span>
          <span className="a-pick-when a-dim">{when(r.at)}</span>
        </>
      ),
    };
  });
  return (
    <Picker
      title={lower(leaf.label)}
      meta={`${refs.length} message${refs.length === 1 ? '' : 's'} in ${chatIds.length} chat${chatIds.length === 1 ? '' : 's'} · newest first`}
      items={items}
      onClose={close}
      foot={
        <>
          <K>↑↓</K> move <K>↵</K> open that chat at the message <K>esc</K> close · <span>›</span> = the open chat
        </>
      }
    />
  );
}

function findLeaf(trees: { branches: { leaves: Leaf[] }[] }[], id: string): Leaf | undefined {
  for (const t of trees) for (const b of t.branches) for (const l of b.leaves) if (l.id === id) return l;
  return undefined;
}

/**
 * Click or enter on a leaf: one message → open its chat at it; several → list them to pick one.
 * Used by the pane's tree and the forest's tree detail.
 */
export function useLeafJump() {
  const { forestTrees, openChat, state } = useStore();
  const { setRefs, paneAction } = useUi();
  const active = state.session.activeConversationId;
  return useCallback(
    (messageId: string, leafId: string) => {
      const refs = findLeaf(forestTrees, leafId)?.refs ?? [];
      if (refs.length > 1) return setRefs(leafId);
      paneAction('jump_to_message', leafId);
      openChat(refs.find((r) => r.messageId === messageId)?.conversationId ?? active, messageId);
    },
    [forestTrees, openChat, setRefs, paneAction, active],
  );
}
