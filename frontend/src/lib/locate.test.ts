import { describe, expect, it } from 'vitest';
import { locate, targetOf } from './locate';

/** A stand-in for a DOM element: the tests run in node. */
function el(tag: string, className: string, parent: Element | null = null, extra: object = {}): Element {
  return { tagName: tag.toUpperCase(), className, parentElement: parent, getAttribute: () => className, ...extra } as unknown as Element;
}

describe('where a click landed', () => {
  it('target: the tag and the first class of the element or its nearest ancestor with one', () => {
    const pane = el('aside', 'a-pane open');
    expect(targetOf(el('button', 'a-btn on', pane))).toBe('button.a-btn');
    expect(targetOf(el('span', '', el('button', 'a-ext', pane)))).toBe('span.a-ext');
    expect(targetOf(el('div', ''))).toBe('div');
  });

  it('never text from the page: no content, label or title, even when they hold a chat title', () => {
    const secret = 'my private chat about grades';
    const t = targetOf(el('button', 'a-pick', null, { textContent: secret, title: secret, ariaLabel: secret }));
    expect(t).toBe('button.a-pick');
    expect(t).not.toContain('private');
  });

  it('without a DOM element: other, nothing pressed', () => {
    expect(locate(null, 1, 2)).toEqual({ region: 'other', target: '', rx: null, ry: null });
    expect(locate(new EventTarget(), 1, 2)).toEqual({ region: 'other', target: '', rx: null, ry: null });
  });
});
