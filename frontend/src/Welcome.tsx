import { createContext, useContext, useEffect, useRef, useState, type FormEvent } from 'react';
import { accountError, checkCredentials, continueAsGuest, logIn, signUp, type Account } from './lib/account';
import './welcome.css';

/**
 * The welcome screen (ADR-8, amended 17 Nov 2026): log in, sign up, or continue as guest. Shown
 * once on a first visit in live mode, before anything loads, and later as an overlay from the
 * settings or `/login`, `/signup`. Design-independent, so it looks the same in every style.
 */

export type WelcomeMode = 'start' | 'login' | 'signup';

export interface AccountControls {
  account: Account | null;
  /** Open the overlay to log in or sign up. */
  open(mode: 'login' | 'signup'): void;
  logOut(): void;
}

export const AccountContext = createContext<AccountControls>({ account: null, open: () => {}, logOut: () => {} });
export const useAccount = () => useContext(AccountContext);

const TREE = String.raw`    .-~~-.
  .(  ‿   ).
 (   ‿  ‿  )
  '-.\ /.-'
     |||
  ~~~~~~~~~`;

type Storage = Parameters<typeof signUp>[0];

export function Welcome({
  mode,
  storage,
  theme,
  onDone,
  onCancel,
}: {
  mode: WelcomeMode;
  storage: Storage;
  theme: string;
  /** `switched`: the browser now holds another user's token, so its data has to load afresh. */
  onDone: (account: Account, switched: boolean) => void;
  onCancel?: () => void;
}) {
  const [tab, setTab] = useState<'login' | 'signup'>(mode === 'signup' ? 'signup' : 'login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);
  const overlay = mode !== 'start';

  useEffect(() => first.current?.focus(), [tab]);
  useEffect(() => {
    if (!onCancel) return;
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onCancel();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onCancel]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const creds = { username: username.trim(), password };
    const problem = checkCredentials(creds);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      const r = tab === 'signup' ? await signUp(storage, creds) : await logIn(storage, creds);
      onDone(r.account, r.switched);
    } catch (err) {
      setError(accountError(err));
      setBusy(false);
    }
  };

  const pick = (t: 'login' | 'signup') => {
    setTab(t);
    setError(null);
  };

  return (
    <div className={`w-root${overlay ? ' is-overlay' : ''}`} style={{ colorScheme: theme === 'system' ? 'light dark' : theme }} data-theme={theme}>
      <main className="w-card" role={overlay ? 'dialog' : undefined} aria-modal={overlay || undefined} aria-labelledby="w-title">
        {onCancel && (
          <button className="w-close" onClick={onCancel} aria-label="Close">
            esc ×
          </button>
        )}
        <pre className="w-tree" aria-hidden="true">
          {TREE}
        </pre>
        <h1 id="w-title" className="w-title">
          arbor
        </h1>
        <p className="w-tag">a tutor chat that shows who did the thinking.</p>

        <div className="w-tabs" role="tablist" aria-label="Account">
          <button role="tab" aria-selected={tab === 'login'} className={tab === 'login' ? 'on' : ''} onClick={() => pick('login')}>
            log in
          </button>
          <button role="tab" aria-selected={tab === 'signup'} className={tab === 'signup' ? 'on' : ''} onClick={() => pick('signup')}>
            sign up
          </button>
        </div>

        <form className="w-form" onSubmit={submit} noValidate>
          <label className="w-row">
            <span>username</span>
            <input
              ref={first}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="e.g. leon or you@uni.ch"
            />
          </label>
          <label className="w-row">
            <span>password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={tab === 'signup' ? 'new-password' : 'current-password'}
              placeholder={tab === 'signup' ? 'at least 8 characters' : ''}
            />
          </label>
          <p className="w-error" role="alert">
            {error ?? ''}
          </p>
          <button className="w-submit" type="submit" disabled={busy}>
            {busy ? '…' : tab === 'signup' ? 'sign up ↵' : 'log in ↵'}
          </button>
          <p className="w-note">
            {tab === 'signup'
              ? overlay
                ? 'your chats so far move into the new account. no email needed, so nobody can reset a forgotten password.'
                : 'no email needed. we cannot reset a forgotten password, so keep it somewhere.'
              : overlay
                ? 'this browser switches to that account. the chats you made as a guest stay with the guest; sign up instead to keep them.'
                : 'log in to see your chats from another device.'}
          </p>
        </form>

        {!overlay && (
          <div className="w-guest">
            <button className="w-guest-btn" onClick={() => onDone(continueAsGuest(storage), false)}>
              continue as guest →
            </button>
            <p className="w-note">your chats are saved for this browser. sign up any time to keep them.</p>
          </div>
        )}
      </main>
    </div>
  );
}
