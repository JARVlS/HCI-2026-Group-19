import { useEffect, useMemo, useState } from 'react';
import { save, visitEvents } from './client';
import { GROUPS, groupOf, isNoise, type Group } from './legend';
import type { Fail } from './Logs';
import { summarize, type Summary } from './summary';
import { Heatmap } from './Heatmap';
import { clock, facts, haystackOf, inOrder, lasted, localTime, passes, who, type AdminEvent, type AdminVisit, type Filter } from './visit';

interface Row {
  e: AdminEvent;
  at: number;
  group: Group;
  summary: Summary;
  haystack: string;
}

const ALL_GROUPS: Group[] = [...GROUPS, 'other'];

/** One visit: its header, filters, and every event in order. Loads all its events page by page first, with a running count. */
export function Timeline({ token, visit, fail }: { token: string; visit: AdminVisit; fail: Fail }) {
  const [events, setEvents] = useState<AdminEvent[] | null>(null);
  const [loaded, setLoaded] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [tab, setTab] = useState<'events' | 'heatmap'>('events');

  useEffect(() => {
    const abort = new AbortController();
    setEvents(null);
    setError(null);
    setLoaded(0);
    visitEvents(token, visit, setLoaded, abort.signal).then(
      (all) => setEvents(inOrder(all)),
      (e) => {
        if (!abort.signal.aborted) fail(e, setError);
      },
    );
    return () => abort.abort();
  }, [token, visit, fail, attempt]);

  const { name, guest } = who(visit);
  const title = (
    <header className="l-detail-head">
      <h2>
        {name}
        {guest && <span className="l-dim"> · guest</span>}
      </h2>
      <p className="l-dim">
        {[localTime(visit.first), lasted(visit), visit.condition && `condition ${visit.condition}`, visit.design, `${visit.events} events`, `user ${visit.userId}`, visit.visit ? `visit ${visit.visit}` : 'events without a visit id']
          .filter(Boolean)
          .join(' · ')}
      </p>
    </header>
  );
  if (error)
    return (
      <div className="l-pad">
        {title}
        <p className="l-error" role="alert">
          could not load the events: {error}{' '}
          <button className="l-btn" onClick={() => setAttempt((n) => n + 1)}>
            retry
          </button>
        </p>
      </div>
    );
  if (!events)
    return (
      <div className="l-pad">
        {title}
        <p className="l-dim" role="status">
          loading events… {loaded} of {visit.events}
        </p>
      </div>
    );
  return (
    <div className="l-pad">
      {title}
      <p className="l-tabs" role="group" aria-label="show">
        <button className={`l-chip${tab === 'events' ? ' on' : ''}`} aria-pressed={tab === 'events'} onClick={() => setTab('events')}>
          events
        </button>
        <button className={`l-chip${tab === 'heatmap' ? ' on' : ''}`} aria-pressed={tab === 'heatmap'} onClick={() => setTab('heatmap')}>
          heatmap
        </button>
      </p>
      {tab === 'events' ? <Events visit={visit} events={events} /> : <Heatmap events={events} />}
    </div>
  );
}

function Events({ visit, events }: { visit: AdminVisit; events: AdminEvent[] }) {
  const rows = useMemo<Row[]>(() => {
    const start = events.reduce((min, e) => Math.min(min, Date.parse(e.clientTs)), Infinity);
    return events.map((e) => ({ e, at: Date.parse(e.clientTs) - start, group: groupOf(e.type), summary: summarize(e), haystack: haystackOf(e) }));
  }, [events]);
  const [filter, setFilter] = useState<Filter>({ groups: new Set(ALL_GROUPS), type: '', query: '', hideNoise: true });
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const set = (patch: Partial<Filter>) => setFilter((f) => ({ ...f, ...patch }));
  const toggleGroup = (g: Group) => {
    const groups = new Set(filter.groups);
    if (!groups.delete(g)) groups.add(g);
    set({ groups });
  };
  const toggleRow = (id: string) =>
    setOpen((o) => {
      const next = new Set(o);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const shown = rows.filter((r) => passes(r.e, r.haystack, filter));
  const typeCounts = countBy(rows, (r) => r.e.type);
  const groupCounts = countBy(rows, (r) => r.group);
  const noise = rows.filter((r) => isNoise(r.e.type)).length;
  const byType = filter.type !== '';

  const download = () =>
    save(
      new Blob([JSON.stringify({ visit, events }, null, 2)], { type: 'application/json' }),
      `arbor-visit-${(visit.visit ?? 'none').slice(0, 8)}-${visit.userId.slice(0, 8)}.json`,
    );

  return (
    <>
      <dl className="l-facts">
        {facts(events).map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <p>
        <button className="l-btn" onClick={download}>
          this visit (json)
        </button>
      </p>
      <div className="l-filters">
        <span className={byType ? 'l-off' : undefined} title={byType ? 'a type is picked: groups and the noise switch do not apply' : undefined}>
          {ALL_GROUPS.filter((g) => groupCounts.has(g)).map((g) => (
            <button key={g} className={`l-chip l-g-${g.replace(' ', '-')}${filter.groups.has(g) ? ' on' : ''}`} aria-pressed={filter.groups.has(g)} onClick={() => toggleGroup(g)} disabled={byType}>
              {g} {groupCounts.get(g)}
            </button>
          ))}
          <label className="l-check">
            <input type="checkbox" checked={filter.hideNoise} onChange={(e) => set({ hideNoise: e.target.checked })} disabled={byType} />
            hide noise ({noise})
          </label>
        </span>
        <select className="l-input" value={filter.type} onChange={(e) => set({ type: e.target.value })} aria-label="event type">
          <option value="">all types</option>
          {[...typeCounts].sort(([a], [b]) => a.localeCompare(b)).map(([t, n]) => (
            <option key={t} value={t}>
              {t} ({n})
            </option>
          ))}
        </select>
        <input className="l-input" type="search" placeholder="search the payloads" value={filter.query} onChange={(e) => set({ query: e.target.value })} aria-label="search the payloads" />
      </div>
      <p className="l-dim" role="status">
        {shown.length} of {rows.length} events shown · click a row for its raw json
      </p>
      <ol className="l-events">
        {shown.map(({ e, at, group, summary }) => {
          const isOpen = open.has(e.id);
          return (
            <li key={e.id} className={`l-ev l-g-${group.replace(' ', '-')}`}>
              <button className="l-ev-head" onClick={() => toggleRow(e.id)} aria-expanded={isOpen}>
                <span className="l-ev-at">{clock(at)}</span>
                <span className="l-ev-type">{e.type}</span>
                <span className="l-ev-line">{summary.line}</span>
              </button>
              {summary.texts.map((t) => (
                <div key={t.label} className="l-text">
                  <span className="l-dim">{t.label}</span>
                  <p>{t.text}</p>
                </div>
              ))}
              {isOpen && <pre className="l-raw">{JSON.stringify(e, null, 2)}</pre>}
            </li>
          );
        })}
      </ol>
    </>
  );
}

function countBy<T, K>(items: T[], key: (item: T) => K): Map<K, number> {
  const out = new Map<K, number>();
  for (const item of items) out.set(key(item), (out.get(key(item)) ?? 0) + 1);
  return out;
}
