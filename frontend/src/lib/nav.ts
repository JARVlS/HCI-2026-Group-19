import type { Id } from './domain';

/**
 * One navigation model (IMPLEMENTATION_PLAN.md ADR-13, M2b). Every screen is a `View`; the store
 * holds the current one (`ui.view`), the URL hash mirrors it (`history.ts`), and every way of
 * getting somewhere (radial menu, `/commands`, keys, links, the back button) goes through
 * `app.navigate()`. Pure: no window, no store.
 *
 * Only screens that exist are kinds. `study`, `graph` and a full-screen `tree` come with M5; tree
 * vs. outline is a setting of the pane (`view_change`), not a view.
 */
export type View =
  /** A chat. In the store `conversationId` is left out: it is the active chat (`session.activeConversationId`). */
  | { kind: 'chat'; conversationId?: Id; messageId?: Id }
  | { kind: 'chats' }
  | { kind: 'forest'; treeId?: Id }
  | { kind: 'concepts' }
  | { kind: 'settings'; section?: 'model' };

export type ViewKind = View['kind'];

/** How a view was reached, for the usage log (`nav`, `view_change`). */
export type NavVia = 'key' | 'command' | 'click' | 'radial' | 'radial_flick' | 'back' | 'link';

export const CHAT: View = { kind: 'chat' };

/** The hash of a view: `#/chat/<id>[/<msg>]`, `#/chats`, `#/forest[/<tree>]`, `#/concepts`, `#/settings[/model]`. */
export function formatHash(v: View): string {
  const seg = (s: string) => encodeURIComponent(s);
  switch (v.kind) {
    case 'chat':
      return v.conversationId ? `#/chat/${seg(v.conversationId)}${v.messageId ? `/${seg(v.messageId)}` : ''}` : '#/chat';
    case 'forest':
      return v.treeId ? `#/forest/${seg(v.treeId)}` : '#/forest';
    case 'settings':
      return v.section ? `#/settings/${v.section}` : '#/settings';
    default:
      return `#/${v.kind}`;
  }
}

/** The view a hash names; null for anything else (an empty hash, a typo, an anchor). */
export function parseHash(hash: string): View | null {
  const m = /^#\/([a-z]+)((?:\/[^/]+)*)\/?$/.exec(hash.trim());
  if (!m) return null;
  let parts: string[];
  try {
    parts = m[2].split('/').slice(1).map(decodeURIComponent);
  } catch {
    return null;
  }
  const [a, b] = parts;
  switch (m[1]) {
    case 'chat':
      if (parts.length > 2) return null;
      return a ? (b ? { kind: 'chat', conversationId: a, messageId: b } : { kind: 'chat', conversationId: a }) : { kind: 'chat' };
    case 'chats':
    case 'concepts':
      return parts.length ? null : { kind: m[1] };
    case 'forest':
      if (parts.length > 1) return null;
      return a ? { kind: 'forest', treeId: a } : { kind: 'forest' };
    case 'settings':
      if (parts.length > 1 || (a && a !== 'model')) return null;
      return a ? { kind: 'settings', section: 'model' } : { kind: 'settings' };
    default:
      return null;
  }
}

/** The view as the store keeps it: a chat without its id (the active chat) and without a message to jump to. */
export function stored(v: View): View {
  return v.kind === 'chat' ? CHAT : v;
}

/** The full view, for the URL: the store's view with the active chat filled in. */
export function routeOf(view: View, activeConversationId: Id): View {
  return view.kind === 'chat' && activeConversationId ? { kind: 'chat', conversationId: activeConversationId } : view;
}

export function sameView(a: View, b: View): boolean {
  return formatHash(a) === formatHash(b);
}

/** The first view: the hash, else the old `?view=forest&tree=` parameters, else the chat. */
export function initialView(hash: string, p: URLSearchParams): View {
  const fromHash = parseHash(hash);
  if (fromHash) return fromHash;
  if (p.get('view') === 'forest') {
    const tree = p.get('tree');
    return tree ? { kind: 'forest', treeId: tree } : { kind: 'forest' };
  }
  return CHAT;
}

/** Which sheet a view shows over the chat (ASCII design). */
export type Sheet = 'concepts' | 'model' | null;
export function sheetOf(v: View): Sheet {
  if (v.kind === 'concepts') return 'concepts';
  if (v.kind === 'settings' && v.section === 'model') return 'model';
  return null;
}
