import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { formatHash, type View } from '../lib/nav';
import { chains, fits, hoverStats, pointsOf, radialStats, reference, transitions, type ClickPoint } from './heat';
import type { AdminEvent } from './visit';

/**
 * The heatmap of the logs page: where people clicked (orange) and where they rested the pointer
 * on something that reacts to hover (blue), with thin lines from each click to the next one when
 * it came within the threshold. Drawn in the window size most points were recorded in; points
 * from windows far off that size are left out of the drawing (and counted), not of the tables.
 * Behind it, on request, the app itself as the demo shows it, so the parts of the page can be
 * told apart. The pure parts are `heat.ts`.
 *
 * The backdrop is the app at `?demo=1`: the scripted demo, which sends nothing and saves nothing.
 * Its sandbox keeps the origin (without it the browser refuses the app's own module scripts), so it
 * could read this site's storage, but the demo writes none of it (checked in the browser on
 * 24 Nov 2026: localStorage the same before and after); it cannot navigate this page or open windows.
 */

/** Views the backdrop can show (the demo opens them from the URL hash, `lib/nav.ts`). */
const VIEWS = ['chat', 'chats', 'forest', 'concepts', 'settings'] as const;
const MAX_S = 10;

interface Options {
  clicks: boolean;
  hovers: boolean;
  lines: boolean;
  /** The threshold for lines, in seconds. */
  maxS: number;
  noTyping: boolean;
  view: string;
  pointer: string;
  condition: string;
  backdrop: boolean;
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const pct = (x: number) => `${Math.round(x * 100)}%`;

/** A colour from logs.css, so the drawing follows the light and the dark theme. */
const cssVar = (name: string, fallback: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

export function Heatmap({ events }: { events: readonly AdminEvent[] }) {
  const data = useMemo(() => pointsOf(events), [events]);
  const [o, setO] = useState<Options>({ clicks: true, hovers: true, lines: true, maxS: 5, noTyping: false, view: 'all', pointer: 'all', condition: 'all', backdrop: true });
  const set = (patch: Partial<Options>) => setO((prev) => ({ ...prev, ...patch }));

  const views = useMemo(() => [...new Set([...data.clicks, ...data.hovers].map((p) => p.view))].sort(), [data]);
  const pointers = useMemo(() => [...new Set(data.clicks.map((c) => c.pointer))].sort(), [data]);
  const conditions = useMemo(() => [...new Set([...data.clicks, ...data.hovers].map((p) => p.condition ?? 'none'))].sort(), [data]);

  const keep = (p: { view: string; condition: string | null }) => (o.view === 'all' || p.view === o.view) && (o.condition === 'all' || (p.condition ?? 'none') === o.condition);
  const clicks = data.clicks.filter((c) => keep(c) && (o.pointer === 'all' || c.pointer === o.pointer));
  const hovers = data.hovers.filter(keep);
  const kept = new Set(clicks.map((c) => c.id));
  // Chains are read in the order things happened (all clicks), then kept when both ends pass the filters.
  const linked = chains(data.clicks, o.maxS * 1000, o.noTyping).filter((c) => kept.has(c.from.id) && kept.has(c.to.id));

  const placed = hovers.filter((h): h is typeof h & { x: number; y: number; width: number; height: number } => h.x !== null && h.y !== null && h.width !== null && h.height !== null);
  const ref = reference([...clicks, ...placed]);
  const drawnClicks = ref ? clicks.filter((c) => fits(c, ref)) : [];
  const drawnHovers = ref ? placed.filter((h) => fits(h, ref)) : [];
  const drawn = new Set(drawnClicks.map((c) => c.id));
  const drawnLines = linked.filter((c) => drawn.has(c.from.id) && drawn.has(c.to.id));
  const left = clicks.length + placed.length - drawnClicks.length - drawnHovers.length;

  const canvas = useRef<HTMLCanvasElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [near, setNear] = useState<ClickPoint | null>(null);

  // The frame's width decides the scale of the drawing and of the backdrop.
  useEffect(() => {
    const el = frame.current;
    if (!el || !ref) return;
    const fit = () => setScale(Math.min(1, el.clientWidth / ref.width));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref?.width, ref]);

  useEffect(() => {
    const c = canvas.current;
    if (!c || !ref) return;
    const dpr = globalThis.devicePixelRatio || 1;
    c.width = ref.width * dpr;
    c.height = ref.height * dpr;
    const g = c.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, ref.width, ref.height);
    const clickColour = cssVar('--heat-click', '#d9480f');
    const hoverColour = cssVar('--heat-hover', '#1c7ed6');
    const blob = (x: number, y: number, r: number, colour: string, alpha: number) => {
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, colour);
      grad.addColorStop(1, 'transparent');
      g.globalAlpha = alpha;
      g.fillStyle = grad;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    };
    if (o.hovers) for (const h of drawnHovers) blob(h.x, h.y, Math.min(40, 8 + Math.sqrt(h.ms) / 2), hoverColour, 0.3);
    if (o.clicks) for (const p of drawnClicks) blob(p.x, p.y, 16, clickColour, 0.4);
    if (o.lines) {
      g.globalAlpha = 0.55;
      g.strokeStyle = clickColour;
      g.fillStyle = clickColour;
      g.lineWidth = 1;
      for (const { from, to } of drawnLines) {
        g.beginPath();
        g.moveTo(from.x, from.y);
        g.lineTo(to.x, to.y);
        g.stroke();
        g.beginPath();
        g.arc(to.x, to.y, 2.5, 0, Math.PI * 2);
        g.fill();
      }
    }
    if (o.clicks) {
      g.globalAlpha = 0.9;
      g.fillStyle = clickColour;
      for (const p of drawnClicks) g.fillRect(p.x - 1, p.y - 1, 2, 2);
    }
    if (near) {
      g.globalAlpha = 1;
      g.strokeStyle = cssVar('--text', '#1c1b18');
      g.lineWidth = 1.5;
      g.beginPath();
      g.arc(near.x, near.y, 7, 0, Math.PI * 2);
      g.stroke();
    }
    g.globalAlpha = 1;
  });

  const point = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / scale;
    const y = (e.clientY - r.top) / scale;
    let best: ClickPoint | null = null;
    let dist = 12 / scale;
    for (const p of drawnClicks) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < dist) [best, dist] = [p, d];
    }
    setNear(best);
  };

  const flows = transitions(linked);
  const hoverRows = hoverStats(hovers, clicks);
  const radial = radialStats(hovers, data.picks);
  const shown = o.view !== 'all' && (VIEWS as readonly string[]).includes(o.view) ? o.view : 'chat';
  const backdrop = `${import.meta.env.BASE_URL}?demo=1&intro=0&design=ascii${formatHash({ kind: shown } as View)}`;

  if (!data.clicks.length && !data.hovers.length)
    return <p className="l-dim">no clicks or hovers here: they are logged since 24 nov 2026, in live mode.</p>;

  return (
    <div className="l-heat">
      <div className="l-filters">
        <label className="l-check">
          <input type="checkbox" checked={o.clicks} onChange={(e) => set({ clicks: e.target.checked })} />
          <span className="l-heat-key l-heat-click" /> clicks ({clicks.length})
        </label>
        <label className="l-check">
          <input type="checkbox" checked={o.hovers} onChange={(e) => set({ hovers: e.target.checked })} />
          <span className="l-heat-key l-heat-hover" /> hovers ({hovers.length})
        </label>
        <label className="l-check">
          <input type="checkbox" checked={o.lines} onChange={(e) => set({ lines: e.target.checked })} />
          lines ({linked.length})
        </label>
        <label className="l-check">
          within
          <input type="range" min={0.5} max={MAX_S} step={0.5} value={o.maxS} onChange={(e) => set({ maxS: Number(e.target.value) })} aria-label="longest gap between linked clicks, seconds" />
          {o.maxS.toFixed(1)} s
        </label>
        <label className="l-check">
          <input type="checkbox" checked={o.noTyping} onChange={(e) => set({ noTyping: e.target.checked })} />
          no typing between
        </label>
      </div>
      <div className="l-filters">
        <select className="l-input" value={o.view} onChange={(e) => set({ view: e.target.value })} aria-label="view">
          <option value="all">all views</option>
          {views.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
        {pointers.length > 1 && (
          <select className="l-input" value={o.pointer} onChange={(e) => set({ pointer: e.target.value })} aria-label="pointer">
            <option value="all">mouse and touch</option>
            {pointers.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        )}
        {conditions.length > 1 && (
          <select className="l-input" value={o.condition} onChange={(e) => set({ condition: e.target.value })} aria-label="condition">
            <option value="all">all conditions</option>
            {conditions.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        )}
        <label className="l-check">
          <input type="checkbox" checked={o.backdrop} onChange={(e) => set({ backdrop: e.target.checked })} />
          the app behind (demo, {shown} view)
        </label>
      </div>
      {ref && (
        <>
          <p className="l-dim" role="status">
            drawn in a {ref.width}×{ref.height} window{left > 0 ? ` · ${left} points from other window sizes left out of the drawing` : ''}
            {near ? ` · ${[near.region, near.target, near.view, near.sincePrev !== null ? `+${secs(near.sincePrev)}` : null, near.typed ? 'typed before' : null].filter(Boolean).join(' · ')}` : ' · point at a click for what it was'}
          </p>
          <div ref={frame} className="l-heat-frame" style={{ height: ref.height * scale }}>
            {o.backdrop && (
              <iframe
                className="l-heat-back"
                title="the app in the demo, behind the heatmap"
                src={backdrop}
                sandbox="allow-scripts allow-same-origin"
                tabIndex={-1}
                aria-hidden="true"
                style={{ width: ref.width, height: ref.height, transform: `scale(${scale})` }}
              />
            )}
            <canvas ref={canvas} className="l-heat-canvas" style={{ width: ref.width * scale, height: ref.height * scale }} onPointerMove={point} onPointerLeave={() => setNear(null)} />
          </div>
        </>
      )}
      <div className="l-heat-tables">
        <Table
          title="from part to part"
          note={`clicks within ${o.maxS.toFixed(1)} s, most frequent first`}
          head={['from', 'to', 'times', 'median']}
          rows={flows.map((t) => [t.from, t.to, String(t.count), secs(t.median)])}
        />
        <Table
          title="hovers"
          note="how long the pointer stayed; clicked: a click while it was there"
          head={['on', 'times', 'median', 'total', 'clicked']}
          rows={hoverRows.map((h) => [h.name, String(h.count), secs(h.median), secs(h.total), pct(h.clicked)])}
        />
        <Table
          title="radial menu"
          note="options pointed at before letting go; chosen: the last one when the menu went somewhere"
          head={['option', 'pointed', 'median', 'chosen']}
          rows={radial.map((r) => [r.option, String(r.pointed), secs(r.median), String(r.chosen)])}
        />
      </div>
    </div>
  );
}

function Table({ title, note, head, rows }: { title: string; note: string; head: string[]; rows: string[][] }) {
  return (
    <section className="l-heat-table">
      <h3>{title}</h3>
      <p className="l-dim">{note}</p>
      {rows.length ? (
        <table>
          <thead>
            <tr>
              {head.map((h) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {r.map((cell, j) => (
                  <td key={j}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="l-dim">none yet.</p>
      )}
    </section>
  );
}
