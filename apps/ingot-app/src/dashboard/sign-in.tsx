import { type ReactNode, useState } from 'react';
import { type Credentials, INGOT_HOST, INGOT_URL, IngotError, fetchAccount } from './ingot-api';

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
 *
 * The right-hand half answers the question somebody arriving here without a
 * key has, which is where one comes from. It is the two ways there are, with
 * what they typed in the slug box filled into both.
 */

interface Refusal {
  readonly status: number;
  readonly message: string;
}

export function SignIn({ onSignedIn }: { onSignedIn: (credentials: Credentials) => void }): ReactNode {
  const [account, setAccount] = useState('');
  const [key, setKey] = useState('');
  const [checking, setChecking] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);

  const slug = account.trim();

  async function submit(): Promise<void> {
    if (checking) return;

    const credentials: Credentials = { account: slug, key: key.trim() };
    setChecking(true);
    setRefusal(null);

    try {
      await fetchAccount(credentials);
      onSignedIn(credentials);
    } catch (cause) {
      setRefusal(
        cause instanceof IngotError
          ? { status: cause.status, message: cause.message }
          : { status: 0, message: 'Something went wrong checking that key.' },
      );
      setChecking(false);
    }
  }

  return (
    <div className="gate">
      <section className="gate-main">
        <div className="bhead">
          <span>[ Sign in ]</span>
          <span>
            talking to <code className="bhead-id">{INGOT_HOST}</code>
          </span>
        </div>

        <h1 className="gate-title">
          Your <span className="mark">key</span>
          <br />
          is the session
        </h1>
        <p className="gate-lead">
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
          <label className="wb-field">
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

          <label className="wb-field">
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

          {refusal ? (
            <div className="log log-quiet" role="alert">
              <div className="log-h">
                <span className="verdict verdict-fail">Refused</span>
                <span className="log-n">GET /api/v1/accounts/{slug}</span>
                {refusal.status ? <span className="log-t">{refusal.status}</span> : null}
              </div>
              <p className="log-r gate-why">→ {explain(refusal, slug)}</p>
            </div>
          ) : null}

          <button className="btn-solid gate-submit" type="submit" disabled={checking}>
            {checking ? 'Checking…' : 'Open the dashboard'}
          </button>
        </form>

        <p className="gate-note">
          The key lives in this tab&rsquo;s sessionStorage and dies with it. A 401 or a 403 anywhere
          brings you back here.
        </p>
      </section>

      <section className="gate-side">
        <div className="bhead">
          <span>[ Where a key comes from ]</span>
          <span>2 ways</span>
        </div>

        <div className="gate-way gate-way-first">
          <div className="gate-way-n">01 · Sealed mode</div>
          <p>
            The deployment opens one account at boot. The slug and the key are the server&rsquo;s own
            settings.
          </p>
          <pre className="code code-ink">
            {`INGOT_AUTH=sealed\nINGOT_ACCOUNT=${slug || 'acme'}\nINGOT_API_KEY=ing_sk_…`}
          </pre>
        </div>

        <div className="gate-way">
          <div className="gate-way-n">02 · Mint another</div>
          <p>Any working key on the account can mint a labelled one. The secret comes back exactly once.</p>
          <pre className="code">
            {`curl -X POST ${INGOT_URL}/api/v1/accounts/${slug || 'acme'}/keys \\\n  -H "Authorization: Bearer ing_sk_…" \\\n  -H "Content-Type: application/json" \\\n  -d '{"label":"dashboard"}'`}
          </pre>
        </div>
      </section>
    </div>
  );
}

/**
 * The refusal in words. The two statuses that end a sign-in mean different
 * things and the service's message alone does not say which, so they are
 * named; anything else is the service's own words.
 */
function explain(refusal: Refusal, account: string): string {
  if (refusal.status === 401) return 'the key did not authenticate.';
  if (refusal.status === 403) return `the key authenticated, but it is not a key for ${account}.`;
  return refusal.message;
}
