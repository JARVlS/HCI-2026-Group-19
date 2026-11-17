import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { MODE_META, pct } from '../../lib/modes';
import { useStore } from '../../lib/store';
import type { Classification, Mode, NudgeLevel, ProviderChoice, Theme } from '../../lib/types';
import { TIME_TICKS } from '../../lib/retention';
import { Diagnostics, Marked } from './Transcript';
import { G, K, lower, useUi } from './ui';

/* The prompt: a thought linter while you type, and a command line when you start with "/". */

/** What sending will do, in the words of the tree (feedforward). */
const AFTER: Record<Mode, string> = {
  own: 'its leaf grows in filled',
  together: 'its leaf grows half yours',
  ai: 'totally fine, just good to know',
};

export function Composer() {
  const { state, dispatch, send, stop, classifyDraft, busy, demoPrompts } = useStore();
  const { focusPrompt } = useUi();
  const { enabled: arborOn, nudge } = state.settings;
  const lint = arborOn && nudge !== 'off';
  /** Predict → reveal: a delegating prompt's answer arrives veiled (no keyword match: the linter decides). */
  const willVeil = (mode: Mode) => mode === 'ai' && nudge === 'active' && !state.session.pendingQuiz;
  const [text, setText] = useState('');
  const [lens, setLens] = useState<{ text: string; c: Classification } | null>(null);
  const [hot, setHot] = useState<number | null>(null);
  const [sel, setSel] = useState(0);
  const commands = useCommands();

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

  // Tell the rest of the UI (modeline, squirrel) what the lens says.
  const live = lint && lens ? lens.c.mode : null;
  useEffect(() => {
    dispatch({ type: 'composer', lens: live, nudge: false });
  }, [live, dispatch]);

  const run = (cmd: Cmd, a: string) => {
    setText('');
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
    send(text, c, { veil: arborOn && willVeil(c.mode) });
    setText('');
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
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
  const next = demoPrompts.length ? demoPrompts[(demoPrompts.indexOf(text) + 1) % demoPrompts.length] : null;

  return (
    <div className="a-composer">
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

      <div className={`a-prompt${c ? ` m-${c.mode}` : ''}`}>
        <span className="a-ps1" aria-hidden="true">
          ›
        </span>
        <div className="a-field">
          <div className="a-backdrop" aria-hidden="true">
            {c ? <Marked text={text} evidence={c.evidence ?? []} hot={hot} /> : text}
            {'​'}
          </div>
          <textarea
            id="a-prompt"
            value={text}
            rows={1}
            spellCheck={false}
            autoComplete="off"
            placeholder={state.session.pendingQuiz ? 'type your answer…' : 'message the assistant…'}
            aria-label="Message"
            aria-describedby="a-lint"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
          />
        </div>
      </div>

      <div id="a-lint" className="a-lint" aria-live="polite">
        {c ? (
          <div className={`a-verdict m-${c.mode}`} key={c.mode}>
            <p className="a-verdict-head">
              <G mode={c.mode} /> <strong>{lower(MODE_META[c.mode].lens)}</strong>
              <span className="a-dim"> · {pct(c.confidence)}% sure</span>
            </p>
            <Diagnostics text={text} c={c} onHot={setHot} />
            <p className="a-after">
              <K>↵</K>{' '}
              {willVeil(c.mode)
                ? 'sends · the answer arrives veiled, so you can guess first'
                : `sends · ${AFTER[c.mode]}`}
            </p>
          </div>
        ) : !text && !busy && next ? (
          <p className="a-try">
            <K>tab</K>{' '}
            <button className="a-try-btn" onClick={() => setText(next)}>
              {lower(next)}
            </button>
          </p>
        ) : null}
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
  const { state, dispatch, send, stop, retry, busy, toast, messages, mode, newChat, renameChat } = useStore();
  const ui = useUi();
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
        run: () => ui.setView(ui.view === 'tree' ? 'outline' : 'tree'),
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
  }, [state.settings, state.session.turn.status, messages, busy, dispatch, send, stop, retry, toast, ui, mode, newChat, renameChat]);
}
