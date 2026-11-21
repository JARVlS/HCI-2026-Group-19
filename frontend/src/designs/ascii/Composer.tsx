import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { DraftLog } from '../../lib/draftLog';
import { draftGauge, sendMode, useDraftScore, useSteady, type DraftGauge, type DraftView } from '../../lib/draftScore';
import { cut, wordCount } from '../../lib/events';
import { useFilterView } from '../../lib/liveFilter';
import { MODE_META, pct } from '../../lib/modes';
import { useStore } from '../../lib/store';
import { useAccount } from '../../Welcome';
import type { Classification, Evidence, Mode, NudgeLevel, ProviderChoice, Theme } from '../../lib/types';
import { TIME_TICKS } from '../../lib/retention';
import { Diagnostics, Marked } from './Transcript';
import { G, K, lower, shortReason, useUi } from './ui';

/*
 * The prompt: a thought linter while you type, and a command line when you start with "/".
 * The linter never changes the layout while you type (ADR-14): the words it reacts to are
 * underlined in the text and explain themselves on hover, and the live score sits on one line of
 * fixed height above the prompt, so it moves up with the prompt as it grows and never jumps.
 */

/** What sending will do, in the words of the tree (feedforward). */
const AFTER: Record<Mode, string> = {
  own: 'its leaf grows in filled',
  together: 'its leaf grows half yours',
  ai: 'totally fine, just good to know',
};

/** Usage log: commands whose argument is not logged, although they take one (a confused user might paste a key after `/provider own`). */
const UNLOGGED_ARGS = new Set(['provider']);

export function Composer() {
  const { state, dispatch, send, stop, classifyDraft, busy, demoPrompts, messages, scoreDraft, filter, track } = useStore();
  const { focusPrompt, restOn } = useUi();
  const { enabled: arborOn, nudge } = state.settings;
  const lint = arborOn && nudge !== 'off';
  /** Predict → reveal: a delegating prompt's answer arrives veiled (no keyword match: the linter decides). */
  const willVeil = (mode: Mode) => mode === 'ai' && nudge === 'active' && !state.session.pendingQuiz;
  const [text, setText] = useState('');
  const [lens, setLens] = useState<{ text: string; c: Classification } | null>(null);
  /** The underlined word under the mouse: its evidence index and where to show its reason. */
  const [tip, setTip] = useState<{ i: number; x: number; y: number } | null>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState(0);
  const commands = useCommands();
  // The fast model rates the draft once typing pauses (live mode); the word rules decide until it has.
  const model = useDraftScore(lint ? scoreDraft : null, text, messages, track);
  // Live mode: the word filter rates every finished word at once, and moves the model's last number by the words since.
  const words = useFilterView(lint ? filter : null, text, messages, model.anchor?.text ?? null);
  // Usage log: how this draft came about (keys, pastes, time to send; abandoned drafts).
  const draftLog = useMemo(() => new DraftLog(track), [track]);
  useEffect(() => draftLog.change(text), [draftLog, text]);

  const isCmd = text.startsWith('/') && !text.includes('\n');
  const [word, ...rest] = isCmd ? text.slice(1).split(' ') : [''];
  const arg = rest.join(' ').trim();
  const menu = isCmd ? commands.filter((c) => (rest.length ? c.name === word.toLowerCase() : c.name.startsWith(word.toLowerCase()))) : [];

  // Live lens: classify while typing (debounced).
  useEffect(() => {
    const t = setTimeout(() => setLens(text.trim() && !text.startsWith('/') ? { text, c: classifyDraft(text) } : null), 140);
    return () => clearTimeout(t);
  }, [text, classifyDraft, state.session.pendingQuiz]);

  // Text pushed in from elsewhere (explain it back, concept sheet, …).
  useEffect(() => {
    if (!state.ui.draft.nonce) return;
    setText(state.ui.draft.text);
    focusPrompt();
  }, [state.ui.draft, focusPrompt]);

  useEffect(() => setSel(0), [word]);
  // Typing moves the words: the reason under the mouse waits for the next mouse move.
  useEffect(() => {
    setTip(null);
    restOn('word', null);
  }, [text, restOn]);

  // What the score line says; its label changes only once a new one held for two finished words.
  const lensGauge = lint && lens ? draftGauge(lens.c, model, words.view) : null;
  const steady = useSteady(words.step, lensGauge);
  const line = lensGauge && { ...lensGauge, mode: steady?.shown ?? lensGauge.mode };
  // Tell the rest of the UI (modeline, squirrel) what the score line says.
  const live = line?.mode ?? null;
  useEffect(() => {
    dispatch({ type: 'composer', lens: live, nudge: false });
  }, [live, dispatch]);

  // Usage log: the line's number each time the word filter changes it (once per change, not per render).
  const fromFilter = line && (line.from === 'filter' || line.from === 'adjusted') ? { percent: pct(line.you), mode: line.mode, from: line.from, unsure: Boolean(line.unsure) } : null;
  const filtered = fromFilter && `${fromFilter.percent} ${fromFilter.mode} ${fromFilter.from} ${fromFilter.unsure}`;
  useEffect(() => {
    if (fromFilter) track({ type: 'filter_rated', payload: { ...fromFilter, words: wordCount(words.step), chars: words.step.length } });
  }, [filtered]);

  const run = (cmd: Cmd, a: string) => {
    setText('');
    draftLog.command();
    track({ type: 'command', payload: { name: cmd.name, arg: cmd.args && !UNLOGGED_ARGS.has(cmd.name) ? cut(a) : null } });
    cmd.run(a);
  };

  const submit = () => {
    if (isCmd) {
      const cmd = menu[Math.min(sel, menu.length - 1)];
      if (!cmd) return;
      if (!rest.length && cmd.args && !cmd.args.startsWith('[')) return setText(`/${cmd.name} `);
      return run(cmd, arg);
    }
    if (busy || !text.trim()) return;
    const c = classifyDraft(text);
    // The model's rating of exactly this text decides the veil and goes with the message; else the
    // line's steady label with the whole draft rated by the word filter (live), or the rules; the turn asks the model.
    const whole = { gauge: draftGauge(c, model, words.whole(text)), steady, newWord: words.step.trimEnd() !== text.trim() };
    const id = send(text, c, { veil: arborOn && willVeil(sendMode(c, model, whole)), thinking: model.rated ?? undefined });
    draftLog.sent(text, id ?? null);
    setText('');
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    draftLog.key(e.key);
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    } else if (menu.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      setSel((s) => (s + (e.key === 'ArrowDown' ? 1 : menu.length - 1)) % menu.length);
    } else if (e.key === 'Tab' && !e.altKey && !e.metaKey && !e.ctrlKey) {
      // Tab completes a command, or cycles through demo prompts while the prompt is empty or holds one.
      if (menu.length) {
        e.preventDefault();
        setText(`/${menu[Math.min(sel, menu.length - 1)].name} `);
        return;
      }
      const i = demoPrompts.indexOf(text);
      if (demoPrompts.length && (!text || i >= 0)) {
        e.preventDefault();
        const n = demoPrompts.length;
        const j = i < 0 ? (e.shiftKey ? n - 1 : 0) : (i + (e.shiftKey ? n - 1 : 1)) % n;
        setText(demoPrompts[j]);
      }
    } else if (e.key === 'Escape') {
      if (busy) stop();
      else if (text) setText('');
      else e.currentTarget.blur();
    }
  };

  const c = lint && lens && lens.text === text ? lens.c : null;
  const g = c && line;

  /** The word's reason pops up: logged once the pointer rested on it (usage log). */
  const showTip = (t: { i: number; x: number; y: number } | null) => {
    setTip(t);
    const ev = t && c?.evidence?.[t.i];
    restOn('word', ev ? `${t.i}:${ev.start}` : null, ev ? () => track({ type: 'hint_hover', payload: { which: 'word', mode: ev.mode, word: text.slice(ev.start, ev.end), reason: ev.reason } }) : undefined);
  };
  /** The textarea lies over the underlines, so find the underlined word under the mouse by its boxes. */
  const onHover = (e: MouseEvent<HTMLTextAreaElement>) => {
    const box = composerRef.current?.getBoundingClientRect();
    if (!c || !box) return tip && showTip(null);
    for (const el of backdropRef.current?.querySelectorAll<HTMLElement>('.a-ev[data-i]') ?? []) {
      for (const r of el.getClientRects()) {
        if (e.clientX >= r.left - 1 && e.clientX <= r.right + 1 && e.clientY >= r.top - 2 && e.clientY <= r.bottom + 4) {
          const i = Number(el.dataset.i);
          if (tip?.i !== i) showTip({ i, x: Math.max(0, Math.min(r.left - box.left, box.width - 340)), y: r.top - box.top });
          return;
        }
      }
    }
    if (tip) showTip(null);
  };
  const tipEvidence: Evidence | undefined = c && tip ? c.evidence?.[tip.i] : undefined;
  const next = demoPrompts.length ? demoPrompts[(demoPrompts.indexOf(text) + 1) % demoPrompts.length] : null;

  return (
    <div className="a-composer" ref={composerRef}>
      {isCmd && (
        <ul className="a-menu" role="listbox" aria-label="Commands">
          {menu.length ? (
            menu.map((cmd, i) => (
              <li
                key={cmd.name}
                role="option"
                aria-selected={i === sel}
                className={i === sel ? 'on' : ''}
                onMouseEnter={() => setSel(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  if (cmd.args && !cmd.args.startsWith('[')) setText(`/${cmd.name} `);
                  else run(cmd, '');
                  focusPrompt();
                }}
              >
                <span className="a-menu-name">/{cmd.name}</span>
                <span className="a-menu-args">{cmd.args ?? ''}</span>
                <span className="a-menu-desc">{cmd.desc}</span>
              </li>
            ))
          ) : (
            <li className="a-dim">no command “/{word}”. try /concepts</li>
          )}
        </ul>
      )}

      <div className="a-gauge-row">
        {c && g ? (
          <Gauge c={c} g={g} from={source(g, model, c, words)} text={text} after={willVeil(g.mode) ? 'the answer arrives veiled, so you can guess first' : AFTER[g.mode]} />
        ) : !text && !busy && next ? (
          // A quiet hint, only visible while the prompt has focus (tab only works there), so it is
          // never mistaken for the prompt itself. Clicking keeps the focus in the prompt.
          <p className="a-try">
            <K>tab</K>
            <span className="a-try-label">demo prompt:</span>
            <button
              className="a-try-fill"
              tabIndex={-1}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setText(next);
                focusPrompt();
              }}
            >
              {lower(next)}
            </button>
          </p>
        ) : null}
      </div>

      {/* The whole box is the prompt: a click on its padding or the › lands in the text. */}
      <div
        className={`a-prompt${g ? ` m-${g.mode}` : ''}`}
        onMouseDown={(e) => {
          if (e.target instanceof HTMLTextAreaElement) return;
          e.preventDefault();
          focusPrompt();
        }}
      >
        <span className="a-ps1" aria-hidden="true">
          ›
        </span>
        <div className="a-field">
          <div className="a-backdrop" aria-hidden="true" ref={backdropRef}>
            {c ? <Marked text={text} evidence={c.evidence ?? []} hot={tipEvidence ? tip!.i : null} /> : text}
            {'​'}
          </div>
          <textarea
            id="a-prompt"
            value={text}
            rows={1}
            spellCheck={false}
            autoComplete="off"
            placeholder={state.session.pendingQuiz ? 'type your answer here…' : 'type your message here…'}
            aria-label="Message"
            aria-describedby="a-lint"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            onPaste={(e) => draftLog.paste(e.clipboardData.getData('text'))}
            onMouseMove={onHover}
            onMouseLeave={() => showTip(null)}
          />
        </div>
      </div>

      {tipEvidence && (
        <div className={`a-evtip m-${tipEvidence.mode}`} style={{ left: tip!.x, top: tip!.y }} role="tooltip">
          <span className="a-evtip-word">
            <G mode={tipEvidence.mode} /> “{lower(text.slice(tipEvidence.start, tipEvidence.end))}”
          </span>{' '}
          {shortReason(tipEvidence.reason)}
        </div>
      )}

      {/* For screen readers: what the linter says, without a visible block that moves the page. */}
      <p id="a-lint" className="a-sr" aria-live="polite">
        {c && g ? `${MODE_META[g.mode].lens}, ${source(g, model, c, words)}. ${c.reasons.join('. ')}` : ''}
      </p>
    </div>
  );
}

/** Where the line's number comes from, in plain words. "% sure" belongs to the word rules only. */
function source(g: DraftGauge, model: DraftView, c: Classification, words: { learned: number; failed: boolean }) {
  const learned = words.learned ? ` · learned from ${words.learned} of your messages` : '';
  const off = model.unavailable ? ' · the model rating is not available' : '';
  if (g.from === 'model') return 'rated by the fast model';
  if (g.from === 'adjusted') return `the fast model's rating, adjusted for the words since${learned}`;
  if (g.from === 'filter') return `estimated from your words (instant)${g.unsure ? ' · unsure' : ''}${off}${learned}`;
  if (g.from === 'earlier') return 'rated by the fast model, on your earlier words';
  const sure = `${pct(c.confidence)}% sure${words.failed ? ' · the word filter could not load' : ''}`;
  if (!model.canRate) return sure;
  return `${sure} · from the word rules, ${model.unavailable ? 'the model rating is not available' : 'the model has not answered'}`;
}

/**
 * The live score: the label, a bar from you to ai, the split, and what sending will do. In live
 * mode the word filter sets them at every finished word (dimmed while it is unsure), and the fast
 * model's rating once it has answered (moved by the filter for the words since); without the
 * filter the model's earlier rating stays dimmed, and the word rules decide until it has answered.
 * Hovering it lists every reason the linter found.
 */
function Gauge({ c, g, from, text, after }: { c: Classification; g: DraftGauge; from: string; text: string; after: string }) {
  const { track } = useStore();
  const { restOn } = useUi();
  const you = pct(g.you);
  return (
    <div
      className={`a-gauge m-${g.mode}${g.from === 'earlier' || g.unsure ? ' stale' : ''}`}
      tabIndex={0}
      aria-describedby="a-lint"
      onMouseEnter={() => restOn('line', 'line', () => track({ type: 'hint_hover', payload: { which: 'line', mode: g.mode, percent: you, from: g.from } }))}
      onMouseLeave={() => restOn('line', null)}
    >
      <G mode={g.mode} /> <strong>{lower(MODE_META[g.mode].lens)}</strong>
      <span className="a-gauge-bar" aria-hidden="true">
        <span style={{ width: `${you}%` }} />
      </span>
      <span className="a-dim">
        you {you} · ai {100 - you}
      </span>
      <span className="a-gauge-after a-dim">
        <K>↵</K> {after}
      </span>
      <div className="a-gauge-pop" role="tooltip">
        <p className="a-verdict-head">
          <G mode={g.mode} /> <strong>{lower(MODE_META[g.mode].lens)}</strong>
          <span className="a-dim"> · {from}</span>
        </p>
        {g.from !== 'rules' && (
          <p className="a-dim">
            underlined by the word rules: {lower(MODE_META[c.mode].lens)}, {pct(c.confidence)}% sure
          </p>
        )}
        <Diagnostics text={text} c={c} onHot={() => {}} />
      </div>
    </div>
  );
}

/* ───────────── Commands ───────────── */

interface Cmd {
  name: string;
  /** "[x]" optional, "<x>" or "a|b" required. */
  args?: string;
  desc: string;
  run: (arg: string) => void;
}

const TIMES = Object.fromEntries(TIME_TICKS.map((t) => [t.label, t.days]));

const PROVIDER_TOAST: Record<ProviderChoice, string> = {
  scripted: 'scripted demo · nothing saved',
  arbor: 'live claude · your saved chats',
  own: 'your own model · your saved chats · /model to set it up',
};

function useCommands(): Cmd[] {
  const { state, dispatch, send, stop, retry, busy, toast, messages, mode, newChat, renameChat, sync, filter } = useStore();
  const ui = useUi();
  const account = useAccount();
  return useMemo(() => {
    const s = state.settings;
    const set = (patch: Partial<typeof s>) => dispatch({ type: 'settings', patch });
    const pick = <T extends string>(a: string, allowed: readonly T[], apply: (v: T) => void, what: string) => {
      const v = a.toLowerCase() as T;
      if (allowed.includes(v)) apply(v);
      else toast(`/${what} takes ${allowed.join(' | ')}`);
    };
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    return [
      { name: 'quiz', args: '[topic]', desc: 'quiz me (retrieval practice)', run: (a) => send(a ? `Quiz me on ${a}` : 'Quiz me') },
      {
        name: 'hint',
        args: '<question>',
        desc: 'a hint, not the answer',
        run: (a) => send(`Give me a hint, not the full answer: ${a}`),
      },
      { name: 'stop', desc: busy ? 'stop the reply (or esc)' : 'stop a reply while it streams', run: () => (busy ? stop() : toast('nothing to stop')) },
      {
        name: 'retry',
        desc: 'run the failed reply again',
        run: () => (state.session.turn.status === 'error' ? retry() : toast('nothing failed')),
      },
      { name: 'chats', desc: 'all your chats, by day (or c)', run: () => dispatch({ type: 'chats', open: true }) },
      { name: 'new', desc: 'start a new chat', run: newChat },
      { name: 'title', args: '<name>', desc: 'rename this chat', run: renameChat },
      { name: 'forest', desc: 'zoom out to all your chats', run: () => dispatch({ type: 'forest', open: true }) },
      {
        name: 'outline',
        desc: 'show the tree as an outline, or back',
        run: () => ui.setView(ui.view === 'tree' ? 'outline' : 'tree', 'command'),
      },
      {
        name: 'time',
        args: 'now|1d|1w|1m|3m',
        desc: 'what fades if you stop reviewing',
        run: (a) => (a.toLowerCase() in TIMES ? ui.setDays(TIMES[a.toLowerCase()]) : toast('/time takes now | 1d | 1w | 1m | 3m')),
      },
      {
        name: 'why',
        desc: 'why your last prompt got its label',
        run: () => {
          if (!lastUser) return;
          ui.setWhy(lastUser.id);
          dispatch({ type: 'flash', id: lastUser.id });
        },
      },
      {
        name: 'nudge',
        args: 'off|gentle|active',
        desc: 'how much arbor steps in',
        run: (a) => pick<NudgeLevel>(a, ['off', 'gentle', 'active'], (v) => (set({ nudge: v }), toast(`nudges: ${v}`)), 'nudge'),
      },
      { name: 'theme', args: 'system|light|dark', desc: 'colour theme', run: (a) => pick<Theme>(a, ['system', 'light', 'dark'], (v) => set({ theme: v }), 'theme') },
      {
        name: 'provider',
        args: 'scripted|arbor|own',
        desc: 'where answers come from (arbor: live claude, own: your model)',
        run: (a) => pick(a, ['scripted', 'arbor', 'own'] as const, (v) => (set({ provider: v }), toast(`answers: ${PROVIDER_TOAST[v]}`)), 'provider'),
      },
      { name: 'model', desc: 'set up your own model: endpoint, key, test', run: () => ui.setSheet('model') },
      // Live mode: what the word filter learned from your messages stays in this browser.
      ...(filter
        ? [
            {
              name: 'filter',
              args: 'reset',
              desc: 'forget what the word filter learned from your messages',
              run: (a: string) => (a.toLowerCase() === 'reset' ? (filter.reset(), toast('the word filter forgot what it learned from you')) : toast('/filter takes reset')),
            },
          ]
        : []),
      {
        name: 'design',
        args: 'ascii|classic',
        desc: 'switch the design style',
        run: (a) => pick(a, ['ascii', 'classic'] as const, (v) => set({ design: v }), 'design'),
      },
      { name: 'squirrel', desc: s.mascot ? 'hide the squirrel' : 'show the squirrel', run: () => set({ mascot: !s.mascot }) },
      s.enabled
        ? { name: 'pause', desc: 'pause arbor: the plain chat, nothing labelled', run: () => set({ enabled: false }) }
        : { name: 'resume', desc: 'resume arbor', run: () => set({ enabled: true }) },
      // Accounts are a live-mode thing: the demo saves nothing.
      ...(mode === 'demo'
        ? []
        : account.account?.kind === 'account'
          ? [
              {
                name: 'logout',
                desc: `log out of ${account.account.username} on this browser`,
                run: () => (sync.pending ? toast('a moment: your last changes are still being saved') : account.logOut()),
              },
            ]
          : [
              { name: 'signup', desc: 'make an account from this guest: your chats come along', run: () => account.open('signup') },
              { name: 'login', desc: 'log in to an account (this browser switches to it)', run: () => account.open('login') },
            ]),
      // The demo's own resets; live chats are saved, so there /new starts afresh.
      ...(mode === 'demo'
        ? [
            {
              name: 'reset',
              desc: 'restart the demo conversation',
              run: () => (dispatch({ type: 'reset', empty: false }), ui.setDays(0), toast('demo reset')),
            },
            {
              name: 'empty',
              desc: 'start the demo from an empty chat',
              run: () => (dispatch({ type: 'reset', empty: true }), ui.setDays(0), toast('empty chat: watch the tree grow from a seed')),
            },
          ]
        : []),
      { name: 'concepts', desc: 'the interaction ideas in this design', run: () => ui.setSheet('concepts') },
      { name: 'intro', desc: 'replay the introduction', run: () => dispatch({ type: 'onboarding', open: true }) },
    ] satisfies Cmd[];
  }, [state.settings, state.session.turn.status, messages, busy, dispatch, send, stop, retry, toast, ui, mode, newChat, renameChat, account, sync.pending, filter]);
}
