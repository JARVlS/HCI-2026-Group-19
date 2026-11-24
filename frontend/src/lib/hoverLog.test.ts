import { describe, expect, it } from 'vitest';
import type { HoverName, UsageEvent } from './events';
import { HOVER_MIN_MS, HoverClock } from './hoverLog';
import type { ViewKind } from './nav';

/** How long the pointer stays on hover-driven places (`hover`). */
function setup() {
  let t = 0;
  let view: ViewKind = 'chat';
  const events: UsageEvent[] = [];
  const at = { x: 10.4, y: 20.6 };
  const clock = new HoverClock({ track: (e) => events.push(e), pointer: () => at, view: () => view, now: () => t });
  return {
    clock,
    events,
    at,
    pass: (ms: number) => (t += ms),
    setView: (v: ViewKind) => (view = v),
    payloads: () => events.map((e) => e.payload as { name: HoverName; id: string | null; ms: number }),
  };
}

describe('hover durations', () => {
  it(`a stay of ${HOVER_MIN_MS} ms or more is logged when the pointer leaves, with where and in which view it began`, () => {
    const h = setup();
    h.clock.set('message', 'm1');
    h.setView('forest');
    h.pass(HOVER_MIN_MS + 200);
    h.clock.set('message', null);
    expect(h.events).toEqual([{ type: 'hover', payload: { name: 'message', id: 'm1', ms: HOVER_MIN_MS + 200, x: 10, y: 21, view: 'chat' } }]);
  });

  it('a shorter stay is the pointer passing by: not logged', () => {
    const h = setup();
    h.clock.set('leaf', 'c1');
    h.pass(HOVER_MIN_MS - 1);
    h.clock.set('leaf', null);
    expect(h.events).toEqual([]);
  });

  it('moving to another place of the same name ends the first stay; the same id again changes nothing', () => {
    const h = setup();
    h.clock.set('leaf', 'c1');
    h.pass(500);
    h.clock.set('leaf', 'c1');
    h.pass(500);
    h.clock.set('leaf', 'c2');
    h.pass(400);
    h.clock.set('leaf', null);
    expect(h.payloads().map((p) => [p.id, p.ms])).toEqual([
      ['c1', 1000],
      ['c2', 400],
    ]);
  });

  it('names are independent: a leaf ending does not end a message', () => {
    const h = setup();
    h.clock.set('message', 'm1');
    h.clock.set('leaf', 'c1');
    h.pass(400);
    h.clock.set('leaf', null);
    h.pass(400);
    h.clock.set('message', null);
    expect(h.payloads().map((p) => [p.name, p.ms])).toEqual([
      ['leaf', 400],
      ['message', 800],
    ]);
  });

  it('every radial option counts, however briefly', () => {
    const h = setup();
    h.clock.set('radial', 'forest');
    h.pass(40);
    h.clock.set('radial', 'tree');
    h.pass(0);
    h.clock.set('radial', null);
    expect(h.payloads().map((p) => [p.id, p.ms])).toEqual([
      ['forest', 40],
      ['tree', 0],
    ]);
  });

  it('endAll (page hidden) ends every stay; no pointer yet means no position', () => {
    let t = 0;
    const events: UsageEvent[] = [];
    const clock = new HoverClock({ track: (e) => events.push(e), pointer: () => null, view: () => 'chat', now: () => t });
    clock.set('word', '0:4');
    clock.set('line', 'line');
    t = 1000;
    clock.endAll();
    clock.endAll();
    expect(events.map((e) => e.payload)).toEqual([
      { name: 'word', id: '0:4', ms: 1000, x: null, y: null, view: 'chat' },
      { name: 'line', id: 'line', ms: 1000, x: null, y: null, view: 'chat' },
    ]);
  });
});
