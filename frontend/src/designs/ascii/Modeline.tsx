import { useEffect, useState, type ReactNode } from 'react';
import { mean, pct } from '../../lib/modes';
import { thinkingShare } from '../../lib/scores';
import { formatDays } from '../../lib/retention';
import { useStore } from '../../lib/store';
import { K, useUi } from './ui';

/**
 * The modeline: like vim's "-- INSERT --", it always says who is thinking right now, in the
 * periphery, and lists the keys that work in this moment (recognition over recall).
 */
export function Modeline() {
  const { state, messages, busy, mode } = useStore();
  const { days, view, sheet, refs } = useUi();
  const { settings } = state;
  const { composer, forest } = state.ui;
  const [focus, setFocus] = useState<'prompt' | 'guess' | 'tree' | 'other'>('other');

  useEffect(() => {
    const read = () => {
      const el = document.activeElement as HTMLElement | null;
      setFocus(
        el?.id === 'a-prompt' ? 'prompt' : el?.classList.contains('a-guess-input') ? 'guess' : el?.closest('.at-grid') ? 'tree' : 'other',
      );
    };
    const later = () => setTimeout(read, 0);
    document.addEventListener('focusin', read);
    document.addEventListener('focusout', later);
    read();
    return () => {
      document.removeEventListener('focusin', read);
      document.removeEventListener('focusout', later);
    };
  }, []);

  const veiled = messages.some((m) => m.veiled);
  const turns = messages.filter((m) => m.role === 'user' && m.classification);
  const you = turns.length ? pct(mean(turns.map(thinkingShare))) : null;

  let badge: { cls: string; text: string };
  if (!settings.enabled) badge = { cls: 'idle', text: 'paused' };
  else if (state.ui.chats) badge = { cls: 'idle', text: 'chats' };
  else if (forest.open) badge = { cls: 'idle', text: 'forest' };
  else if (veiled) badge = { cls: 'veil', text: '▒ veiled' };
  else if (busy) badge = { cls: 'idle', text: 'ai writing' };
  else if (state.session.turn.status === 'error') badge = { cls: 'idle', text: '! failed' };
  else if (composer.lens === 'own') badge = { cls: 'own', text: '● your thinking' };
  else if (composer.lens === 'together') badge = { cls: 'together', text: '◑ together' };
  else if (composer.lens === 'ai') badge = { cls: 'ai', text: '○ delegating' };
  else badge = { cls: 'idle', text: 'arbor' };

  let keys: ReactNode;
  if (state.ui.chats) keys = <><K>↑↓</K> move · <K>↵</K> open · <K>n</K> new chat · <K>esc</K> close</>;
  else if (refs) keys = <><K>↑↓</K> move · <K>↵</K> open that chat at the message · <K>esc</K> close</>;
  else if (sheet) keys = <><K>esc</K> close</>;
  else if (busy && !forest.open) keys = <><K>esc</K> stop</>;
  else if (state.session.turn.status === 'error' && focus !== 'prompt') keys = <><K>r</K> retry · <K>i</K> type</>;
  else if (forest.open) keys = <><K>esc</K> back · <K>[ ]</K> time</>;
  else if (focus === 'guess') keys = <><K>↵</K> reveal · type a guess first, or don’t</>;
  else if (focus === 'prompt')
    keys = (
      <>
        <K>↵</K> send · <K>⇧↵</K> newline · <K>/</K> commands · <K>tab</K> demo prompts · <K>esc</K> leave
      </>
    );
  else if (focus === 'tree')
    keys = (
      <>
        <K>↑↓</K> move · <K>↵</K> jump to its message (or pick one) · <K>q</K> quiz me
      </>
    );
  else
    keys = (
      <>
        <K>i</K> type · <K>/</K> commands
      </>
    );

  return (
    <footer className="a-modeline" aria-label="Status">
      <span className={`a-badge b-${badge.cls}`} aria-live="polite">
        {` ${badge.text} `}
      </span>
      <span className="a-ml-keys">{keys}</span>
      <span className="a-ml-right">
        {days > 0 && <span className="a-ml-time">time {formatDays(days)}</span>}
        {mode === 'live' && <SyncState />}
        {settings.enabled && you !== null && <span>you {you}%</span>}
        <span className="a-ml-global">
          <K>t</K> {view === 'tree' ? 'outline' : 'tree'} <K>f</K> forest <K>c</K> chats <K>[ ]</K> time <K>?</K> concepts
        </span>
      </span>
    </footer>
  );
}

/** Live mode: whether everything is saved. Quiet when it is; says how many changes wait, and why. */
function SyncState() {
  const { sync } = useStore();
  if (sync.rejected) {
    return (
      <span className="a-ml-sync is-bad" title={sync.error ?? ''}>
        ! {sync.rejected} not saved
      </span>
    );
  }
  if (sync.offline) return <span className="a-ml-sync is-bad" title={sync.error ?? ''}>offline · {sync.pending} unsaved</span>;
  if (sync.pending) return <span className="a-ml-sync" title={sync.error ?? ''}>saving…</span>;
  return <span className="a-ml-sync">saved</span>;
}
