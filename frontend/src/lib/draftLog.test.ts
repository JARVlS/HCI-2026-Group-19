import { describe, expect, it } from 'vitest';
import { ABANDON_MIN, DraftLog } from './draftLog';
import { MAX_TEXT, type UsageEvent } from './events';

/** How a draft came about (usage log): keys, pastes, time to send, abandoned drafts. */

function setup() {
  const events: UsageEvent[] = [];
  const clock = { t: 1000 };
  const log = new DraftLog((e) => events.push(e), () => clock.t);
  /** Type `text` key by key, as the prompt sees it. */
  const type = (text: string, from = '') => {
    let draft = from;
    for (const ch of text) {
      log.key(ch);
      draft += ch;
      log.change(draft);
      clock.t += 100;
    }
    return draft;
  };
  return { log, events, clock, type };
}

describe('draft log', () => {
  it('a sent message: compose with the time from the first key, keys, deletes and pastes', () => {
    const { log, events, clock, type } = setup();
    let draft = type('helo');
    log.key('Shift'); // a modifier is no key press
    log.key('Backspace');
    log.key('Backspace');
    draft = draft.slice(0, -2);
    log.change(draft);
    draft = type('llo', draft);
    log.paste(' world');
    draft += ' world';
    log.change(draft);
    clock.t += 500;
    log.sent(draft, 'm1');
    log.change('');
    expect(events).toEqual([
      { type: 'draft_paste', payload: { text: ' world', chars: 6, draftChars: 5 } },
      { type: 'compose', payload: { messageId: 'm1', chars: 11, ms: 1200, keys: 9, deletes: 2, pastes: 1, pastedChars: 6 } },
    ]);
  });

  it('the next draft starts afresh; a draft that was only pasted has ms from the paste', () => {
    const { log, events, clock, type } = setup();
    log.sent(type('first'), 'm1');
    log.change('');
    clock.t += 10_000;
    log.paste('Write me an essay on photosynthesis');
    log.change('Write me an essay on photosynthesis');
    clock.t += 300;
    log.key('Enter');
    log.sent('Write me an essay on photosynthesis', 'm2');
    expect(events.at(-1)).toEqual({ type: 'compose', payload: { messageId: 'm2', chars: 35, ms: 300, keys: 1, deletes: 0, pastes: 1, pastedChars: 35 } });
    // Pasting into an empty prompt: draftChars 0 (the whole task was pasted).
    expect(events.find((e) => e.type === 'draft_paste')).toMatchObject({ payload: { draftChars: 0 } });
  });

  it('text put in from elsewhere and sent without a key: ms is null', () => {
    const { log, events } = setup();
    log.change('In my own words, atp is ');
    log.sent('In my own words, atp is ', 'm1');
    expect(events).toEqual([{ type: 'compose', payload: { messageId: 'm1', chars: 24, ms: null, keys: 0, deletes: 0, pastes: 0, pastedChars: 0 } }]);
  });

  it(`a draft emptied by hand: draft_abandoned with its text, from ${ABANDON_MIN} characters on`, () => {
    const { log, events, type } = setup();
    type('ok');
    log.change('');
    expect(events).toEqual([]); // a stray key or two
    type('what is entropy');
    log.change('');
    expect(events).toEqual([{ type: 'draft_abandoned', payload: { text: 'what is entropy', chars: 15 } }]);
  });

  it('sent, or a command run: never abandoned; a half-typed command emptied: nothing', () => {
    const { log, events, type } = setup();
    log.sent(type('explain entropy'), 'm1');
    log.change('');
    type('/theme dark');
    log.command();
    log.change('');
    type('/forest');
    log.change('');
    expect(events.map((e) => e.type)).toEqual(['compose']);
  });

  it('texts are cut at MAX_TEXT, the lengths are the real ones', () => {
    const { log, events } = setup();
    const long = 'y'.repeat(MAX_TEXT + 10);
    log.paste(long);
    log.change(long);
    log.change('');
    expect(events).toMatchObject([
      { type: 'draft_paste', payload: { chars: MAX_TEXT + 10 } },
      { type: 'draft_abandoned', payload: { chars: MAX_TEXT + 10 } },
    ]);
    for (const e of events) expect((e.payload as { text: string }).text).toHaveLength(MAX_TEXT);
  });
});
