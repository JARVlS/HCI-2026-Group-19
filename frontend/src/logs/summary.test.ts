import { describe, expect, it } from 'vitest';
import { LEGEND } from './legend';
import { summarize } from './summary';

const ev = (type: string, payload: Record<string, unknown>) => summarize({ type, payload: { visit: 'v1', seq: 3, design: 'ascii', ...payload } });

describe('summarize', () => {
  it('a sent message: label, numbers, and the text in full', () => {
    const long = 'I think backprop goes backwards with the chain rule. '.repeat(40);
    expect(ev('turn_sent', { messageId: 'm1', text: long, chars: long.length, words: 400, mode: 'own', confidence: 0.8, thinking: 72, quizAnswer: false })).toEqual({
      line: `own · thinking 72% · 400 words · ${long.length} chars`,
      texts: [{ label: 'message', text: long }],
    });
  });

  it('a reply: time, model, stopped, and its text', () => {
    expect(ev('reply_done', { messageId: 'a1', userMessageId: 'm1', text: 'Yes, and…', chars: 9, ms: 2345, model: 'claude-sonnet-5-5', stopped: true })).toEqual({
      line: 'after 2.3 s · claude-sonnet-5-5 · 9 chars · stopped',
      texts: [{ label: 'reply', text: 'Yes, and…' }],
    });
  });

  it('the texts of drafts, guesses, pastes and copies', () => {
    expect(ev('draft_rated', { text: 'why does it', percent: 40, mode: 'together', model: 'glm', chars: 11 }).texts).toEqual([{ label: 'draft', text: 'why does it' }]);
    expect(ev('reveal', { messageId: 'a1', guess: 'it goes backwards', guessChars: 17, ms: 12_000 })).toEqual({
      line: 'veiled 12.0 s · 17 chars',
      texts: [{ label: 'guess', text: 'it goes backwards' }],
    });
    expect(ev('draft_paste', { text: 'pasted bit', chars: 10, draftChars: 4 })).toEqual({ line: '10 chars · into a draft of 4', texts: [{ label: 'pasted', text: 'pasted bit' }] });
    expect(ev('transcript_copy', { messageId: 'a1', role: 'assistant', text: 'copied', chars: 6 }).line).toBe('from assistant · 6 chars');
    expect(ev('draft_abandoned', { text: 'never mind', chars: 10 }).texts[0].text).toBe('never mind');
  });

  it('one line for the others', () => {
    expect(ev('analysis_shown', { mode: 'own', shown: 'together', judged: 2, concepts: ['recursion', 'base case'], reasons: ['own claim', 'asks why'], newConcepts: 1, newConceptLabels: ['base case'], newTrees: 0 })).toEqual({
      line: 'own · shown as together · judged recursion, base case · new base case',
      texts: [{ label: 'reasons', text: 'own claim\nasks why' }],
    });
    expect(ev('view_change', { from: 'tree', to: 'outline', via: 'key' }).line).toBe('tree → outline · by key');
    expect(ev('relabel', { messageId: 'm1', from: null, to: 'own' }).line).toBe('– → own');
    expect(ev('chat_rename', { title: 'Recursion', from: null }).line).toBe('(no title) → "Recursion"');
    expect(ev('command', { name: 'quiz', arg: 'loss' }).line).toBe('/quiz loss');
    expect(ev('command', { name: 'provider', arg: null }).line).toBe('/provider');
    expect(ev('pane_action', { kind: 'rest_on_leaf', view: 'tree', conceptId: 'c1', label: 'Loss', days: 0 }).line).toBe('rest on leaf · "Loss" · in tree');
    expect(ev('pane_action', { kind: 'scrub', view: 'outline', conceptId: null, label: null, days: 1 }).line).toBe('scrub · in outline · 1 day');
    expect(ev('score', { userMessageId: 'm1', key: 'thinking', percent: 71.6, label: 'own', model: 'glm', failed: false }).line).toBe('thinking 72% · label own · glm');
    expect(ev('score', { key: 'correct', percent: null, failed: true }).line).toBe('correct · failed');
    expect(ev('hint_hover', { which: 'word', mode: 'ai', word: 'summary', reason: 'asks for a summary' }).line).toBe('"summary" · ai · asks for a summary');
    expect(ev('hint_hover', { which: 'line', mode: 'own', percent: 80, from: 'model' }).line).toBe('score line · own · 80% · model');
    expect(ev('setting_changed', { key: 'theme', value: 'dark' }).line).toBe('theme = dark');
    expect(ev('idle_end', { ms: 135_000 }).line).toBe('quiet for 02:15');
    expect(ev('resize', { width: 390, height: 844 }).line).toBe('390×844');
    expect(ev('client_error', { message: 'x is undefined', source: 'app.js', line: 12 }).line).toBe('x is undefined · at app.js:12');
    expect(ev('tree_created', { treeId: 't1', title: 'ML', splitFrom: null, leaves: 1 }).line).toBe('"ML" · 1 leaf');
    expect(ev('page_hidden', {})).toEqual({ line: '', texts: [] });
  });

  it('never throws, whatever the payload holds (older events, broken rows)', () => {
    const odd = [{}, 5, 'x', null, [], true];
    for (const type of Object.keys(LEGEND)) {
      for (const value of odd) {
        const payload = new Proxy({} as Record<string, unknown>, { get: () => value, has: () => true });
        expect(() => summarize({ type, payload }), `${type} with ${JSON.stringify(value)}`).not.toThrow();
        expect(typeof summarize({ type, payload }).line).toBe('string');
      }
      expect(summarize({ type, payload: {} }).texts).toEqual([]);
    }
  });

  it('a type the catalogue does not know: its fields, long strings as texts, no envelope', () => {
    const long = 'x'.repeat(100);
    expect(ev('nope', { to: 'forest', n: 2, note: long })).toEqual({ line: 'to forest · n 2', texts: [{ label: 'note', text: long }] });
  });

  it('a payload that was not json shows what was stored', () => {
    expect(summarize({ type: 'turn_sent', payload: { _raw: '{not json' } })).toEqual({
      line: 'the stored payload is not valid json',
      texts: [{ label: 'stored', text: '{not json' }],
    });
  });
});
