import { useState } from 'react';
import { lasted, localTime, matchesUser, visitKey, who, type AdminVisit } from './visit';

interface Props {
  visits: AdminVisit[];
  next: string | null;
  loading: boolean;
  error: string | null;
  selected: AdminVisit | null;
  onSelect: (v: AdminVisit) => void;
  onReload: () => void;
  onOlder: () => void;
  onRetry: () => void;
}

/** The visits, newest first, with a filter over the loaded ones and "load older". A failed load says so, never shows an empty list. */
export function Visits({ visits, next, loading, error, selected, onSelect, onReload, onOlder, onRetry }: Props) {
  const [query, setQuery] = useState('');
  const shown = visits.filter((v) => matchesUser(v, query));
  const current = selected && visitKey(selected);
  return (
    <div className="l-visits">
      <div className="l-visits-head">
        <h2>visits</h2>
        <span className="l-dim">{visits.length ? `${visits.length}${next ? '+' : ''} loaded` : ''}</span>
        <button className="l-btn" onClick={onReload} disabled={loading}>
          newest
        </button>
      </div>
      <input
        className="l-input"
        type="search"
        placeholder="filter by user: name, participant or user id"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="filter visits by user"
      />
      {query && next && <p className="l-dim">the filter looks only at the loaded visits: load older ones to search further.</p>}
      <ol className="l-visit-list">
        {shown.map((v) => {
          const { name, guest } = who(v);
          const key = visitKey(v);
          return (
            <li key={key}>
              <button className={`l-visit${key === current ? ' on' : ''}`} onClick={() => onSelect(v)} aria-current={key === current}>
                <span className="l-visit-when">{localTime(v.first)}</span>
                <span className="l-visit-long">{lasted(v)}</span>
                <span className="l-visit-who">
                  {name}
                  {guest && <span className="l-dim"> · guest</span>}
                </span>
                <span className="l-visit-meta l-dim">
                  {[v.condition && `cond ${v.condition}`, v.design, `${v.events} ev`, `${v.turns} ${v.turns === 1 ? 'turn' : 'turns'}`, v.visit === null && 'no visit id'].filter(Boolean).join(' · ')}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      {error && (
        <p className="l-error" role="alert">
          could not load the visits: {error}{' '}
          <button className="l-btn" onClick={onRetry}>
            retry
          </button>
        </p>
      )}
      {loading && <p className="l-dim">loading visits…</p>}
      {!loading && !error && !visits.length && <p className="l-dim">no visits yet: nothing was logged.</p>}
      {!loading && !error && visits.length > 0 && query && !shown.length && <p className="l-dim">no loaded visit matches.</p>}
      {next && !loading && !error && (
        <button className="l-btn" onClick={onOlder}>
          load older
        </button>
      )}
    </div>
  );
}
