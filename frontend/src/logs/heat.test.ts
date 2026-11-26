import { describe, expect, it } from 'vitest';
import { chains, fits, hoverStats, median, pointsOf, radialStats, reference, transitions } from './heat';
import type { AdminEvent } from './visit';

let n = 0;
const T0 = Date.parse('2026-11-24T10:00:00Z');
function ev(type: string, at: number, payload: Record<string, unknown>, visit = 'v1', userId = 'u1'): AdminEvent {
  n++;
  return { id: `e${n}`, userId, condition: null, type, payload: { visit, seq: n, ...payload }, clientTs: new Date(T0 + at).toISOString(), serverTs: '' };
}
const click = (at: number, region: string, sincePrev: number | null, extra: Record<string, unknown> = {}, visit = 'v1') =>
  ev('click', at, { x: 10, y: 20, width: 1400, height: 900, region, target: 'button.a-btn', view: 'chat', pointer: 'mouse', sincePrev, typed: false, ...extra }, visit);
const hover = (at: number, name: string, ms: number, item: string | null = null, visit = 'v1') => ev('hover', at, { name, id: item, ms, x: 5, y: 5, width: 1400, height: 900, view: 'chat' }, visit);

describe('heatmap data', () => {
  it('reads clicks, hovers and radial choices; skips broken rows and other events', () => {
    const { clicks, hovers, picks } = pointsOf([
      click(0, 'pane', null),
      ev('click', 10, { x: 'nope' }),
      hover(20, 'leaf', 500, 'c1'),
      ev('hover', 30, { name: 'leaf' }),
      ev('nav', 40, { via: 'radial', from: 'chat', to: 'forest', ms: 300 }),
      ev('nav', 50, { via: 'click', from: 'chat', to: 'forest', ms: null }),
      ev('turn_sent', 60, { text: 'hi' }),
    ]);
    expect(clicks.map((c) => c.region)).toEqual(['pane']);
    expect(hovers.map((h) => [h.name, h.item, h.ms])).toEqual([['leaf', 'c1', 500]]);
    expect(picks).toHaveLength(1);
  });

  it('chains: consecutive clicks of one visit within the threshold, typing left out on request', () => {
    const { clicks } = pointsOf([
      click(0, 'top', null),
      click(800, 'pane', 800),
      click(4800, 'composer', 4000, { typed: true }),
      click(20000, 'pane', null),
      click(20100, 'transcript', 100, {}, 'v2'),
    ]);
    expect(chains(clicks, 5000).map((c) => [c.from.region, c.to.region, c.ms])).toEqual([
      ['top', 'pane', 800],
      ['pane', 'composer', 4000],
    ]);
    expect(chains(clicks, 1000).map((c) => c.to.region)).toEqual(['pane']);
    expect(chains(clicks, 5000, true).map((c) => c.to.region)).toEqual(['pane']);
  });

  it('a click of another visit never chains, even when its sincePrev is short', () => {
    const { clicks } = pointsOf([click(0, 'top', null, {}, 'a'), click(100, 'pane', 100, {}, 'b')]);
    expect(chains(clicks, 10_000)).toEqual([]);
  });

  it('transitions: region to region, most frequent first, with the median gap', () => {
    const { clicks } = pointsOf([click(0, 'top', null), click(1000, 'pane', 1000), click(4000, 'top', 3000), click(6000, 'pane', 2000)]);
    expect(transitions(chains(clicks, 10_000))).toEqual([
      { from: 'top', to: 'pane', count: 2, median: 1500 },
      { from: 'pane', to: 'top', count: 1, median: 3000 },
    ]);
  });

  it('hover stats: count, median, total, and the share with a click while the pointer was there', () => {
    const { clicks, hovers } = pointsOf([click(800, 'pane', null), hover(1000, 'leaf', 800), hover(3000, 'leaf', 400), hover(4000, 'message', 2000)]);
    expect(hoverStats(hovers, clicks)).toEqual([
      { name: 'message', count: 1, median: 2000, total: 2000, clicked: 0 },
      { name: 'leaf', count: 2, median: 600, total: 1200, clicked: 0.5 },
    ]);
  });

  it('radial stats: options pointed at, how long, and the one let go on', () => {
    const { hovers, picks } = pointsOf([
      hover(100, 'radial', 100, 'tree'),
      hover(400, 'radial', 300, 'forest'),
      ev('nav', 420, { via: 'radial' }),
      hover(2000, 'radial', 50, 'forest'),
    ]);
    expect(radialStats(hovers, picks)).toEqual([
      { option: 'forest', pointed: 2, median: 175, chosen: 1 },
      { option: 'tree', pointed: 1, median: 100, chosen: 0 },
    ]);
  });

  it('reference: the most common window size, rounded; fits within 15 %', () => {
    const ref = reference([
      { width: 1398, height: 902 },
      { width: 1401, height: 899 },
      { width: 390, height: 844 },
    ]);
    expect(ref).toEqual({ width: 1400, height: 900 });
    expect(fits({ width: 1300, height: 950 }, ref!)).toBe(true);
    expect(fits({ width: 390, height: 844 }, ref!)).toBe(false);
    expect(reference([])).toBeNull();
  });

  it('median', () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
});
