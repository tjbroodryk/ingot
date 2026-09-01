import { type ReactNode, useState } from 'react';
import { type Credentials, INGOT_URL, IngotError, fetchAccount } from './ingot-api';

/**
 * The gate: an account slug and a key.
 *
 * Both, because the API has no "who am I" route — a key authenticates, and the
 * account it may reach is the `:account` in the path. Asking for the slug is
 * the honest version of that; guessing it would only work for accounts with
 * one key ever minted.
 *
 * The form does not accept a key on the caller's word. It calls
 * `GET /accounts/:account`, which is the cheapest route that exercises both
 * guards, so "signed in" means the key authenticated *and* was for this
 * account. A gate that only stores what you typed would send you to a
 * dashboard that 401s on its first query, which is a worse place to find out.
 */
export function SignIn({ onSignedIn }: { onSignedIn: (credentials: Credentials) => void }): ReactNode {
  const [account, setAccount] = useState('');
  const [key, setKey] = useState('');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    if (checking) return;

    const credentials: Credentials = { account: account.trim(), key: key.trim() };
    setChecking(true);
    setError(null);

    try {
      await fetchAccount(credentials);
      onSignedIn(credentials);
    } catch (cause) {
      setError(
        cause instanceof IngotError
          ? cause.message
          : 'Something went wrong checking that key.',
      );
      setChecking(false);
    }
  }

  return (
    <section className="gate">
      <div className="gate-card">
        <span className="label label-sm kicker">[ Sign in ]</span>
        <h2 className="gate-title">
          Your <span className="mark">key</span> is the session
        </h2>
        <p className="prose">
          Ingot holds no session of its own — a bearer key authenticates every request. Paste one
          here and it is kept for this tab only.
        </p>

        <form
          className="gate-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label className="field">
            <span>Account slug</span>
            <input
              className="input"
              value={account}
              onChange={(event) => setAccount(event.target.value)}
              placeholder="acme"
              autoComplete="username"
              spellCheck={false}
              required
            />
          </label>

          <label className="field">
            <span>API key</span>
            <input
              className="input"
              type="password"
              value={key}
              onChange={(event) => setKey(event.target.value)}
              placeholder="ing_sk_…"
              autoComplete="current-password"
              spellCheck={false}
              required
            />
          </label>

          {error ? <p className="notice notice-bad">{error}</p> : null}

          <button className="btn-solid gate-submit" type="submit" disabled={checking}>
            {checking ? 'Checking…' : 'Open the dashboard'}
          </button>
        </form>

        <p className="gate-foot label label-sm">
          <span className="muted">Talking to</span> <code>{INGOT_URL}</code>
        </p>
      </div>
    </section>
  );
}
