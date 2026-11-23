import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiError } from '../lib/api';
import { forgetToken, keepToken, readToken, save, TABLES, tableCsv, visitsPage, type Table } from './client';
import { Legend } from './Legend';
import { Timeline } from './Timeline';
import { Visits } from './Visits';
import { visitKey, type AdminVisit } from './visit';

/**
 * The logs page (`logs.html`, served at /logs): the usage log for the study team. A token gate,
 * the visits, one visit's timeline, the legend of what is logged, and downloads. Not linked from
 * the app; members get the url. Everything goes through the backend's admin routes with the
 * admin token, which stays in this tab's sessionStorage.
 */

/** Show a failure: a 403 means the token is wrong, so back to the gate with the backend's message. */
export type Fail = (e: unknown, show: (message: string) => void) => void;

export function Logs() {
  const [token, setToken] = useState<string | null>(readToken);
  const [rejected, setRejected] = useState<string | null>(null);
  const reject = useCallback((message: string) => {
    forgetToken();
    setToken(null);
    setRejected(message);
  }, []);
  const forget = () => {
    forgetToken();
    setToken(null);
    setRejected(null);
  };
  if (!token) return <Gate rejected={rejected} onToken={setToken} />;
  return <Viewer token={token} onRejected={reject} onForget={forget} />;
}

function Gate({ rejected, onToken }: { rejected: string | null; onToken: (token: string) => void }) {
  const [value, setValue] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (value.trim()) onToken(value.trim());
  };
  return (
    <main className="l-gate">
      <h1>arbor logs</h1>
      <p className="l-dim">what people did on the live site, for the study team.</p>
      <form onSubmit={submit} className="l-gate-form">
        <label>
          admin token
          <input className="l-input" type="password" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" autoFocus />
        </label>
        <button className="l-btn" type="submit" disabled={!value.trim()}>
          open
        </button>
      </form>
      {rejected && (
        <p className="l-error" role="alert">
          token refused: {rejected}
        </p>
      )}
      <p className="l-dim">the token stays in this tab (sessionStorage): gone when you close it, never in the url.</p>
    </main>
  );
}

interface ListState {
  visits: AdminVisit[];
  next: string | null;
  loading: boolean;
  error: string | null;
  /** The cursor of the load that runs or failed (null: the newest page), for retry. */
  last: string | null;
}

function Viewer({ token, onRejected, onForget }: { token: string; onRejected: (message: string) => void; onForget: () => void }) {
  const [list, setList] = useState<ListState>({ visits: [], next: null, loading: true, error: null, last: null });
  const [selected, setSelected] = useState<AdminVisit | null>(null);
  const [legend, setLegend] = useState(false);

  const fail = useCallback<Fail>(
    (e, show) => {
      if (e instanceof ApiError && e.status === 403) onRejected(e.message);
      else show(e instanceof Error ? e.message : String(e));
    },
    [onRejected],
  );

  /** The newest page (before = null) replaces the list; an older page is added below it. */
  const load = useCallback(
    async (before: string | null) => {
      setList((l) => ({ ...l, loading: true, error: null, last: before }));
      try {
        const page = await visitsPage(token, before);
        keepToken(token); // it works: keep it for this tab
        setList((l) => {
          const known = new Set(before ? l.visits.map(visitKey) : []);
          const visits = before ? [...l.visits, ...page.items.filter((v) => !known.has(visitKey(v)))] : page.items;
          return { visits, next: page.next, loading: false, error: null, last: before };
        });
      } catch (e) {
        fail(e, (error) => setList((l) => ({ ...l, loading: false, error })));
      }
    },
    [token, fail],
  );
  useEffect(() => {
    void load(null);
  }, [load]);

  return (
    <div className="l-app">
      <header className="l-top">
        <h1>arbor logs</h1>
        <span className="l-top-actions">
          <button className="l-btn" onClick={() => setLegend(true)}>
            what is logged
          </button>
          <button className="l-btn" onClick={onForget}>
            forget token
          </button>
        </span>
      </header>
      <div className="l-main">
        <section className="l-side" aria-label="visits">
          <Visits {...list} selected={selected} onSelect={setSelected} onReload={() => void load(null)} onOlder={() => void load(list.next)} onRetry={() => void load(list.last)} />
          <Downloads token={token} fail={fail} />
        </section>
        <section className="l-detail" aria-label="timeline">
          {selected ? (
            <Timeline key={visitKey(selected)} token={token} visit={selected} fail={fail} />
          ) : (
            <p className="l-dim l-pad">pick a visit to see what happened in it, in order.</p>
          )}
        </section>
      </div>
      {legend && <Legend onClose={() => setLegend(false)} />}
    </div>
  );
}

/** Whole tables as CSV, through the existing export route (with the token, so not a plain link). */
function Downloads({ token, fail }: { token: string; fail: Fail }) {
  const [busy, setBusy] = useState<Table | null>(null);
  const [error, setError] = useState<string | null>(null);
  const download = async (table: Table) => {
    setBusy(table);
    setError(null);
    try {
      save(await tableCsv(token, table), `arbor-${table}.csv`);
    } catch (e) {
      fail(e, (message) => setError(`${table}.csv: ${message}`));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="l-downloads">
      <h2>whole tables (csv)</h2>
      <p>
        {TABLES.map((t) => (
          <button key={t} className="l-btn" onClick={() => void download(t)} disabled={busy !== null}>
            {busy === t ? `${t}…` : t}
          </button>
        ))}
      </p>
      {error && (
        <p className="l-error" role="alert">
          {error}
        </p>
      )}
      <p className="l-dim">
        all users, ordered by time; <code>payload_json</code> holds each event's payload. columns: backend/docs/api.md.
      </p>
    </div>
  );
}
