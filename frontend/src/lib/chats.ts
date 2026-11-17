import type { Conversation, Id, ISO, Message } from './domain';
import { sortByTime } from './links';

/** Chats as the user sees them: a new chat, its title, which one opens first (IMPLEMENTATION_PLAN.md, M2). */

export const NEW_CHAT_TITLE = 'New chat';

/** Titles from the first message stay about this long, so a chat list row can show them whole. */
const TITLE_MAX = 48;

export const newConversation = (id: Id, now: ISO): Conversation => ({
  id,
  title: NEW_CHAT_TITLE,
  subjectId: null,
  studyMode: false,
  createdAt: now,
  updatedAt: now,
});

/** A chat's title from its first message: one line, cut at a word boundary. No model call. */
export function titleFrom(text: string, max = TITLE_MAX): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return NEW_CHAT_TITLE;
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const space = t[max] === ' ' ? max : cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.!?-]+$/, '')}…`;
}

/** One chat's messages from two sources, by id; `top` wins (it is newer). Oldest first. */
export function mergeMessages(base: Message[], top: Message[]): Message[] {
  if (!top.length) return base;
  const byId = new Map(base.map((m) => [m.id, m]));
  for (const m of top) byId.set(m.id, m);
  return sortByTime([...byId.values()]);
}

/** The chat that opens at start: the one changed last. */
export function latestConversation(conversations: Record<Id, Conversation>): Id | null {
  let best: Conversation | null = null;
  for (const c of Object.values(conversations)) if (!best || c.updatedAt > best.updatedAt) best = c;
  return best?.id ?? null;
}
