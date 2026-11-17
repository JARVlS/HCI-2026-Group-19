import { useEffect, useRef, useState } from 'react';
import type { RoleCheck, TestReport } from '../../ai/own/provider';
import { PRESETS, PRESET_IDS, ROLES, canScore, connectionOf, kindOf, type Connection, type OwnSetup, type PresetId, type Role } from '../../ai/own/setup';
import { pct } from '../../lib/modes';
import { useStore } from '../../lib/store';
import { Check, Radios, lowerProse, useUi } from './ui';

/*
 * Settings → model (IMPLEMENTATION_PLAN.md M7): where the model calls go when answers come from
 * "own model". One connection per role (chat, analysis, scores), presets that fill the base URL
 * and a suggested model, keys that stay on this device, and test connection.
 */

type Choice = PresetId | 'same' | 'off';

const ROLE_DESC: Record<Role, string> = {
  chat: 'the tutor’s reply, streamed.',
  analysis: 'who did the thinking, and which concepts grow on the tree. needs json output.',
  scores: 'the fast thought-along and is-it-right percent. needs token probabilities, which claude does not give.',
};

const KEY_HINT =
  'kept in this tab (sessionStorage) until you close it, or in this browser (localStorage) with “remember on this device”. sent only to this endpoint: never to arbor, never saved with your chats.';

const choiceOf = (r: OwnSetup[Role]): Choice => (typeof r === 'string' ? r : r.preset);

function options(role: Role): { v: Choice; label: string }[] {
  const presets = PRESET_IDS.filter((p) => role !== 'scores' || PRESETS[p].kind !== 'anthropic');
  const extra: Choice[] = role === 'chat' ? [] : role === 'analysis' ? ['same'] : ['same', 'off'];
  return [...extra, ...presets].map((v) => ({ v, label: v === 'same' ? 'same as chat' : v === 'off' ? 'off' : PRESETS[v].label }));
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function ModelSheet() {
  const { state, dispatch } = useStore();
  const { sheet, setSheet } = useUi();
  const open = sheet === 'model';
  const first = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => first.current?.focus());
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setSheet(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, setSheet]);

  if (!open) return null;
  const s = state.settings;
  const setup = s.own;
  const set = (patch: Partial<OwnSetup>) => dispatch({ type: 'settings', patch: { own: { ...setup, ...patch } } });
  const close = () => setSheet(null);

  return (
    <div className="a-sheet-back" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="a-sheet a-model" role="dialog" aria-modal="true" aria-labelledby="a-model-title">
        <header className="a-sheet-head">
          <h2 id="a-model-title">your own model</h2>
          <span className="a-dim">settings → answers → own model</span>
          <button ref={first} className="a-icon" onClick={close} aria-label="Close" title="close  esc">
            ×
          </button>
        </header>
        <p className="a-model-intro a-dim">
          your chats are saved on the arbor backend, as with live. every model call goes from this browser straight to the endpoint you set here. your keys stay
          on this device.
        </p>
        <p className="a-model-intro">
          {s.provider === 'own' ? (
            <span className="a-dim">answers come from your own model now.</span>
          ) : (
            <>
              <span className="a-dim">answers come from {s.provider === 'arbor' ? 'live claude' : 'the demo script'} now. </span>
              <button className="a-btn" onClick={() => dispatch({ type: 'settings', patch: { provider: 'own' } })}>
                use your own model
              </button>
            </>
          )}
        </p>
        {ROLES.map((role) => (
          <RoleSetup key={role} role={role} setup={setup} set={set} />
        ))}
        <Keys />
        <TestConnection setup={setup} />
      </div>
    </div>
  );
}

function RoleSetup({ role, setup, set }: { role: Role; setup: OwnSetup; set: (patch: Partial<OwnSetup>) => void }) {
  const r = setup[role];
  const choice = choiceOf(r);
  const pick = (v: Choice) => {
    if (v !== choice) set({ [role]: v === 'same' || v === 'off' ? v : connectionOf(v) } as Partial<OwnSetup>);
  };
  const conn = typeof r === 'string' ? null : r;
  return (
    <section className="a-model-role" aria-label={role}>
      <div className="a-set">
        <span className="a-set-k">{role}</span>
        <Radios<Choice> label={`${role}: where the calls go`} value={choice} onChange={pick} options={options(role)} />
      </div>
      <p className="a-set-desc a-dim">{ROLE_DESC[role]}</p>
      {role === 'scores' && r === 'same' && !canScore(setup.chat) && (
        <p className="a-set-desc">
          <span className="a-fail-mark">!</span> the chat uses anthropic, which cannot give scores: pick off, the group backend or another endpoint.
        </p>
      )}
      {conn && kindOf(conn) === 'arbor' && <p className="a-set-desc a-dim">the group’s backend picks the model and counts the group’s token budget.</p>}
      {conn && kindOf(conn) !== 'arbor' && <Fields key={conn.preset} role={role} conn={conn} onChange={(c) => set({ [role]: c } as Partial<OwnSetup>)} />}
    </section>
  );
}

function Fields({ role, conn, onChange }: { role: Role; conn: Connection; onChange: (c: Connection) => void }) {
  const { own } = useStore();
  const [models, setModels] = useState<string[] | null>(null);
  const [listing, setListing] = useState<'idle' | 'busy' | { error: string }>('idle');
  const preset = PRESETS[conn.preset];
  const listId = `a-models-${role}`;

  const list = async () => {
    setListing('busy');
    try {
      const found = await own.models(role);
      setModels(found);
      setListing(found.length ? 'idle' : { error: 'the endpoint listed no models.' });
    } catch (e) {
      setListing({ error: message(e) });
    }
  };

  const id = (field: string) => `a-${role}-${field}`;
  return (
    // A form so the browser knows the key field belongs to this endpoint; nothing is submitted.
    <form className="a-fields" onSubmit={(e) => e.preventDefault()}>
      <div className="a-form-row">
        <label className="a-set-k" htmlFor={id('url')}>
          base url
        </label>
        <input id={id('url')} value={conn.baseUrl} onChange={(e) => onChange({ ...conn, baseUrl: e.target.value })} spellCheck={false} placeholder="https://…/v1" />
      </div>
      <div className="a-form-row">
        <label className="a-set-k" htmlFor={id('key')}>
          key
        </label>
        <input
          id={id('key')}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={own.keys[role] ?? ''}
          onChange={(e) => own.setKey(role, e.target.value)}
          placeholder={preset.needsKey ? 'your api key' : 'none needed, unless your server asks for one'}
        />
        <span className="a-dim a-hint" title={KEY_HINT}>
          ?
        </span>
      </div>
      <div className="a-form-row">
        <label className="a-set-k" htmlFor={id('model')}>
          model
        </label>
        <input id={id('model')} list={listId} value={conn.model} onChange={(e) => onChange({ ...conn, model: e.target.value })} spellCheck={false} placeholder="model id" />
        <button type="button" className="a-btn" onClick={list} disabled={listing === 'busy'} title="ask the endpoint for its models (GET /models)">
          list
        </button>
      </div>
      {models && (
        <datalist id={listId}>
          {models.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      )}
      {listing === 'busy' && <p className="a-dim">asking for the models…</p>}
      {models && models.length > 0 && listing === 'idle' && (
        <p className="a-dim">
          {models.length} models: clear the model field to see them all, or type to filter.
        </p>
      )}
      {typeof listing === 'object' && (
        <p>
          <span className="a-fail-mark">!</span> <span className="a-dim">{lowerProse(listing.error)}</span>
        </p>
      )}
    </form>
  );
}

function Keys() {
  const { own } = useStore();
  return (
    <section className="a-model-role">
      <div className="a-set">
        <span className="a-set-k">keys</span>
        <span>
          <Check checked={own.remember} onChange={own.setRemember}>
            remember on this device
          </Check>
        </span>
      </div>
      <p className="a-set-desc a-dim">
        {own.remember
          ? 'kept in this browser until you untick this. anyone who uses this browser profile can use them.'
          : 'kept in this tab only, gone when you close it.'}{' '}
        never sent to arbor, never saved with your chats.
      </p>
    </section>
  );
}

function TestConnection({ setup }: { setup: OwnSetup }) {
  const { own } = useStore();
  const [report, setReport] = useState<TestReport | 'running' | null>(null);
  const running = useRef<AbortController | null>(null);

  // A changed setup or key makes the last result stale.
  useEffect(() => setReport(null), [setup, own.keys]);
  useEffect(() => () => running.current?.abort(), []);

  const run = async () => {
    running.current?.abort();
    const c = new AbortController();
    running.current = c;
    setReport('running');
    const r = await own.test(c.signal);
    if (!c.signal.aborted) setReport(r);
  };

  return (
    <section className="a-model-test">
      <p className="a-pop-actions">
        <button className="a-btn" onClick={run} disabled={report === 'running'}>
          test connection
        </button>
        <span className="a-dim">one tiny call per role: a reply, a json answer, a score.</span>
      </p>
      {report === 'running' && <p className="a-dim">testing…</p>}
      {report && report !== 'running' && (
        <ul className="a-model-checks" aria-label="Test results">
          {ROLES.map((role) => (
            <li key={role} className="a-set">
              <span className="a-set-k">{role}</span>
              <CheckLine check={report[role]} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const seconds = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

function CheckLine({ check }: { check: RoleCheck }) {
  if (check.status === 'skipped')
    return <span className="a-dim">{check.why === 'off' ? 'off: messages keep the analysis’s numbers.' : 'group backend: nothing to test here.'}</span>;
  if (check.status === 'failed')
    return (
      <span>
        <span className="a-fail-mark">!</span> {lowerProse(check.error)}
      </span>
    );
  return (
    <span>
      works · {check.model} · {seconds(check.ms)}
      {check.mode === 'schema' && ' · json schema'}
      {check.mode === 'prompt' && ' · prompt mode: no json schema support here, so the schema goes into the prompt and each answer is checked'}
      {check.p !== undefined && ` · rated a right statement ${pct(check.p)}% right`}
    </span>
  );
}
