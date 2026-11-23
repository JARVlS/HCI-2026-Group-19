import { useEffect, useRef } from 'react';
import { GROUP_WHAT, GROUPS, LEGEND, NEVER_LOGGED, type EventType } from './legend';

const TYPES = Object.keys(LEGEND) as EventType[];

/** "what is logged": every event type by group with one sentence, and what is never logged. A modal <dialog>: Esc closes it. */
export function Legend({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog ref={ref} className="l-sheet" onClose={onClose} aria-labelledby="l-legend-title">
      <div className="l-sheet-head">
        <h2 id="l-legend-title">what is logged</h2>
        <button className="l-btn" onClick={() => ref.current?.close()}>
          close
        </button>
      </div>
      <p>
        in live mode arbor logs what everyone on the live site does, with the texts (each cut to 8,000 characters; its <code>chars</code> field keeps the real
        length). the demo (<code>?demo=1</code>, scripted answers) logs nothing. every event also carries <code>visit</code> (one per page load),{' '}
        <code>seq</code> (its order in the visit), <code>design</code> and the chat it is about (<code>conversationId</code>); the backend adds the user, the
        user's condition and the server time. the catalogue is <code>frontend/src/lib/events.ts</code>.
      </p>
      <h3>never logged</h3>
      <ul className="l-never">
        {NEVER_LOGGED.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
      {GROUPS.map((g) => (
        <section key={g} className="l-legend-group">
          <h3 className={`l-g-${g.replace(' ', '-')}`}>
            {g} <span className="l-dim">· {GROUP_WHAT[g]}</span>
          </h3>
          <dl className="l-legend">
            {TYPES.filter((t) => LEGEND[t].group === g).map((t) => (
              <div key={t}>
                <dt>{t}</dt>
                <dd>
                  {LEGEND[t].what}
                  {LEGEND[t].noise && <span className="l-dim"> (noise: hidden at first)</span>}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </dialog>
  );
}
