import type { Id } from './domain';
import { cut, type UsageEvent } from './events';

/*
 * How one draft in the prompt came about, for the usage log (IMPLEMENTATION_PLAN.md M6, "Event
 * log"): key presses, Backspace and Delete, pastes, and the time from the draft's first key or paste
 * to send (`compose`, once per sent message); every paste with its text (`draft_paste`: pasting a
 * task is delegating it); and a draft emptied by hand without being sent (`draft_abandoned`).
 * No React, so tests drive it directly. A key press only counts: logging never slows typing.
 */

/** A draft emptied with fewer characters than this (trimmed) is not logged as abandoned: a stray key or two. */
export const ABANDON_MIN = 5;

const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'CapsLock', 'Fn']);

export class DraftLog {
  /** The prompt's text as last seen (`change`). */
  private text = '';
  private start: number | null = null;
  private keys = 0;
  private deletes = 0;
  private pastes = 0;
  private pastedChars = 0;

  constructor(
    private readonly track: (e: UsageEvent) => void,
    private readonly now: () => number = Date.now,
  ) {}

  /** A key went down in the prompt. */
  key(key: string) {
    if (MODIFIERS.has(key)) return;
    this.start ??= this.now();
    this.keys++;
    if (key === 'Backspace' || key === 'Delete') this.deletes++;
  }

  /** Text was pasted into the prompt (before the prompt's text changes). */
  paste(text: string) {
    this.start ??= this.now();
    this.pastes++;
    this.pastedChars += text.length;
    this.track({ type: 'draft_paste', payload: { text: cut(text), chars: text.length, draftChars: this.text.length } });
  }

  /** The prompt's text changed, by any means. Emptied (not by `sent` or `command`): the draft was abandoned. */
  change(text: string) {
    const before = this.text;
    this.text = text;
    if (text || !before) return;
    if (!before.startsWith('/') && before.trim().length >= ABANDON_MIN) this.track({ type: 'draft_abandoned', payload: { text: cut(before), chars: before.length } });
    this.reset();
  }

  /** `text` was sent as message `messageId` (null: the app did not send it). The next draft starts afresh. */
  sent(text: string, messageId: Id | null) {
    const { start, keys, deletes, pastes, pastedChars } = this;
    this.track({ type: 'compose', payload: { messageId, chars: text.length, ms: start === null ? null : this.now() - start, keys, deletes, pastes, pastedChars } });
    this.reset();
  }

  /** A command ran: its text is neither a message nor an abandoned draft. */
  command() {
    this.reset();
  }

  private reset() {
    this.text = '';
    this.start = null;
    this.keys = this.deletes = this.pastes = this.pastedChars = 0;
  }
}
