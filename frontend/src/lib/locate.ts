import type { Located } from './events';

/**
 * Where a click landed, for the usage log (`click`, `pageEvents.ts`): the part of the page and
 * what was pressed, as fixed names from the code. Never text from the page: no labels, no
 * `aria-label` or `title` (those can hold chat titles), only tag and class names.
 */

/** The parts of the page, most specific first (overlays before what lies under them). */
export const REGIONS: readonly (readonly [string, string])[] = [
  ['radial', '.a-radial'],
  ['welcome', '.w-root'],
  ['intro', '.a-intro'],
  ['sheet', '.a-sheet-back'],
  ['forest', '.a-forest'],
  ['pane', '.a-pane'],
  ['composer', '.a-composer'],
  ['transcript', '.a-chat'],
  ['top', '.a-top'],
  ['modeline', '.a-modeline'],
];

const round = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 1000) / 1000;

/** `tag.class`: the element's tag and the first class of it or of its nearest ancestor that has one. */
export function targetOf(el: Element): string {
  const tag = el.tagName.toLowerCase();
  for (let e: Element | null = el; e; e = e.parentElement) {
    const first = typeof e.className === 'string' ? e.className.trim().split(/\s+/)[0] : e.getAttribute('class')?.trim().split(/\s+/)[0];
    if (first) return `${tag}.${first}`;
  }
  return tag;
}

export function locate(target: EventTarget | null, x: number, y: number): Located {
  // No DOM (tests in node): nothing to locate.
  const el = typeof Element !== 'undefined' && target instanceof Element ? target : null;
  if (!el) return { region: 'other', target: '', rx: null, ry: null };
  for (const [region, selector] of REGIONS) {
    const box = el.closest(selector);
    if (!box) continue;
    const r = box.getBoundingClientRect();
    return { region, target: targetOf(el), rx: r.width ? round((x - r.left) / r.width) : null, ry: r.height ? round((y - r.top) / r.height) : null };
  }
  return { region: 'other', target: targetOf(el), rx: null, ry: null };
}
